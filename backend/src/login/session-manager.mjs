// Login session manager (task A of docs/architecture/auth-sessions-contract.md).
// Sessions live only in this process: a Chromium context cannot be persisted. Credentials
// and MFA codes exist as local variables of one step and are never stored or logged.
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { createBrowserFactory } from './browser.mjs';
import { createHostPolicy } from './policy.mjs';
import { loginPresetFor } from './presets.mjs';
import { captureSession, isSuccess, runPasswordLogin, submitMfaCode } from './flow.mjs';

/**
 * @typedef {import('../../contracts.d.ts').LoginSession} LoginSession
 * @typedef {import('../../contracts.d.ts').LoginStartRequest} LoginStartRequest
 * @typedef {import('../../contracts.d.ts').AuthMethod} AuthMethod
 *
 * @typedef {object} LoginSessionManager
 * @property {() => {interactive:boolean, password:boolean}} capabilities
 * @property {(connection:object) => AuthMethod[]} authMethods
 * @property {(userId:string, connectionId:string, request:LoginStartRequest) => Promise<LoginSession>} start
 * @property {(userId:string, loginId:string) => LoginSession} get
 * @property {(userId:string, loginId:string, code:string) => Promise<LoginSession>} submitMfa
 * @property {(userId:string, loginId:string) => Promise<LoginSession>} handoff
 * @property {(userId:string, loginId:string) => Promise<LoginSession>} done  manual "I am signed in" (interactive fallback)
 * @property {(userId:string, loginId:string) => Promise<LoginSession>} cancel
 * @property {(userId:string, loginId:string) => {ticket:string, expiresAt:string, path:string}} issueTicket
 * @property {(ticket:string, loginId:string) => ({userId:string, loginId:string}|null)} consumeTicket  single use
 * @property {(userId:string, loginId:string, sink:object) => (object|null)} attach  stream viewer: {input(message), detach()}
 * @property {(userId:string, connectionId:string) => (LoginSession|null)} active
 * @property {(connectionId:string) => Promise<void>} cancelForConnection
 * @property {() => Promise<void>} close
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxSessions: 3, startsPerMinute: 5, failureLimit: 3, cooldownMs: 600_000,
  interactiveMs: 600_000, fillingMs: 60_000, mfaMs: 300_000, capturingMs: 20_000, idleMs: 120_000, retainMs: 300_000, ticketMs: 30_000,
  inputPerSecond: 60, frameIntervalMs: 110, maxViolations: 100, maxTickets: 50,
});
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const sha = value => createHash('sha256').update(value).digest('hex');

export function createLoginSessionManager({ store, factory = createBrowserFactory(), limits = {}, now = Date.now, presetFor = loginPresetFor } = {}) {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  const sessions = new Map(); const byUser = new Map(); const starts = new Map(); const failures = new Map(); const tickets = new Map();
  const iso = ms => new Date(ms).toISOString();

  const view = s => ({ id: s.id, connectionId: s.connectionId, mode: s.mode, status: s.status, errorCode: s.errorCode, createdAt: iso(s.createdAt), expiresAt: iso(s.expiresAt),
    idleExpiresAt: s.idleAt ? iso(s.idleAt) : null, viewport: s.handle?.viewport() ?? s.viewport, url: s.handle?.safeUrl() ?? null, mfa: s.mfa ? { ...s.mfa } : null });
  const own = (userId, loginId) => {
    const s = sessions.get(loginId);
    if (!s || s.userId !== String(userId)) throw new AppError('NOT_FOUND', 404);
    return s;
  };
  const push = s => { try { s.viewer?.sink.json({ type: 'status', login: view(s) }); } catch { /* A broken viewer never affects the login. */ } };
  function setStatus(s, status, patch = {}) {
    if (TERMINAL.has(s.status)) return;
    Object.assign(s, { status, errorCode: null, ...patch });
    push(s);
  }
  function arm(s, ms) {
    clearTimeout(s.hardTimer);
    s.expiresAt = now() + ms;
    s.hardTimer = setTimeout(() => void expire(s), ms); s.hardTimer.unref?.();
  }
  function touch(s) {
    clearTimeout(s.idleTimer);
    if (s.status !== 'awaiting_user') { s.idleAt = null; return; }
    s.idleAt = now() + limit.idleMs;
    s.idleTimer = setTimeout(() => void expire(s), limit.idleMs); s.idleTimer.unref?.();
  }
  async function release(s) {
    clearTimeout(s.hardTimer); clearTimeout(s.idleTimer); clearInterval(s.watcher);
    s.credentials = null; s.idleAt = null;
    const handle = s.handle; s.handle = null; s.casting = false;
    try { await handle?.close(); } catch { /* Process already gone. */ }
    s.forget = setTimeout(() => { if (sessions.get(s.id) === s) sessions.delete(s.id); if (byUser.get(s.userId) === s) byUser.delete(s.userId); }, limit.retainMs);
    s.forget.unref?.();
  }
  async function end(s, status, errorCode = null) {
    if (TERMINAL.has(s.status)) return;
    setStatus(s, status, { errorCode, mfa: null });
    try { s.viewer?.sink.close(status); } catch { /* ignore */ }
    s.viewer = null;
    await release(s);
  }
  const expire = s => end(s, 'expired', (s.status === 'awaiting_mfa' || (s.status === 'filling' && s.mfa)) ? 'mfa_expired' : null);
  async function fail(s, code) {
    if (TERMINAL.has(s.status)) return;
    try { store.updateConnection(s.userId, s.connectionId, { status: 'user_action_required', errorCode: code }); } catch { /* Connection removed meanwhile. */ }
    await end(s, 'failed', code);
  }
  function recordFailure(connectionId) {
    const entry = failures.get(connectionId) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= limit.failureLimit) { entry.until = now() + limit.cooldownMs; entry.count = 0; }
    failures.set(connectionId, entry);
  }

  async function finalize(s) {
    if (TERMINAL.has(s.status) || s.status === 'capturing') return;
    clearInterval(s.watcher);
    setStatus(s, 'capturing', { mfa: null }); arm(s, limit.capturingMs); touch(s);
    try {
      const session = await captureSession(s.handle, { preset: s.preset, origin: s.origin, now, keepCalendar: s.keepCalendar });
      if (!session.cookies.length && !session.bearer) throw new AppError('LOGIN_EMPTY_SESSION', 409);
      store.replaceSession(s.userId, s.connectionId, session, { clearData: false });
      store.enqueueJob(s.userId, s.connectionId, { type: 'sync' });
      failures.delete(s.connectionId);
      await end(s, 'succeeded');
    } catch (error) {
      if (error instanceof AppError && error.status === 404) await end(s, 'cancelled'); else await fail(s, 'source_login_unrecognized');
    }
  }
  // Interactive step: poll the page until it looks signed in twice in a row.
  function watch(s) {
    clearInterval(s.watcher); let stable = 0; let busy = false;
    s.watcher = setInterval(async () => {
      if (busy || s.status !== 'awaiting_user' || !s.handle) return;
      busy = true;
      try { stable = await isSuccess(s.handle, s.preset, s.origin) ? stable + 1 : 0; if (stable >= 2) await finalize(s); } catch { stable = 0; } finally { busy = false; }
    }, 1000);
    s.watcher.unref?.();
  }
  function handoff(s, code = null) {
    setStatus(s, 'awaiting_user', { errorCode: code, mfa: null });
    arm(s, limit.interactiveMs); touch(s); watch(s); ensureCast(s);
  }
  async function outcome(s, result) {
    if (TERMINAL.has(s.status)) return;
    if (result.outcome === 'success') return finalize(s);
    if (result.outcome === 'mfa') { setStatus(s, 'awaiting_mfa', { mfa: { kind: result.kind, attemptsLeft: s.attempts } }); arm(s, limit.mfaMs); return; }
    if (result.outcome === 'bad_password') { recordFailure(s.connectionId); return fail(s, 'source_login_failed'); }
    // Captcha or an unknown page: stop filling and give the page to the person.
    if (result.outcome === 'bot') return handoff(s, 'source_bot_protection');
    return handoff(s, 'source_login_unrecognized');
  }
  async function run(s) {
    const policy = createHostPolicy({ hosts: s.preset.hosts, suffixes: s.preset.suffixes });
    s.handle = await factory.open({ policy, viewport: s.viewport });
    if (TERMINAL.has(s.status)) { await release(s); return; }
    ensureCast(s);
    if (s.mode === 'interactive') {
      await s.handle.page.goto(s.preset.startUrl, { timeout: 20_000, waitUntil: 'domcontentloaded' }).catch(() => {});
      setStatus(s, 'awaiting_user'); arm(s, limit.interactiveMs); touch(s); watch(s);
      return;
    }
    const credentials = s.credentials; s.credentials = null;
    const deadline = now() + limit.fillingMs * 0.6;
    await outcome(s, await runPasswordLogin(s.handle, { preset: s.preset, origin: s.origin, credentials, expired: () => now() > deadline }));
  }

  function ensureCast(s) {
    if (!s.handle || !s.viewer || s.casting || TERMINAL.has(s.status)) return;
    s.casting = true;
    let last = 0;
    s.handle.startScreencast(frame => {
      const time = now();
      if (!s.viewer || time - last < limit.frameIntervalMs || s.viewer.sink.buffered > 512 * 1024) return;
      last = time; s.viewer.sink.frame(frame);
    }).catch(() => { s.casting = false; });
  }

  const manager = {
    capabilities() { const available = Boolean(factory.available()); return { interactive: available, password: available }; },
    authMethods(connection) {
      if (!factory.available()) return [];
      const origin = new URL(connection.sourceUrl).origin; const preset = presetFor(origin);
      const methods = [{ id: 'remote_login', type: 'remote_login', label: 'Войти в браузере вуза', fields: [] }];
      if (preset.password) methods.unshift({ id: 'sso_password', type: 'sso_password', label: 'Почта и пароль вуза (SSO)', fields: ['username', 'password'], options: preset.calendarExport ? ['keepCalendar'] : [] });
      return methods;
    },
    async start(userId, connectionId, request) {
      userId = String(userId);
      const connection = store.getConnection(userId, connectionId);
      const origin = new URL(connection.sourceUrl).origin; const preset = presetFor(origin);
      const mode = request?.mode;
      if (!factory.available() || !['interactive', 'password'].includes(mode) || (mode === 'password' && !preset.password)) throw new AppError('LOGIN_UNAVAILABLE', 409);
      if (mode === 'password' && (typeof request.username !== 'string' || !request.username.trim() || request.username.length > 500 || typeof request.password !== 'string' || !request.password || request.password.length > 4000)) throw new AppError('INVALID_INPUT');
      const time = now();
      const recent = (starts.get(userId) ?? []).filter(at => at > time - 60_000);
      if (recent.length >= limit.startsPerMinute) throw new AppError('RATE_LIMITED', 429);
      if ((failures.get(connectionId)?.until ?? 0) > time) throw new AppError('LOGIN_COOLDOWN', 429);
      const previous = byUser.get(userId);
      const active = [...sessions.values()].filter(s => !TERMINAL.has(s.status) && s !== previous).length;
      if (active >= limit.maxSessions) throw new AppError('LOGIN_BUSY', 429);
      recent.push(time); starts.set(userId, recent);
      if (previous && !TERMINAL.has(previous.status)) await end(previous, 'cancelled');
      const s = { id: randomBytes(16).toString('base64url'), userId, connectionId, mode, status: 'starting', errorCode: null, createdAt: time, expiresAt: time + limit.fillingMs,
        idleAt: null, viewport: { width: 390, height: 780 }, mfa: null, handle: null, preset, origin, viewer: null, casting: false, attempts: 3,
        keepCalendar: mode === 'password' && request.keepCalendar === true,
        credentials: mode === 'password' ? { username: request.username.trim(), password: request.password } : null };
      sessions.set(s.id, s); byUser.set(userId, s);
      arm(s, mode === 'interactive' ? limit.interactiveMs : limit.fillingMs);
      void run(s).catch(() => fail(s, 'source_login_unrecognized'));
      return view(s);
    },
    get: (userId, loginId) => view(own(userId, loginId)),
    async submitMfa(userId, loginId, code) {
      const s = own(userId, loginId);
      if (s.status !== 'awaiting_mfa' || s.mode !== 'password') throw new AppError('LOGIN_NOT_WAITING_MFA', 409);
      if (typeof code !== 'string' || !/^[0-9A-Za-z -]{4,12}$/.test(code)) throw new AppError('INVALID_INPUT');
      setStatus(s, 'filling', { mfa: { kind: s.mfa.kind, attemptsLeft: s.attempts } });
      const deadline = now() + limit.fillingMs; arm(s, limit.fillingMs);
      void (async () => {
        const result = await submitMfaCode(s.handle, { preset: s.preset, origin: s.origin, code, expired: () => now() > deadline });
        if (result.outcome === 'mfa_invalid') {
          s.attempts -= 1;
          if (s.attempts <= 0) { recordFailure(s.connectionId); return fail(s, 'mfa_failed'); }
          setStatus(s, 'awaiting_mfa', { mfa: { kind: s.mfa.kind, attemptsLeft: s.attempts } }); arm(s, limit.mfaMs);
          return;
        }
        await outcome(s, result);
      })().catch(() => fail(s, 'source_login_unrecognized'));
      return view(s);
    },
    async handoff(userId, loginId) {
      const s = own(userId, loginId);
      if (s.status === 'awaiting_user') return view(s);
      if (s.status !== 'awaiting_mfa') throw new AppError('LOGIN_NOT_WAITING_MFA', 409);
      handoff(s); return view(s);
    },
    async done(userId, loginId) {
      const s = own(userId, loginId);
      if (s.status !== 'awaiting_user') throw new AppError('LOGIN_NOT_WAITING_MFA', 409);
      if (!(await s.handle.cookies()).length && !s.handle.observed.bearer) throw new AppError('LOGIN_NOT_COMPLETE', 409);
      await finalize(s); return view(s);
    },
    async cancel(userId, loginId) { const s = own(userId, loginId); await end(s, 'cancelled'); return view(s); },
    issueTicket(userId, loginId) {
      const s = own(userId, loginId);
      if (TERMINAL.has(s.status)) throw new AppError('NOT_FOUND', 404);
      const time = now();
      for (const [key, entry] of tickets) if (entry.until <= time) tickets.delete(key);
      if (tickets.size >= limit.maxTickets) throw new AppError('RATE_LIMITED', 429);
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(sha(ticket), { userId: s.userId, loginId, until: time + limit.ticketMs });
      return { ticket, expiresAt: iso(time + limit.ticketMs), path: `/api/v1/login/${loginId}/stream` };
    },
    consumeTicket(ticket, loginId) {
      if (typeof ticket !== 'string' || ticket.length > 100) return null;
      const key = sha(ticket); const entry = tickets.get(key); tickets.delete(key);
      return entry && entry.until > now() && entry.loginId === loginId ? { userId: entry.userId, loginId } : null;
    },
    attach(userId, loginId, sink) {
      const s = own(userId, loginId);
      if (TERMINAL.has(s.status)) return null;
      try { s.viewer?.sink.close('replaced'); } catch { /* ignore */ }
      const viewer = { sink, bucket: limit.inputPerSecond, refill: now(), violations: 0 };
      s.viewer = viewer; s.casting = false;
      const size = s.handle?.viewport() ?? s.viewport;
      sink.json({ type: 'hello', width: size.width, height: size.height }); push(s);
      ensureCast(s); touch(s);
      return {
        async input(message) {
          if (s.viewer !== viewer || s.status !== 'awaiting_user' || !s.handle) return;
          const time = now();
          viewer.bucket = Math.min(limit.inputPerSecond, viewer.bucket + (time - viewer.refill) / 1000 * limit.inputPerSecond); viewer.refill = time;
          const ok = message && typeof message === 'object' && ['mouse', 'key', 'text', 'resize', 'ping'].includes(message.type);
          if (!ok || viewer.bucket < 1) { if (++viewer.violations > limit.maxViolations) { try { sink.close('violations'); } catch { /* ignore */ } } return; }
          viewer.bucket -= 1; touch(s);
          if (message.type === 'ping') return;
          if (message.type === 'resize') { const next = await s.handle.resize(message.width, message.height); sink.json({ type: 'hello', width: next.width, height: next.height }); return; }
          await s.handle.input(message);
        },
        detach() { if (s.viewer === viewer) { s.viewer = null; void s.handle?.stopScreencast().catch(() => {}); s.casting = false; } },
      };
    },
    active(userId, connectionId) {
      const s = byUser.get(String(userId));
      return s && s.connectionId === connectionId && !TERMINAL.has(s.status) ? view(s) : null;
    },
    async cancelForConnection(connectionId) {
      for (const s of [...sessions.values()]) if (s.connectionId === connectionId) await end(s, 'cancelled');
    },
    async close() {
      for (const s of [...sessions.values()]) { await end(s, 'cancelled'); clearTimeout(s.forget); }
      sessions.clear(); byUser.clear(); tickets.clear();
    },
  };
  return /** @type {LoginSessionManager} */ (manager);
}
