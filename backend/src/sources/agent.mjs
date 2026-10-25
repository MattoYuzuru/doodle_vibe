// Agent retrieval (contract §7): a fallback for origins without a learned recipe. The model drives three tools and nothing
// else: open(url) = GET on the source origin, list_links, extract(kind, items). The executor applies the session, so the model
// never sees cookies, tokens or keys; page text is untrusted data. There is no form, no non-GET method and no way to change
// the origin. Documents are stored from the text of an opened page, never from the model's words. Without a model the mode is off.
import { AppError } from '../errors.mjs';
import { digest, sanitizeText } from './recipes.mjs';
import { validateSourceUrl } from './network.mjs';
import { inspectSessionResponse, KINDS } from './learned.mjs';

export const AGENT_LIMITS = Object.freeze({ pages: 12, steps: 20, timeMs: 60_000, historyChars: 24_000, pageChars: 6000, links: 40, items: 200, itemsPerCall: 50 });
const DENIED_URL = /(?:logout|logoff|signout|sign-out|delete|remove|edit|submit|sesskey=|unenrol|upload|reset|password|confirm|download|forcelogout)/i;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Normalised same-origin GET target or null: https, no credentials/fragment, nothing that reads like a state-changing action. */
export function agentUrl(value, origin, base = `${origin}/`) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value, base); url.hash = ''; validateSourceUrl(url.href); } catch { return null; }
  let readable; try { readable = decodeURIComponent(`${url.pathname}${url.search}`); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || DENIED_URL.test(readable)) return null;
  return url.href;
}

function pageOf(url, response) {
  const html = response.format === 'html';
  const title = html ? sanitizeText(response.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', 200) : '';
  const links = []; const seen = new Set();
  if (html) {
    for (const match of response.text.slice(0, 400_000).matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      const target = agentUrl(match[1], new URL(url).origin, url);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      links.push({ text: sanitizeText(match[2], 100), url: target });
      if (links.length >= AGENT_LIMITS.links) break;
    }
  }
  return { url, title, text: sanitizeText(response.text, 100_000), links };
}

const normal = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
function extract(action, { pages, extracted, connection, fetchedAt, limits }) {
  let count = 0; let dropped = 0;
  if (!KINDS.includes(action.kind) || !Array.isArray(action.items)) return { count, dropped: 1 };
  const origin = new URL(connection.sourceUrl).origin;
  for (const raw of action.items.slice(0, limits.itemsPerCall)) {
    const page = plain(raw) ? pages.get(agentUrl(raw.sourceUrl, origin) ?? '') : null;
    // Items with no opened source page, or whose title is not on that page, are dropped.
    if (!page || typeof raw.title !== 'string' || !raw.title.trim() || !normal(page.text).includes(normal(raw.title)) || extracted[action.kind].length >= limits.items) { dropped++; continue; }
    if (action.kind === 'documents') { extracted.documents.push({ page }); count++; continue; }
    const item = { id: `${connection.id}:${digest(`agent:${action.kind}:${page.url}:${normal(raw.title)}`)}`, externalId: digest(`${page.url}:${normal(raw.title)}`),
      connectionId: connection.id, title: sanitizeText(raw.title, 500), url: page.url, sourceUrl: page.url, fetchedAt, extractedBy: 'agent' };
    const link = agentUrl(raw.url, origin, page.url);
    if (link) item.url = link;
    let valid = true;
    for (const name of ['startsAt', 'endsAt', 'dueAt']) {
      if (raw[name] === undefined || raw[name] === null) continue;
      if (typeof raw[name] !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw[name]) || !Number.isFinite(Date.parse(raw[name]))) { valid = false; break; }
      item[name] = new Date(raw[name]).toISOString();
    }
    for (const name of ['location', 'description']) if (typeof raw[name] === 'string' && raw[name].trim()) item[name] = sanitizeText(raw[name], 1000);
    if (!valid || (action.kind === 'schedule' && !item.startsAt) || (action.kind === 'deadlines' && !item.dueAt)) { dropped++; continue; }
    extracted[action.kind].push(item); count++;
  }
  return { count, dropped };
}

