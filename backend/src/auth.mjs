import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

export function verifyTelegramInitData(raw, botToken, { now = Date.now, maxAgeSeconds = 3600 } = {}) {
  const reject = () => { throw new AppError('UNAUTHORIZED', 401); };
  if (typeof raw !== 'string' || !raw || raw.length > 16384 || typeof botToken !== 'string' || !botToken || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) reject();
  try {
    // URLSearchParams tolerates malformed encodings; reject those before canonicalization.
    for (const part of raw.split('&')) {
      const at = part.indexOf('=');
      if (at < 1) reject();
      decodeURIComponent(part.slice(0, at).replaceAll('+', ' '));
      decodeURIComponent(part.slice(at + 1).replaceAll('+', ' '));
    }
    const fields = new URLSearchParams(raw);
    const seen = new Set();
    for (const [key] of fields) { if (seen.has(key) || !key) reject(); seen.add(key); }
    const hash = fields.get('hash');
    if (!/^[a-fA-F0-9]{64}$/.test(hash ?? '')) reject();
    fields.delete('hash');
    const data = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(data).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) reject();
    const authDate = fields.get('auth_date');
    if (!/^\d{1,12}$/.test(authDate ?? '')) reject();
    const age = now() / 1000 - Number(authDate);
    if (!Number.isFinite(age) || age > maxAgeSeconds || age < -30) reject();
    const user = JSON.parse(fields.get('user'));
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) reject();
    const name = [user.first_name, user.last_name].filter(v => typeof v === 'string').join(' ').trim();
    return { id: String(user.id), displayName: name.slice(0, 200) };
  } catch { reject(); }
}
