import { AppError } from './errors.mjs';

const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('INVALID_AUTH_INPUT');
  return value.trim();
};

// Turns a client auth form into the secret object kept in encrypted storage.
// Exactly one credential form is accepted; anything else is rejected, not merged.
export const AUTH_FIELDS = ['origin', 'token', 'username', 'password', 'service', 'identifier', 'calendarUrl'];
export function buildSecret(body, sourceUrl) {
  const origin = new URL(sourceUrl).origin;
  if (body.origin !== origin) throw new AppError('SECRET_ORIGIN_MISMATCH');
  const present = key => body[key] !== undefined && body[key] !== null && body[key] !== '';
  const forms = [['token'], ['username', 'password', 'service'], ['calendarUrl'], ['identifier']];
  const used = forms.filter(form => form.some(present));
  if (used.length !== 1) throw new AppError('INVALID_AUTH_INPUT');
  if (present('token')) return { origin, token: text(body.token, 16000) };
  if (present('calendarUrl')) {
    let feed;
    try { feed = new URL(text(body.calendarUrl, 2048)); } catch { throw new AppError('INVALID_AUTH_INPUT'); }
    if (feed.protocol !== 'https:' || feed.origin !== origin || feed.username || feed.password || feed.hash) throw new AppError('INVALID_AUTH_INPUT');
    return { origin, calendarUrl: feed.href };
  }
  if (present('identifier')) return { origin, identifier: text(body.identifier, 500) };
  if (!present('username') || !present('password')) throw new AppError('INVALID_AUTH_INPUT');
  const secret = { origin, username: text(body.username, 500) };
  if (typeof body.password !== 'string' || body.password.length > 4000) throw new AppError('INVALID_AUTH_INPUT');
  secret.password = body.password;
  if (present('service')) secret.service = text(body.service, 100);
  return secret;
}
