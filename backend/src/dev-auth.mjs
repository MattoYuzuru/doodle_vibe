// Local development identity without Telegram (docs/architecture/auth-sessions-contract.md, ADR-0005 п. 6).
// Enabled only by DOODLE_DEV_AUTH=1, only for a loopback HOST, never with PUBLIC_BASE_URL or NODE_ENV=production
// (startup fails with a reason on stderr). One synthetic user; a request needs a loopback Host header and, when it
// carries an Origin, a loopback one. It never overrides Telegram init data and has no secret to leak.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SYNTHETIC_USER = Object.freeze({ id: '990000001', displayName: 'Локальный разработчик' });

function refuse(reason) {
  process.stderr.write(`DOODLE_DEV_AUTH refused: ${reason}\n`);
  throw Object.assign(new Error('DEV_AUTH_REFUSED'), { code: 'DEV_AUTH_REFUSED', status: 500 });
}

/** `host:port` or `[::1]:port` -> bare host name. */
function hostName(value) {
  if (typeof value !== 'string' || !value) return null;
  const bracket = value.match(/^(\[[^\]]+\])(?::\d{1,5})?$/);
  if (bracket) return bracket[1];
  const plain = value.match(/^([^:]+)(?::\d{1,5})?$/);
  return plain ? plain[1].toLowerCase() : null;
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.origin === origin && LOOPBACK_HOSTS.has(url.hostname);
  } catch { return false; }
}

/** @returns {null | {identify:(req:import('node:http').IncomingMessage) => ({id:string, displayName:string}|null), allowsOrigin:(origin:string) => boolean}} */
export function createDevAuth(env = process.env) {
  const flag = env.DOODLE_DEV_AUTH;
  if (flag === undefined || flag === '' || flag === '0') return null;
  if (flag !== '1') refuse('DOODLE_DEV_AUTH must be 1 to enable or unset');
  if (env.NODE_ENV === 'production') refuse('NODE_ENV=production');
  if (env.PUBLIC_BASE_URL) refuse('PUBLIC_BASE_URL is set');
  if (!LOOPBACK_HOSTS.has((env.HOST ?? '127.0.0.1').toLowerCase())) refuse('HOST is not a loopback address');
  return {
    identify(req) {
      if (!LOOPBACK_HOSTS.has(hostName(req.headers.host) ?? '')) return null;
      // A page from another local port is a different origin: only the app served by this very process is accepted.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return null;
      return { ...SYNTHETIC_USER };
    },
    /** Same-origin browser requests in dev carry a loopback Origin; the login stream checks it through this too. */
    allowsOrigin: isLoopbackOrigin,
  };
}
