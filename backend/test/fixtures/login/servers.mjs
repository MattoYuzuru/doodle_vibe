import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Synthetic HTTPS fixture for the login tests: one listener answers for a Keycloak-like
// IdP (saml.hse.ru), a Moodle-like LMS (edu.hse.ru), an SPA that keeps a JWT in
// localStorage (my.centraluniversity.ru) and a hostile host (evil.example). Chromium
// reaches it through the egress proxy `dial` seam; the certificate is generated per run.
export const USER = 'student@hse.test';
export const PASSWORD = 'Fixture-Password-123';
export const OTP = '123456';
export const CALENDAR_TOKEN = 'FIXTUREFEED77';

const page = (title, body, head = '') => `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${title}</title>${head}<body>${body}</body></html>`;
const loginForm = (action, error) => page('Авторизация', `<form id="kc-form-login" method="post" action="${action}">
  <input type="text" id="username" name="username" autofocus><input type="password" name="password">
  ${error ? '<span id="input-error" class="kc-feedback-text">Неверное имя пользователя или пароль</span>' : ''}
  <input name="login" type="submit" value="Войти"></form>`);
const otpForm = (action, error) => page('Код', `<form id="kc-otp-login-form" method="post" action="${action}">
  <input id="otp" name="otp" autocomplete="one-time-code" autofocus>
  ${error ? '<span id="input-error-otp-code" class="kc-feedback-text">Неверный код</span>' : ''}
  <input id="kc-login" type="submit" value="Войти"></form>`);
