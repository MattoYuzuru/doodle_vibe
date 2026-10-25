import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { safeRequest, validateSourceUrl } from './sources/index.mjs';
import { sanitizeText } from './sources/recipes.mjs';

const TTL_MS = 15 * 60_000;
const BUDGET_MS = 15_000;
const MAX_TEXT = 20_000;
const MAX_BYTES = 1_048_576;
const stopWords = new Set('what when where which does how the and are for from with this that about как где когда какой какая какие что это для или про мне меня вуз вуза university'.split(' '));
const words = text => [...new Set(String(text).toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(word => !stopWords.has(word)).slice(0, 20);
const score = (text, keywords) => {
  const tokens = words(text);
  return keywords.filter(keyword => tokens.some(token => token === keyword || (keyword.length > 5 && /[а-яё]/u.test(keyword) && token.startsWith(keyword.slice(0, -1))))).length;
};
const failure = code => new AppError(code, 400);
const idFor = (connectionId, url) => `${connectionId}:web:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;

function pageUrl(value, origin) {
  const url = validateSourceUrl(value);
  if (url.search || (origin && url.origin !== origin) || /\.(?:pdf|docx?|xlsx?|pptx?|zip|exe|js|css|png|jpe?g|gif|svg|mp[34])$/i.test(url.pathname)) throw failure('web_url_unsupported');
  return url;
}

function extractLinks(html, base, keywords) {
  const clean = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(script|style|form|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const links = []; const seen = new Set(); let inspected = 0;
  for (const match of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    if (++inspected > 300) break;
    const label = sanitizeText(match[4], 300); const relevance = score(label, keywords);
    if (!relevance) continue;
    try {
      const location = new URL((match[1] ?? match[2] ?? match[3]).replaceAll('&amp;', '&'), base);
      location.hash = '';
      const url = pageUrl(location.href, new URL(base).origin);
      if (url.href === base || seen.has(url.href)) continue;
      seen.add(url.href); links.push({ url: url.href, relevance });
    } catch { /* Off-origin, private, signed and unsupported links are not requests. */ }
  }
  return links.sort((a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url));
}

function parsePage(response, expectedOrigin, keywords) {
  if (!response || !Number.isInteger(response.status)) throw failure('web_response_invalid');
  if (response.status === 401 || response.status === 403) throw failure('web_auth_required');
  if (response.status === 429) throw failure('web_rate_limited');
  if (response.status < 200 || response.status >= 300) throw failure('web_source_unavailable');
  const type = String(response.headers?.['content-type'] ?? response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!type.includes('text/html') || /attachment/i.test(String(response.headers?.['content-disposition'] ?? ''))) throw failure('web_format_unsupported');
  if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_BYTES) throw failure('web_response_invalid');
  const url = pageUrl(response.url, expectedOrigin).href;
  if (/<form\b|<input\b[^>]*type\s*=\s*["']?password\b|samlrequest|openid-connect/i.test(response.body) || /<title\b[^>]*>\s*(?:log\s?in|sign\s?in|вход|авторизация)\s*<\/title>/i.test(response.body)) throw failure('web_auth_required');
  const text = sanitizeText(response.body, MAX_TEXT);
  if (!text) throw failure('web_content_unavailable');
  const title = sanitizeText(response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 'University public page', 300);
  return { url, title, text, links: extractLinks(response.body, url, keywords) };
}

// This is a bounded reader of configured university sources. It is neither an
// arbitrary web search nor a browser/SSO session, and never uses private access.
export function createWebRetriever({ store, request = safeRequest, now = Date.now }) {
  return async function retrieve(userId, spaceId, question) {
    // Authorization precedes cache reads, link selection and every external read.
    store.getSpace(userId, spaceId);
    const connections = store.listConnections(userId, spaceId);
    const cached = store.listDocuments(userId, spaceId, { limit: 200 });
    const keywords = words(question);
    const selected = connections.slice().sort((a, b) => score(`${b.label ?? ''} ${b.kind ?? ''}`, keywords) - score(`${a.label ?? ''} ${a.kind ?? ''}`, keywords) || a.id.localeCompare(b.id)).slice(0, 2);
    const result = { documents: [], errorCodes: [], fetched: 0, cached: 0, limitations: ['public_known_sources_only', 'no_browser_sso', 'cached_seed_links_refresh_after_15_minutes'] };
    const errors = new Set(), seen = new Set(), returned = new Set();
    if (!selected.length) errors.add('web_no_sources');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BUDGET_MS);
    const recent = (connection, url) => cached.find(document => document.connectionId === connection.id && document.url === url && Number.isFinite(Date.parse(document.fetchedAt)) && now() - Date.parse(document.fetchedAt) >= 0 && now() - Date.parse(document.fetchedAt) < TTL_MS);
    function addDocument(document, fromCache = false) {
      const key = `${document.connectionId}:${document.url}`;
      if (returned.has(key)) return;
      returned.add(key); result.documents.push({ ...document, untrusted: true });
      result[fromCache ? 'cached' : 'fetched']++;
    }
    async function readPage(connection, value) {
      let url;
      try {
        url = pageUrl(value, new URL(connection.sourceUrl).origin).href;
        const key = `${connection.id}:${url}`;
        if (seen.has(key)) return null;
        seen.add(key);
        store.getSpace(userId, spaceId);
        const owned = store.getConnection(userId, connection.id);
        if (owned.spaceId !== spaceId || owned.sourceUrl !== connection.sourceUrl) throw failure('web_source_changed');
        const existing = recent(connection, url);
        if (existing) { addDocument(existing, true); return null; }
        if (controller.signal.aborted) throw failure('web_timeout');
        let abortHandler;
        const response = await Promise.race([
          // Only the public GET capability is passed: no cookies, auth headers,
          // readSecret, model proposal, forms or URL chosen by the question.
          request(url, { method: 'GET', signal: controller.signal }),
          new Promise((_, reject) => {
            abortHandler = () => reject(failure('web_timeout'));
            controller.signal.addEventListener('abort', abortHandler, { once: true });
          })
        ]).finally(() => controller.signal.removeEventListener('abort', abortHandler));
        if (controller.signal.aborted) throw failure('web_timeout');
        const page = parsePage({ ...response, url: response?.url ?? url }, new URL(connection.sourceUrl).origin, keywords);
        store.getSpace(userId, spaceId);
        const current = store.getConnection(userId, connection.id);
        if (current.spaceId !== spaceId || current.sourceUrl !== connection.sourceUrl) throw failure('web_source_changed');
        if (controller.signal.aborted) throw failure('web_timeout');
        const document = { id: idFor(connection.id, page.url), connectionId: connection.id, url: page.url, title: page.title, text: page.text, fetchedAt: new Date(now()).toISOString() };
        const saved = store.putDocument(userId, spaceId, document);
        addDocument(saved ?? document);
        return { connection, links: page.links };
      } catch (error) {
        if (controller.signal.aborted) errors.add('web_timeout');
        else if (error instanceof AppError && /^web_[a-z_]+$/.test(error.code)) errors.add(error.code);
        else if (error?.status === 404) errors.add('web_source_changed');
        else errors.add('web_source_unavailable');
        return null;
      }
    }
    try {
      const seeds = await Promise.all(selected.map(connection => readPage(connection, connection.sourceUrl)));
      if (!controller.signal.aborted) {
        const links = seeds.flatMap(seed => seed ? seed.links.map(link => ({ ...link, connection: seed.connection })) : []).sort((a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url));
        const unique = new Set();
        const chosen = links.filter(link => { if (unique.has(link.url)) return false; unique.add(link.url); return true; }).slice(0, 2);
        await Promise.all(chosen.map(link => readPage(link.connection, link.url)));
        // Recent owned pages can answer another question without crawling a
        // cached seed again; new link discovery waits for that seed's TTL.
        const allowed = new Set(selected.map(connection => connection.id));
        for (const document of cached.filter(doc => allowed.has(doc.connectionId) && score(`${doc.title} ${doc.text}`, keywords) && recent({ id: doc.connectionId }, doc.url)).slice(0, 2)) {
          try {
            const connection = store.getConnection(userId, document.connectionId);
            pageUrl(document.url, new URL(connection.sourceUrl).origin);
            if (connection.spaceId === spaceId) addDocument(document, true);
          } catch { errors.add('web_source_changed'); }
        }
      }
    } finally { clearTimeout(timer); }
    result.errorCodes = [...errors].sort();
    return result;
  };
}
