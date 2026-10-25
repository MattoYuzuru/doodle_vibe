import { AppError } from './errors.mjs';

export function loadConfig(env = process.env) {
  const key = env.DATA_ENCRYPTION_KEY || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) {
    throw new AppError('INVALID_ENCRYPTION_KEY', 500);
  }
  const port = Number(env.PORT || 18110);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('INVALID_PORT', 500);
  let publicBaseUrl = '';
  if (env.PUBLIC_BASE_URL) {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new AppError('INVALID_PUBLIC_URL', 500);
    }
    publicBaseUrl = url.origin;
  }
  return {
    masterKey: Buffer.from(key, 'base64'), dbPath: env.DOODLE_DB_PATH || './platform.sqlite',
    host: env.HOST || '127.0.0.1', port, botToken: env.TELEGRAM_BOT_TOKEN || '',
    publicBaseUrl, version: env.APP_VERSION || 'development',
    deepseekKey: env.DEEPSEEK_API_KEY || '', deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
  };
}
