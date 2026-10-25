import { createHash } from 'node:crypto';
import { DEFAULT_LOGIN_PATHS } from './presets.mjs';

// Page classification and the declarative password/MFA steps. Page text is only tested
// in memory against fixed patterns: it is never stored, logged or returned.
const BOT_TEXT = /captcha|qrator|cloudflare|just a moment|checking your browser|проверка браузера|подтвердите, что вы не робот|доступ ограничен|access denied/i;
const BOT_FRAME = 'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], .g-recaptcha, .h-captcha, #cf-challenge-running, [data-sitekey]';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = async (page, selector) => { try { return await page.locator(selector).first().isVisible(); } catch { return false; } };

export const onLoginPath = pathname => DEFAULT_LOGIN_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`) || pathname.startsWith(`${path}.`));

// Same-origin read-only probes run inside the page, so they use the browser's own session.
async function runProbe(handle, preset) {
  const { pageProbe, probe } = preset.success ?? {};
  const page = handle.page;
  if (pageProbe === 'moodleUserId') {
    const id = await page.evaluate(() => { const value = window.M?.cfg?.userId; return value ? String(value) : null; }).catch(() => null);
    return { ok: Boolean(id && id !== '0'), id };
  }
  if (!probe) return { ok: true };
  const result = await page.evaluate(async path => {
    try { const response = await fetch(path, { credentials: 'include' }); return { status: response.status, json: await response.json().catch(() => null) }; } catch { return { status: 0, json: null }; }
  }, probe.path).catch(() => ({ status: 0, json: null }));
  const json = result.json && typeof result.json === 'object' ? result.json : null;
  const ok = result.status === (probe.expectStatus ?? 200) && (!probe.jsonHas || probe.jsonHas.every(key => json && key in json));
  const id = ['sub', 'id', 'userId'].map(key => json?.[key]).find(value => typeof value === 'string' || typeof value === 'number');
  return { ok, id: id === undefined ? null : String(id) };
}

export async function successDetails(handle, preset, origin) {
  let url; try { url = new URL(handle.page.url()); } catch { return { ok: false }; }
  if (url.origin !== origin || onLoginPath(url.pathname)) return { ok: false };
  const { cookieNames, pathPrefixes, requireBearer } = preset.success ?? {};
  if (pathPrefixes && !pathPrefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return { ok: false };
  if (requireBearer && !handle.observed.bearer) return { ok: false };
  const cookies = await handle.cookies();
  const hasCredential = cookieNames ? cookies.some(cookie => cookieNames.includes(cookie.name)) || Boolean(requireBearer && handle.observed.bearer)
    : cookies.length > 0 || Boolean(handle.observed.bearer);
  if (!hasCredential) return { ok: false };
  return runProbe(handle, preset);
}
export const isSuccess = async (handle, preset, origin) => (await successDetails(handle, preset, origin)).ok;

export async function pageState(handle, preset, origin, { attempted = false } = {}) {
  const page = handle.page;
  if (await isSuccess(handle, preset, origin)) return 'success';
  let text = '';
  try { text = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '')); } catch { /* navigation in flight */ }
  if (BOT_TEXT.test(text) || await page.locator(BOT_FRAME).count().catch(() => 0)) return 'bot';
  const form = preset.password;
  if (!form) return 'unknown';
  if (await visible(page, form.mfa.input)) return 'mfa';
  const hasPassword = await visible(page, form.password);
  if (hasPassword) return attempted && await visible(page, form.error) ? 'bad_password' : 'password';
  if (await visible(page, form.username)) return 'username';
  return 'unknown';
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await sleep(250);
}
async function afterSubmit(page, before, errorSelector) {
  await Promise.race([
    page.waitForURL(url => url.href !== before, { timeout: 8000 }).catch(() => {}),
    page.locator(errorSelector).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}),
  ]);
}
async function submit(page, selector) {
  const button = page.locator(selector).first();
  if (await button.isVisible().catch(() => false)) await button.click({ timeout: 5000 }); else await page.keyboard.press('Enter');
}

// Fills the preset form. `credentials` is read once and the caller drops it afterwards.
export async function runPasswordLogin(handle, { preset, origin, credentials, expired }) {
  const form = preset.password; const page = handle.page;
  await page.goto(preset.startUrl, { timeout: 20_000, waitUntil: 'domcontentloaded' }).catch(() => {});
  let attempted = false; let usernameSent = false;
  for (let step = 0; step < 24; step++) {
    if (expired()) return { outcome: 'timeout' };
    await settle(page);
    const state = await pageState(handle, preset, origin, { attempted });
    if (state === 'success') return { outcome: 'success' };
    if (state === 'bot') return { outcome: 'bot' };
    if (state === 'mfa') return { outcome: 'mfa', kind: form.mfa.kind };
    if (state === 'bad_password') return { outcome: 'bad_password' };
    if (state === 'username' && !usernameSent) {
      usernameSent = true;
      await page.fill(form.username, credentials.username); const before = page.url(); await submit(page, form.submit); await afterSubmit(page, before, form.error);
    } else if (state === 'password' && !attempted) {
      attempted = true;
      if (await visible(page, form.username)) await page.fill(form.username, credentials.username);
      await page.fill(form.password, credentials.password);
      const before = page.url(); await submit(page, form.submit); await afterSubmit(page, before, form.error);
    } else await sleep(600);
  }
  return { outcome: 'unrecognized' };
}

export async function submitMfaCode(handle, { preset, origin, code, expired }) {
  const mfa = preset.password.mfa; const page = handle.page;
  await page.fill(mfa.input, code);
  const before = page.url(); await submit(page, mfa.submit); await afterSubmit(page, before, mfa.error);
  for (let step = 0; step < 16; step++) {
    if (expired()) return { outcome: 'timeout' };
    await settle(page);
    if (await isSuccess(handle, preset, origin)) return { outcome: 'success' };
    if (await visible(page, mfa.input)) { if (await visible(page, mfa.error)) return { outcome: 'mfa_invalid' }; }
    else if (await pageState(handle, preset, origin) === 'bot') return { outcome: 'bot' };
    await sleep(500);
  }
  return { outcome: (await visible(page, mfa.input)) ? 'mfa_invalid' : 'unrecognized' };
}

const jwtExpiry = token => {
  try { const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp; return Number.isFinite(exp) ? exp * 1000 : null; } catch { return null; }
};

async function captureCalendar(handle, origin, preset) {
  const page = handle.page;
  try {
    await page.goto(`${origin}${preset.calendarExport.path}`, { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.selectOption('select[name="events[exportevents]"]', 'all').catch(() => {});
    await page.selectOption('select[name="period[timeperiod]"]', 'recentupcoming').catch(() => {});
    await page.locator('input[name="generateurl"], #id_generateurl').first().click({ timeout: 5000 });
    const field = page.locator('#calendarexporturl, input[name="calendarexporturl"], .calendarurl').first();
    await field.waitFor({ state: 'visible', timeout: 8000 });
    const value = ((await field.inputValue().catch(() => null)) ?? (await field.textContent()) ?? '').trim();
    const url = new URL(value);
    return url.origin === origin && url.pathname.endsWith('/calendar/export_execute.php') && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}

// Builds the StoredSession of docs/architecture/auth-sessions-contract.md section 4.
export async function captureSession(handle, { preset, origin, now = Date.now, keepCalendar = false }) {
  // Let the signed-in page finish its first requests: bearer headers and API responses appear only then.
  await handle.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  const identity = (await successDetails(handle, preset, origin)).id;
  const capturedAt = now();
  const cookies = await handle.cookies();
  let bearer;
  const seen = handle.observed.bearer;
  if (seen) {
    const hit = (await handle.storageEntries()).find(([, , value]) => value === seen.token || value.includes(seen.token));
    const exp = jwtExpiry(seen.token);
    bearer = { token: seen.token, scheme: 'Bearer', source: hit ? hit[0] : 'xhr-header', ...(hit ? { key: hit[1] } : {}), host: seen.host, ...(exp ? { expiresAt: new Date(exp).toISOString() } : {}) };
  }
  const named = preset.success?.cookieNames;
  const bounds = [capturedAt + (preset.session?.maxAgeHours ?? 12) * 3600_000, capturedAt + 30 * 86_400_000];
  for (const cookie of cookies) if (cookie.expires && (named ? named.includes(cookie.name) : cookie.httpOnly)) bounds.push(cookie.expires * 1000);
  if (bearer?.expiresAt) bounds.push(Date.parse(bearer.expiresAt));
  const calendarUrl = keepCalendar && preset.calendarExport ? await captureCalendar(handle, origin, preset) : undefined;
  const identityDigest = identity ? createHash('sha256').update(`${origin}|${identity}`).digest('hex').slice(0, 32) : undefined;
  return { version: 2, capturedAt: new Date(capturedAt).toISOString(), ...(identityDigest ? { identityDigest } : {}), expiresAt: new Date(Math.max(Math.min(...bounds), capturedAt + 60_000)).toISOString(), cookies,
    ...(bearer ? { bearer } : {}), ...(calendarUrl ? { calendarUrl } : {}) };
}
