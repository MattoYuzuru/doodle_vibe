import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors.mjs';

export function validateMasterKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new AppError('INVALID_MASTER_KEY', 500);
}
const aad = ({ userId, spaceId, connectionId }) => Buffer.from(JSON.stringify([String(userId), String(spaceId), String(connectionId)]));
export function encryptSecret(key, context, value) {
  validateMasterKey(key);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  } catch { throw new AppError('SECRET_ENCRYPTION_FAILED', 500); }
}
export function decryptSecret(key, context, envelope) {
  validateMasterKey(key);
  try {
    const { v, iv, tag, data } = JSON.parse(envelope);
    if (v !== 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new AppError('SECRET_UNAVAILABLE', 500); }
}