const jwt = seconds => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.sig`;

export async function startFixture({ mfa = false, bot = false, unknown = false, jwtSeconds = 7200 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doodle-login-fixture-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=fixture'], { stdio: 'ignore' });
  const state = { mfa, bot, unknown, hits: {}, sessions: new Set(), codes: new Map(), otpAttempts: 0, passwordPosts: 0 };
  const body = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString()))); });
  const cookie = req => Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map(part => part.split(/=(.*)/s).slice(0, 2)));
  const send = (res, status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, ...headers }); res.end(); };
  async function handler(req, res) {
    const host = String(req.headers.host).split(':')[0]; const url = new URL(req.url, `https://${host}`);
    state.hits[host] = (state.hits[host] ?? 0) + 1;
    if (host === 'saml.hse.ru') {
      if (state.bot) return send(res, 403, page('Access denied', '<p>Please complete the CAPTCHA</p><div class="g-recaptcha" data-sitekey="x"></div>'));
      if (state.unknown) return send(res, 200, page('Вход', '<p>Нажмите «Продолжить» в приложении</p>'));
      if (url.pathname === '/realms/hse/protocol/openid-connect/auth') return send(res, 200, loginForm('/realms/hse/login-actions/authenticate?session_code=abc'), { 'set-cookie': 'AUTH_SESSION_ID=fixture; Path=/; Secure; HttpOnly' });
      if (url.pathname === '/realms/hse/login-actions/authenticate' && req.method === 'POST') {
        const form = await body(req);
        if (url.searchParams.get('step') === 'otp') {
          if (form.get('otp') !== OTP) { state.otpAttempts++; return send(res, 200, otpForm('/realms/hse/login-actions/authenticate?step=otp', true)); }
        } else {
          state.passwordPosts++;
          if (form.get('username') !== USER || form.get('password') !== PASSWORD) return send(res, 200, loginForm('/realms/hse/login-actions/authenticate?session_code=abc', true));
          if (state.mfa) return send(res, 200, otpForm('/realms/hse/login-actions/authenticate?step=otp'));
        }
        const code = randomBytes(8).toString('hex'); state.codes.set(code, true);
        return redirect(res, `https://edu.hse.ru/auth/oidckc/?code=${code}&state=s`);
      }
      return send(res, 404, page('404', ''));
    }
    if (host === 'edu.hse.ru') {
      if (url.pathname === '/auth/oidckc/') {
        const code = url.searchParams.get('code');
        if (!code) return redirect(res, 'https://saml.hse.ru/realms/hse/protocol/openid-connect/auth?client_id=smart-lms&state=s');
        if (!state.codes.delete(code)) return send(res, 400, page('Ошибка', ''));
        const id = randomBytes(12).toString('hex'); state.sessions.add(id);
        return redirect(res, '/my/', { 'set-cookie': `MoodleSession=${id}; Path=/; Secure; HttpOnly` });
      }
      if (url.pathname === '/login/index.php') return redirect(res, '/auth/oidckc/');
      if (url.pathname === '/redirect-away') return redirect(res, 'https://evil.example/steal');
      const authed = state.sessions.has(cookie(req).MoodleSession);
      if (!authed) return redirect(res, '/login/index.php');
      if (url.pathname === '/my/') return send(res, 200, page('Панель', '<h1>Мои курсы</h1>', '<script>var M = {cfg: {"sesskey":"abc123def4"}};</script>'));
      if (url.pathname === '/calendar/export.php') {
        if (req.method === 'POST') return send(res, 200, page('Экспорт', `<div class="calendarurl">https://edu.hse.ru/calendar/export_execute.php?userid=7&authtoken=${CALENDAR_TOKEN}&preset_what=all&preset_time=recentupcoming</div>`));
        return send(res, 200, page('Экспорт', `<form method="post" action="/calendar/export.php"><select name="events[exportevents]"><option value="all">all</option></select>
          <select name="period[timeperiod]"><option value="recentupcoming">r</option></select><input type="submit" name="generateurl" value="Получить URL календаря"></form>`));
      }
      return send(res, 404, page('404', ''));
    }
    if (host === 'my.centraluniversity.ru') {
      if (url.pathname === '/') return send(res, 200, page('Вход', '<input id="u" autofocus placeholder="login">', `<script>
        document.addEventListener('keydown', e => { if (e.key === 'Enter') { localStorage.setItem('access_token', ${JSON.stringify(jwt(jwtSeconds))}); location.href = '/learn'; } });</script>`));
      if (url.pathname === '/learn') return send(res, 200, page('Обучение', '<h1>Курсы</h1>', `<script>fetch('/api/me', {headers: {Authorization: 'Bearer ' + localStorage.getItem('access_token')}});</script>`), { 'set-cookie': 'sid=fixture; Path=/; Secure; HttpOnly' });
      if (url.pathname === '/api/me') return send(res, 200, '{"id":1}', { 'content-type': 'application/json' });
      return send(res, 404, page('404', ''));
    }
    return send(res, 200, page('Hostile', '<p>should never be reached</p>'));
  }
  const server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => void handler(req, res).catch(() => res.destroy()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, state,
    // Seams for createBrowserFactory: every checked address is replaced by the fixture.
    factoryOptions: { sandbox: !process.env.CI, ignoreHTTPSErrors: true, resolver: async () => [{ address: '93.184.216.34', family: 4 }], dial: () => net.connect(port, '127.0.0.1') },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Minimal WebSocket client for the stream tests: handshake with an Origin header, masked frames out, frames in.
export function connectStream({ port, path, origin, tls = false }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const request = (tls ? https : http).request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...(origin ? { Origin: origin } : {}) }, rejectUnauthorized: false });
    request.on('response', response => resolve({ status: response.statusCode }));
    request.on('upgrade', (_res, socket, head) => {
      const frames = []; let buffer = Buffer.alloc(0); const waiters = [];
      const feed = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let length = buffer[1] & 0x7f; let offset = 2;
          if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; } else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) break;
          const frame = { opcode: buffer[0] & 0x0f, data: Buffer.from(buffer.subarray(offset, offset + length)) };
          buffer = buffer.subarray(offset + length); frames.push(frame);
          for (const waiter of waiters.splice(0)) waiter();
        }
      };
      socket.on('data', feed);
      if (head?.length) feed(head);
      const send = value => {
        const payload = Buffer.from(JSON.stringify(value)); const mask = randomBytes(4);
        const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([header, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]))]));
      };
      resolve({ status: 101, frames, send, socket,
        async waitFor(predicate, ms = 15_000) {
          const until = Date.now() + ms;
          for (;;) {
            const found = frames.find(predicate); if (found) return found;
            if (Date.now() > until) throw new Error('stream wait timeout');
            await new Promise(r => { waiters.push(r); setTimeout(r, 200); });
          }
        },
        close() { socket.destroy(); } });
    });
    request.on('error', reject);
    request.end();
  });
}
