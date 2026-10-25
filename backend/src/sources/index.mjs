import { AppError } from '../errors.mjs';
import { safeRequest, validateSourceUrl, TIMEOUT_MS, SESSION_TIMEOUT_MS } from './network.mjs';
import { digest, validateRecipe, parseResponse, publicObservation, normalizeRecipe, inferPublicRecipe, redactSecrets } from './recipes.mjs';
import { syncMoodle, MOODLE_CAPABILITIES } from './moodle.mjs';
import { syncCalendar } from './ical.mjs';
import { syncRuz } from './ruz.mjs';
import { describeAuthMethods } from './presets.mjs';
import { typedRecipe, resolveTyped, probeMoodle, identifyOtherLms } from './detect.mjs';
import { storedSessionOf, syncWithSession } from './session-sync.mjs';
import { createAgentRetriever } from './agent.mjs';
import { learnAndActivate, findLearnedAdapter } from './learned.mjs';
import { SEED_RECIPES } from './learned-seeds.mjs';

export { safeRequest, validateSourceUrl, createBoundTokenRequest } from './network.mjs';
export { describeAuthMethods } from './presets.mjs';
const actionCodes = new Set(['source_auth_required', 'source_auth_redirect', 'source_mapping_required', 'source_format_unsupported', 'source_recipe_invalid', 'source_format_changed', 'source_network_restricted', 'source_identifier_not_found', 'source_identifier_ambiguous', 'source_lms_unsupported']);
const locks = new WeakMap();