function finish({ extracted, connection, fetchedAt }) {
  const snapshots = []; const counts = {};
  for (const kind of ['courses', 'schedule', 'deadlines']) {
    const items = [...new Map(extracted[kind].map(item => [item.id, item])).values()];
    if (items.length) { snapshots.push({ kind, items }); counts[kind] = items.length; }
  }
  // putDocument stores query-free URLs only.
  const documents = [...new Map(extracted.documents.map(({ page }) => [page.url, page])).values()]
    .filter(page => !new URL(page.url).search && page.text)
    .map(page => ({ id: `${connection.id}:${digest(page.url)}`, connectionId: connection.id, url: page.url, title: page.title || 'Source document', text: page.text, fetchedAt }));
  if (documents.length) counts.documents = documents.length;
  if (!snapshots.length && !documents.length) throw new AppError('source_mapping_required', 400);
  return { snapshots, documents, failures: [], counts };
}

/** Returns null (mode off) when the model has no `agentStep`, i.e. without a DeepSeek key. */
export function createAgentRetriever({ model, now = Date.now, limits = AGENT_LIMITS } = {}) {
  if (!model || typeof model.agentStep !== 'function') return null;
  return {
    async retrieve({ request, session, connection, origin, fetchedAt }) {
      const started = now();
      const pages = new Map(); // url -> page: the only places an extracted item may come from
      const extracted = { courses: [], schedule: [], deadlines: [], documents: [] };
      const history = [];
      let last = null;
      // postPaths is empty: the transport refuses POST for the agent by construction.
      const sessionOptions = { origin, auth: session.bearer && !session.cookies?.length ? 'bearer' : 'cookie', cookies: session.cookies, bearer: session.bearer, postPaths: [], now: now() };
      // The model gets page text only as data under `untrusted`.
      const view = page => ({ url: page.url, title: page.title, untrusted: page.text.slice(0, limits.pageChars), linkCount: page.links.length });

      async function open(target) {
        const url = agentUrl(target, origin, last?.url ?? `${origin}/`);
        if (!url) return { ok: false, reason: 'url_not_allowed' };
        if (pages.has(url)) { last = pages.get(url); return { ok: true, page: view(last), cached: true }; }
        if (pages.size >= limits.pages) return { ok: false, reason: 'page_budget_exhausted' };
        let current = url;
        for (let hop = 0; hop < 3; hop++) {
          const response = await request(current, { method: 'GET', session: sessionOptions });
          if (response.status >= 300 && response.status < 400) {
            inspectSessionResponse(response, { origin }); // a login redirect ends the run as an expired session
            const next = agentUrl(response.headers?.location ?? '', origin, current);
            if (!next) return { ok: false, reason: 'redirect_not_allowed' };
            current = next; continue;
          }
          const inspected = inspectSessionResponse(response, { origin, expect: 'any' });
          if (inspected.format === 'text') return { ok: false, reason: 'unsupported_content' };
          const page = pageOf(current, inspected.format === 'json' ? { format: 'json', text: JSON.stringify(inspected.data) } : inspected);
          pages.set(url, page); pages.set(current, page); last = page;
          return { ok: true, page: view(page) };
        }
        return { ok: false, reason: 'redirect_limit' };
      }
      async function ask(input) {
        let timer;
        try {
          return await Promise.race([model.agentStep(input), new Promise((_, reject) => { timer = setTimeout(() => reject(new AppError('source_timeout', 504)), Math.max(1, limits.timeMs - (now() - started))); })]);
        } catch (error) {
          throw error instanceof AppError && error.code === 'source_timeout' ? error : new AppError('source_unavailable', 502);
        } finally { clearTimeout(timer); }
      }

      history.push({ tool: 'open', result: await open(connection.sourceUrl) });
      for (let step = 0; step < limits.steps && now() - started < limits.timeMs; step++) {
        let budget = limits.historyChars;
        const visible = [...history].reverse().filter(entry => (budget -= JSON.stringify(entry).length) > 0).reverse();
        const action = await ask({ origin, kinds: KINDS, budget: { pagesLeft: limits.pages - pages.size, stepsLeft: limits.steps - step }, history: visible });
        if (!plain(action) || action.action === 'finish') break;
        if (action.action === 'open') history.push({ tool: 'open', url: typeof action.url === 'string' ? action.url.slice(0, 200) : null, result: await open(action.url) });
        else if (action.action === 'list_links') history.push({ tool: 'list_links', result: { ok: !!last, links: last ? last.links.map(link => ({ text: link.text, url: link.url })) : [] } });
        else if (action.action === 'extract') history.push({ tool: 'extract', result: extract(action, { pages, extracted, connection, fetchedAt, limits }) });
        else history.push({ tool: 'unknown', result: { ok: false, reason: 'unknown_tool' } });
      }
      return finish({ extracted, connection, fetchedAt });
    },
  };
}
