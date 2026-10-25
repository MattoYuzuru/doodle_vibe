import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from 'undici';
import { AppError } from '../errors.mjs';

export const MAX_BYTES = 1_048_576;
export const TIMEOUT_MS = 10_000;
// A stored-session read runs the university's own logged-in API, which answers slower than public pages (ВШЭ Moodle AJAX: 1-5 s).
export const SESSION_TIMEOUT_MS = 30_000;
const deniedQuery = /(?:token|password|passwd|secret|cookie|session|authorization|api.?key|signature|credential|csrf|jwt|code)/i;
const fail = code => new AppError(code, 400);

export function isPublicAddress(address) {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(host) !== 6) return false;
  // Conservatively accept native global unicast only; reject mapped, NAT64,
  // documentation, transition/tunnelling and special-purpose IPv6 ranges.
  const [first, second] = host.split(':').map(part => parseInt(part || '0', 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x3fff;
}

// `allowSecretQuery` is only for an executor-held secret URL (e.g. a Moodle
// calendar export). Such URLs are never accepted from recipes or stored in public fields.
export function validateSourceUrl(value, { allowSecretQuery = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw fail('source_url_invalid'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname) || /(?:^|\.)home\.arpa$/.test(hostname) ||
      (!isIP(hostname) && !hostname.includes('.')) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw fail('source_url_unsafe');
  }
  if (!allowSecretQuery) for (const [key, val] of url.searchParams) {
    if (deniedQuery.test(key) || /[A-Za-z0-9_+-]{32,}/.test(val) || /(?:bearer\s|eyJ[A-Za-z0-9_-]{12,}\.)/i.test(val)) throw fail('source_url_secret');
  }
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.href)) throw fail('source_url_unsafe');
  return url;
}

export async function resolvePublicAddress(hostname, resolver = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw fail('source_address_unsafe');
  return addresses[0];
}

// Session mode (contract §4): a stored browser session is applied by the executor only. The Cookie / Authorization
// header is built from the secret for the bound origin, redirects are never followed (3xx is returned as is so the
// caller can recognise a login redirect) and POST is limited to paths the caller names (the code-level read-only allowlist).
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}$/;
function cookieApplies(cookie, url, nowSeconds) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || !cookieName.test(cookie.name) || !cookieValue.test(cookie.value)) return false;
  if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSeconds) return false;
  const domain = cookie.domain.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (!domain.replace(/^\./, '').includes('.')) return false; // a bare public suffix (`.edu`) is never a valid cookie domain
  if (!(domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain)) return false;
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  return url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}
function sessionHeaders(url, method, body, session) {
  if (!session || typeof session !== 'object' || typeof session.origin !== 'string' || validateSourceUrl(session.origin).origin !== session.origin || url.origin !== session.origin) throw fail('source_auth_origin_unsafe');
  if (method === 'POST') {
    if (!Array.isArray(session.postPaths) || !session.postPaths.includes(url.pathname) || typeof body !== 'string' || Buffer.byteLength(body) > 16_384) throw fail('source_method_unsafe');
  } else if (body !== undefined) throw fail('source_method_unsafe');
  const headers = { accept: 'application/json,text/html;q=0.8', 'x-requested-with': 'XMLHttpRequest' };
  if (session.auth === 'bearer') {
    const bearer = session.bearer;
    if (!bearer || typeof bearer.token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{8,8192}$/.test(bearer.token) || bearer.host !== url.hostname) throw new AppError('source_session_expired', 401);
    headers.authorization = `Bearer ${bearer.token}`;
  } else if (session.auth === 'cookie') {
    const nowSeconds = Math.floor((session.now ?? Date.now()) / 1000);
    const cookies = (Array.isArray(session.cookies) ? session.cookies : []).filter(cookie => cookieApplies(cookie, url, nowSeconds));
    if (!cookies.length) throw new AppError('source_session_expired', 401);
    headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  } else throw fail('source_auth_origin_unsafe');
  if (method === 'POST') headers['content-type'] = 'application/json';
  return headers;
}

