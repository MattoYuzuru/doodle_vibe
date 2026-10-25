import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from 'undici';
import { AppError } from '../errors.mjs';

export const MAX_BYTES = 1_048_576;
export const TIMEOUT_MS = 10_000;
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

// Per-hop DNS validation and pinned socket lookup prevent DNS rebinding. No
// global dispatcher, ambient proxy, cookies or credentials are inherited.
export function createSafeRequest({ resolver = lookup, boundAuthEndpoint, clientFactory = (origin, options) => new Client(origin, options) } = {}) {
  return async function request(value, { method = 'GET', headers = {}, body, authenticated = false, secretUrl = false, boundOrigin, signal: callerSignal } = {}) {
    if (!['GET', 'POST'].includes(method) || (method === 'POST' && !authenticated) || (secretUrl && (method !== 'GET' || authenticated))) throw fail('source_method_unsafe');
    let url = validateSourceUrl(value, { allowSecretQuery: secretUrl });
    if (secretUrl && (typeof boundOrigin !== 'string' || url.origin !== boundOrigin)) throw fail('source_auth_origin_unsafe');
    if (authenticated && method === 'GET') {
      if (typeof boundOrigin !== 'string' || validateSourceUrl(boundOrigin).origin !== boundOrigin || url.origin !== boundOrigin ||
          typeof headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+\/=-]{8,8192}$/.test(headers.authorization)) throw fail('source_auth_origin_unsafe');
    } else if (authenticated && !(boundAuthEndpoint ? url.href === boundAuthEndpoint : ['/login/token.php', '/webservice/rest/server.php'].includes(url.pathname))) throw fail('source_auth_endpoint_unsafe');
    const signal = callerSignal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS),callerSignal]) : AbortSignal.timeout(TIMEOUT_MS);
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
          headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS, maxResponseSize: MAX_BYTES
        });
        const allowedHeaders = { accept: 'application/json,text/csv,text/calendar,text/html;q=0.9' };
        // Only executor-created form bodies carry credentials, never caller headers.
        if (authenticated && method === 'GET') allowedHeaders.authorization = headers.authorization;
        if (method === 'POST') allowedHeaders['content-type'] = 'application/x-www-form-urlencoded';
        const response = await client.request({ path: url.pathname + url.search, method, headers: allowedHeaders, body, signal, maxRedirections: 0 });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
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
