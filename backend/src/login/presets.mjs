import { suffixFor } from './policy.mjs';

// Login steps are data. A preset names the hosts a login may touch, where the flow
// starts, how success is recognised and, for password mode, the form selectors.
// Selectors for the HSE Keycloak login form were read from the anonymous login page
// (2026-10-25); the MFA and error selectors follow stock Keycloak and are NOT verified
// live. ЦУ and ЕЛК follow docs/research/cu-hse-auth-endpoints.md and are unverified live.
export const DEFAULT_LOGIN_PATHS = Object.freeze(['/login', '/auth', '/sso', '/oidc', '/signin']);

// Keycloak form of the HSE realm (anonymous login page, 2026-10-25): username, password, submit "login".
const HSE_FORM = Object.freeze({
  username: 'input[name="username"]',
  password: 'input[name="password"]',
  submit: 'input[name="login"], #kc-login, button[type="submit"]',
  error: '#input-error, .kc-feedback-text, .alert-error',
  mfa: Object.freeze({ kind: 'totp', input: 'input[name="otp"], input#otp, input[autocomplete="one-time-code"]', submit: '#kc-login, input[type="submit"], button[type="submit"]', error: '#input-error-otp-code, #input-error, .kc-feedback-text, .alert-error' }),
});

export const LOGIN_PRESETS = Object.freeze({
  'https://edu.hse.ru': Object.freeze({
    id: 'hse', label: 'ВШЭ',
    startUrl: 'https://edu.hse.ru/auth/oidckc/',
    hosts: ['edu.hse.ru', 'saml.hse.ru'],
    // MoodleSession is also issued to anonymous visitors, so success needs M.cfg.userId != 0 on the page.
    success: { cookieNames: ['MoodleSession'], pageProbe: 'moodleUserId' },
    session: { maxAgeHours: 12 },
    calendarExport: { path: '/calendar/export.php' },
    password: HSE_FORM,
  }),
  'https://lk.hse.ru': Object.freeze({
    id: 'hse-elk', label: 'ВШЭ (личный кабинет)',
    startUrl: 'https://lk.hse.ru/',
    hosts: ['lk.hse.ru', 'saml.hse.ru'],
    success: { probe: { path: '/api/get-user', expectStatus: 200 } },
    session: { maxAgeHours: 12 },
    password: HSE_FORM,
  }),
  'https://my.centraluniversity.ru': Object.freeze({
    id: 'cu', label: 'Центральный университет',
    // The gateway keeps the session in HttpOnly cookies (no bearer in JS); success = /learn plus GET /api/account/me -> 200 {sub}.
    startUrl: 'https://my.centraluniversity.ru/learn/courses/view/actual/all',
    hosts: ['my.centraluniversity.ru', 'id.centraluniversity.ru',
      // Captcha providers named by the research (reCAPTCHA in the theme, SmartCaptcha reported); a person solves them in the frame. Unverified.
      'www.google.com', 'www.gstatic.com', 'www.recaptcha.net', 'smartcaptcha.yandexcloud.net', 'captcha-api.yandex.ru', 'yastatic.net'],
    success: { pathPrefixes: ['/learn'], probe: { path: '/api/account/me', expectStatus: 200, jsonHas: ['sub'] } },
    session: { maxAgeHours: 12 },
  }),
});

export function loginPresetFor(origin) {
  const known = LOGIN_PRESETS[origin];
  if (known) return known;
  const host = new URL(origin).hostname;
  // Unknown university: interactive only, the policy is the suffix of its own host.
  return { id: 'generic', label: host, startUrl: `${origin}/`, hosts: [host], suffixes: [suffixFor(host)], success: {}, session: { maxAgeHours: 12 }, generic: true };
}