// `agentModel` (needs `agentStep`) enables the agent fallback; `proposeLearnedRecipe(shapes)` is the optional shape-only model for learning.
export function createSourceService({ store, request = safeRequest, proposeRecipe, proposeLearnedRecipe, agentModel, now = Date.now }) {
  if (!store || typeof request !== 'function') throw new TypeError('source dependencies required');
  const agent = createAgentRetriever({ model: agentModel, now });
  if (!locks.has(store)) locks.set(store, new Map());
  const active = locks.get(store);
  async function read(url, options) {
    // A stored-session read is read-only by the recipe allowlist, so a timeout or a dropped connection is retried once.
    if (!options?.session) return readOnce(url, options);
    try { return await readOnce(url, options); } catch (error) {
      if (!(error instanceof AppError) || !['source_timeout', 'source_unavailable'].includes(error.code)) throw error;
      return readOnce(url, options);
    }
  }
  async function readOnce(url, options) {
    // Fixtures bypass production sockets only. URL validation, bounded responses,
    // status handling, origin binding and all executor checks remain enabled.
    validateSourceUrl(url, { allowSecretQuery: options?.secretUrl || !!options?.session });
    let timer;
    try {
      const result = await Promise.race([request(url, options), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError('source_timeout', 504)), options?.session ? SESSION_TIMEOUT_MS : TIMEOUT_MS);
      })]);
      if (result?.url) {
        const final = validateSourceUrl(result.url, { allowSecretQuery: options?.secretUrl || !!options?.session });
        if ((options?.authenticated || options?.secretUrl || options?.session) && final.origin !== new URL(url).origin) throw new AppError('source_auth_redirect', 400);
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  function persist(connection, userId, result) {
    // Recheck ownership/existence after network work, including disconnect during sync.
    store.getConnection(userId, connection.id);
    store.updateConnection(userId, connection.id, { status: result.status, errorCode: result.errorCode ?? null, ...(result.adapterId ? { adapterId: result.adapterId } : {}) });
    return result;
  }
  function save(connection, userId, normalized, fetchedAt) {
    store.getConnection(userId, connection.id);
    if (normalized.documents) {
      for (const document of normalized.documents) store.putDocument(userId, connection.spaceId, document);
    } else store.putSnapshot(userId, connection.id, { ...normalized, fetchedAt, complete: true });
  }
  async function execute({ userId, connectionId }, mode) {
    // Ownership must be checked before origin cache, secret access, proposer or network.
    const connection = store.getConnection(userId, connectionId);
    const url = validateSourceUrl(connection.sourceUrl);
    const origin = url.origin;
    const fetchedAt = new Date(now()).toISOString();
    try {
      // A stored browser session (ADR-0005) selects the recipe / agent executors instead of the typed token flows.
      const session = storedSessionOf(store.readSecret(userId, connection.id), origin);
      if (session) return persist(connection, userId, await syncWithSession({ store, request: read, userId, connection, session, fetchedAt, now: now(), agent }));
      // Known universities are presets (data); any other origin is typed only after a
      // positive identification (Moodle probe, iCal feed) and remembered as an adapter.
      let adapter = connection.adapterId ? store.getAdapter(connection.adapterId) : store.findAdapter(origin);
      if (adapter && adapter.origin !== origin) throw new AppError('source_recipe_invalid', 400);
      const typed = resolveTyped(origin, adapter);
      if (typed) return persist(connection, userId, await runTyped(typed.type, mode, { userId, connection, origin, fetchedAt }));
      // An origin read through a browser session (seed or learned recipe) has no public data: its HTML shell is
      // not a document, so without a session the connection waits for a login instead of looking connected.
      if (SEED_RECIPES[origin] || findLearnedAdapter(store, origin)) return persist(connection, userId, { status: 'user_action_required', capabilities: [], errorCode: 'source_auth_required' });
      const adoptMoodle = () => {
        const adapterId = `moodle:${digest(origin)}`;
        store.putAdapter({ id: adapterId, origin, version: 1, recipe: typedRecipe('moodle'), capabilities: [...MOODLE_CAPABILITIES] });
        return persist(connection, userId, { status: 'user_action_required', capabilities: [...MOODLE_CAPABILITIES], errorCode: 'source_auth_required', adapterId, auth: 'moodle_token_or_password', authMethods: describeAuthMethods(origin, typedRecipe('moodle')).map(method => method.id) });
      };
      let privateToken;
      if (mode === 'sync') {
        const secret = store.readSecret(userId, connection.id);
        if (secret) {
          if (secret.origin !== origin || typeof secret.token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{8,8192}$/.test(secret.token)) throw new AppError('source_auth_required', 401);
          privateToken = secret.token;
        }
      }
      const response = await read(url.href, privateToken ? { authenticated: true, boundOrigin: origin, headers: { authorization: `Bearer ${privateToken}` } } : undefined);
      const finalUrl = response.url ? validateSourceUrl(response.url).href : url.href;
      if (new URL(finalUrl).origin !== origin) {
        if (!privateToken && connection.kind === 'lms' && await probeMoodle(read, origin)) return adoptMoodle();
        return persist(connection, userId, { status: 'user_action_required', capabilities: [], errorCode: 'source_auth_required' });
      }
      const parsed = parseResponse(response);
      if (adapter && (privateToken || !connection.adapterId) && adapter.recipe?.format !== parsed.format) adapter = null;
      if (!privateToken && parsed.format === 'ical') {
        // A public feed is read once now; the typed adapter then only names the executor.
        const result = await syncCalendar({ store, request: read, userId, connection, fetchedAt, now: now(), mode: 'schedule', target: finalUrl, fallbackUrl: finalUrl, response });
        if (!result.counts.schedule && !adapter) throw new AppError('source_mapping_required', 400);
        const adapterId = `ical:${digest(origin)}`;
        store.putAdapter({ id: adapterId, origin, version: 1, recipe: typedRecipe('ical'), capabilities: ['schedule'] });
        return persist(connection, userId, { ...result, adapterId });
      }
      if (!privateToken && parsed.format === 'html') {
        if (/(?:name=["']?moodle|moodle\.org|M\.cfg\s*=)/i.test(parsed.text) || (connection.kind === 'lms' && await probeMoodle(read, origin))) return adoptMoodle();
        const lms = identifyOtherLms(parsed.text);
        if (lms) return persist(connection, userId, { status: 'user_action_required', capabilities: [], errorCode: 'source_lms_unsupported', lms });
      }
      let recipe;
      if (adapter) recipe = validateRecipe(adapter.recipe);
      else if (proposeRecipe && !privateToken) {
        let timer;
        try {
          const candidate = await Promise.race([proposeRecipe(publicObservation(origin, parsed)), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new AppError('source_timeout', 504)), TIMEOUT_MS);
          })]);
          if (candidate) recipe = validateRecipe(candidate);
        } finally { clearTimeout(timer); }
      }
      if (!recipe) recipe = inferPublicRecipe(parsed);
      if (!recipe && parsed.format === 'html') recipe = validateRecipe({ version: 1, format: 'html', path: '$source', kind: 'documents' });
      if (!recipe) throw new AppError('source_mapping_required', 400);
      let normalized = normalizeRecipe(recipe, parsed, { connection, fetchedAt, url: finalUrl });
      if (privateToken) normalized = redactSecrets(normalized, [privateToken]);
      if (!adapter && normalized.items?.length === 0) throw new AppError('source_mapping_required', 400);
      save(connection, userId, normalized, fetchedAt);
      // Activate only a deterministic recipe that successfully parsed observed data.
      const adapterId = `public:${digest(origin + JSON.stringify(recipe))}`;
      if (!adapter && !privateToken) store.putAdapter({ id: adapterId, origin, version: 1, recipe, capabilities: [recipe.kind] });
      return persist(connection, userId, { status: 'ready', capabilities: [recipe.kind], ...((adapter || !privateToken) ? { adapterId: adapter?.id ?? adapterId } : {}), counts: { [recipe.kind]: normalized.items?.length ?? normalized.documents.length } });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) throw error;
      const errorCode = error instanceof AppError ? error.code : 'source_unavailable';
      return persist(connection, userId, { status: actionCodes.has(errorCode) ? 'user_action_required' : 'error', capabilities: [], errorCode });
    }
  }
  async function runTyped(type, mode, { userId, connection, origin, fetchedAt }) {
    const recipe = typedRecipe(type);
    const methods = describeAuthMethods(origin, recipe).map(method => method.id);
    const authRequired = { status: 'user_action_required', capabilities: [], errorCode: 'source_auth_required', authMethods: methods };
    const context = { store, request: read, userId, connection, fetchedAt, now: now() };
    if (type === 'moodle') {
      if (mode === 'discover') return { ...authRequired, capabilities: [...MOODLE_CAPABILITIES], auth: 'moodle_token_or_password' };
      return syncMoodle(context);
    }
    if (type === 'ruz') return mode === 'discover' ? { ...authRequired, capabilities: ['schedule'] } : syncRuz(context);
    const secret = store.readSecret(userId, connection.id);
    // ical: the feed is the connection URL, or a private URL held in encrypted storage.
    if (secret && (secret.origin !== origin || typeof secret.calendarUrl !== 'string')) throw new AppError('source_auth_required', 401);
    const target = secret?.calendarUrl ?? connection.sourceUrl;
    return syncCalendar({ ...context, mode: 'schedule', target, secret: !!secret, fallbackUrl: connection.sourceUrl });
  }
  function run(args, mode) {
    // Discovery/sync share a lock for a connection, across service instances.
    store.getConnection(args.userId, args.connectionId);
    const key = `${args.userId}:${args.connectionId}`;
    if (active.has(key)) return active.get(key);
    const pending = execute(args, mode).finally(() => active.delete(key));
    active.set(key, pending);
    return pending;
  }
  // Learn this origin from what the login observed (in memory): candidate -> lint -> canary on the observer's session -> revision.
  async function learn({ userId, connectionId, observations }) {
    const connection = store.getConnection(userId, connectionId);
    const origin = validateSourceUrl(connection.sourceUrl).origin;
    const session = storedSessionOf(store.readSecret(userId, connection.id), origin);
    if (!session) throw new AppError('source_auth_required', 401);
    const learned = await learnAndActivate({ store, observations, session, request: read, origin, now: now(), auth: session.bearer && !session.cookies?.length ? 'bearer' : 'cookie', propose: proposeLearnedRecipe });
    return learned ? { learned: true, created: learned.created, revision: learned.recipe.revision, adapterId: learned.adapter.id } : { learned: false };
  }
  return { discover: args => run(args, 'discover'), sync: args => run(args, 'sync'), learn };
}
