import { suffixFor } from './policy.mjs';

// Login steps are data. A preset names the hosts a login may touch, where the flow
// starts, how success is recognised and, for password mode, the form selectors.
// Selectors for the HSE Keycloak login form were read from the anonymous login page
// (2026-10-25); the MFA and error selectors follow stock Keycloak and are NOT verified
// live. ЦУ is provisional until docs/research/cu-hse-auth-endpoints.md lands.
export const DEFAULT_LOGIN_PATHS = Object.freeze(['/login', '/auth', '/sso', '/oidc', '/signin']);

export const LOGIN_PRESETS = Object.freeze({
  'https://edu.hse.ru': Object.freeze({
    id: 'hse', label: 'ВШЭ',
    startUrl: 'https://edu.hse.ru/auth/oidckc/',
    hosts: ['edu.hse.ru', 'saml.hse.ru'],
    success: { cookieNames: ['MoodleSession'] },
    session: { maxAgeHours: 12 },
    calendarExport: { path: '/calendar/export.php' },
    password: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'input[name="login"], #kc-login, button[type="submit"]',
      error: '#input-error, .kc-feedback-text, .alert-error',
      mfa: { kind: 'totp', input: 'input[name="otp"], input#otp, input[autocomplete="one-time-code"]', submit: '#kc-login, input[type="submit"], button[type="submit"]', error: '#input-error-otp-code, #input-error, .kc-feedback-text, .alert-error' },
    },
  }),
  'https://my.centraluniversity.ru': Object.freeze({
    id: 'cu', label: 'Центральный университет',
    startUrl: 'https://my.centraluniversity.ru/',
    hosts: ['my.centraluniversity.ru'],
    suffixes: ['centraluniversity.ru'],
    success: { pathPrefixes: ['/learn'], requireBearer: true },
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