// Per-hop DNS validation and pinned socket lookup prevent DNS rebinding. No
// global dispatcher, ambient proxy, cookies or credentials are inherited.
export function createSafeRequest({ resolver = lookup, boundAuthEndpoint, clientFactory = (origin, options) => new Client(origin, options) } = {}) {
  return async function request(value, { method = 'GET', headers = {}, body, authenticated = false, secretUrl = false, boundOrigin, session, signal: callerSignal } = {}) {
    if (!['GET', 'POST'].includes(method) || (method === 'POST' && !authenticated && !session) || (secretUrl && (method !== 'GET' || authenticated)) || (session && (authenticated || secretUrl))) throw fail('source_method_unsafe');
    // Session URLs come from lint-checked recipes (templated query values may be long method names), not from source content.
    let url = validateSourceUrl(value, { allowSecretQuery: secretUrl || !!session });
    const stored = session ? sessionHeaders(url, method, body, session) : null;
    if (secretUrl && (typeof boundOrigin !== 'string' || url.origin !== boundOrigin)) throw fail('source_auth_origin_unsafe');
    if (authenticated && method === 'GET') {
      if (typeof boundOrigin !== 'string' || validateSourceUrl(boundOrigin).origin !== boundOrigin || url.origin !== boundOrigin ||
          typeof headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+\/=-]{8,8192}$/.test(headers.authorization)) throw fail('source_auth_origin_unsafe');
    } else if (authenticated && !(boundAuthEndpoint ? url.href === boundAuthEndpoint : ['/login/token.php', '/webservice/rest/server.php'].includes(url.pathname))) throw fail('source_auth_endpoint_unsafe');
    const limit = session ? SESSION_TIMEOUT_MS : TIMEOUT_MS;
    const signal = callerSignal ? AbortSignal.any([AbortSignal.timeout(limit),callerSignal]) : AbortSignal.timeout(limit);
    for (let hop = 0; hop <= 3; hop++) {
      let client;
      try {
        signal.throwIfAborted();
        const address = await Promise.race([
          resolvePublicAddress(url.hostname, resolver),
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(fail('source_timeout')), { once: true }))
        ]);
        signal.throwIfAborted();
        client = clientFactory(url.origin, {
          connect: { timeout: TIMEOUT_MS, lookup: (_host, options, callback) => options.all
            ? callback(null, [address]) : callback(null, address.address, address.family) },
          headersTimeout: limit, bodyTimeout: limit, maxResponseSize: MAX_BYTES
        });
        const allowedHeaders = stored ?? { accept: 'application/json,text/csv,text/calendar,text/html;q=0.9' };
        // Only executor-created form bodies carry credentials, never caller headers.
        if (authenticated && method === 'GET') allowedHeaders.authorization = headers.authorization;
        if (method === 'POST' && !stored) allowedHeaders['content-type'] = 'application/x-www-form-urlencoded';
        const response = await client.request({ path: url.pathname + url.search, method, headers: allowedHeaders, body, signal, maxRedirections: 0 });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (stored) {
            await response.body.dump().catch(() => {}); // a session redirect is reported to the caller, never followed
            return { status: response.statusCode, headers: { location: String(response.headers.location ?? '') }, body: '', url: url.href };
          }
          response.body.destroy();
          if (authenticated || secretUrl) throw fail('source_auth_redirect');
          if (hop === 3 || !response.headers.location) throw fail('source_redirect_limit');
          url = validateSourceUrl(new URL(response.headers.location, url).href);
          continue;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_BYTES) { response.body.destroy(); throw fail('source_too_large'); }
          chunks.push(Buffer.from(chunk));
        }
        return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), url: url.href };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (signal.aborted || /TIMEOUT/.test(error.code ?? '')) throw fail('source_timeout');
        if (error.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') throw fail('source_too_large');
        throw fail('source_unavailable');
      } finally {
        if (client) await client.destroy();
      }
    }
    throw fail('source_redirect_limit');
  };
}

export const safeRequest = createSafeRequest();

// Configuration-only factory: the returned closure cannot choose another endpoint.
// The endpoint is never accepted from recipes, source content or user form fields.
export function createBoundTokenRequest(endpoint) {
  const url = validateSourceUrl(endpoint);
  if (url.search) throw fail('source_auth_endpoint_unsafe');
  const request = createSafeRequest({ boundAuthEndpoint: url.href });
  return async form => {
    if (!(form instanceof URLSearchParams) && typeof form !== 'string') throw fail('source_request_invalid');
    const body = form.toString();
    if (Buffer.byteLength(body) > 16_384) throw fail('source_request_invalid');
    return request(url.href, { method: 'POST', authenticated: true, body });
  };
}
