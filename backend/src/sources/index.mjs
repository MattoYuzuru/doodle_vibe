import { AppError } from '../errors.mjs';
import { safeRequest, validateSourceUrl, TIMEOUT_MS } from './network.mjs';
import { digest, validateRecipe, parseResponse, publicObservation, normalizeRecipe, inferPublicRecipe } from './recipes.mjs';
import { syncMoodle, MOODLE_CAPABILITIES } from './moodle.mjs';

export { safeRequest, validateSourceUrl, createBoundTokenRequest } from './network.mjs';
const actionCodes = new Set(['source_auth_required', 'source_auth_redirect', 'source_mapping_required', 'source_format_unsupported', 'source_recipe_invalid', 'source_format_changed']);
const locks = new WeakMap();

export function createSourceService({ store, request = safeRequest, proposeRecipe, now = Date.now }) {
  if (!store || typeof request !== 'function') throw new TypeError('source dependencies required');
  if (!locks.has(store)) locks.set(store, new Map());
  const active = locks.get(store);
  async function read(url, options) {
    // Fixtures bypass production sockets only. URL validation, bounded responses,
    // status handling, origin binding and all executor checks remain enabled.
    validateSourceUrl(url);
    let timer;
    try {
      const result = await Promise.race([request(url, options), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError('source_timeout', 504)), TIMEOUT_MS);
      })]);
      if (result?.url) {
        const final = validateSourceUrl(result.url);
        if (options?.authenticated && final.origin !== new URL(url).origin) throw new AppError('source_auth_redirect', 400);
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
      // MISIS Moodle is the only built-in credential flow. Other installations
      // must first positively identify Moodle through a public discovery read.
      let adapter = connection.adapterId ? store.getAdapter(connection.adapterId) : store.findAdapter(origin);
      if (adapter && adapter.origin !== origin) throw new AppError('source_recipe_invalid', 400);
      const moodle = origin === 'https://newlms.misis.ru' || (adapter?.recipe?.type === 'moodle' && adapter.recipe.version === 1 && Object.keys(adapter.recipe).length === 2);
      if (moodle) {
        if (mode === 'discover') return persist(connection, userId, { status: 'user_action_required', capabilities: [...MOODLE_CAPABILITIES], errorCode: 'source_auth_required', auth: 'moodle_token_or_password' });
        const result = await syncMoodle({ store, request: read, userId, connection, fetchedAt });
        return persist(connection, userId, result);
      }
      const response = await read(url.href);
      const finalUrl = response.url ? validateSourceUrl(response.url).href : url.href;
      if (new URL(finalUrl).origin !== origin) {
        return persist(connection, userId, { status: 'user_action_required', capabilities: [], errorCode: 'source_auth_required' });
      }
      const parsed = parseResponse(response);
      if (adapter && !connection.adapterId && adapter.recipe?.format !== parsed.format) adapter = null;
      if (parsed.format === 'html' && /(?:name=["']?moodle|moodle\.org|M\.cfg\s*=)/i.test(parsed.text)) {
        const recipe = { version: 1, type: 'moodle' };
        const adapterId = `moodle:${digest(origin)}`;
        store.putAdapter({ id: adapterId, origin, version: 1, recipe, capabilities: [...MOODLE_CAPABILITIES] });
        return persist(connection, userId, { status: 'user_action_required', capabilities: [...MOODLE_CAPABILITIES], errorCode: 'source_auth_required', adapterId, auth: 'moodle_token_or_password' });
      }
      let recipe;
      if (adapter) recipe = validateRecipe(adapter.recipe);
      else if (proposeRecipe) {
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
      const normalized = normalizeRecipe(recipe, parsed, { connection, fetchedAt, url: finalUrl });
      if (!adapter && normalized.items?.length === 0) throw new AppError('source_mapping_required', 400);
      save(connection, userId, normalized, fetchedAt);
      // Activate only a deterministic recipe that successfully parsed observed data.
      const adapterId = `public:${digest(origin + JSON.stringify(recipe))}`;
      if (!adapter) store.putAdapter({ id: adapterId, origin, version: 1, recipe, capabilities: [recipe.kind] });
      return persist(connection, userId, { status: 'ready', capabilities: [recipe.kind], adapterId: adapter?.id ?? adapterId, counts: { [recipe.kind]: normalized.items?.length ?? normalized.documents.length } });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) throw error;
      const errorCode = error instanceof AppError ? error.code : 'source_unavailable';
      return persist(connection, userId, { status: actionCodes.has(errorCode) ? 'user_action_required' : 'error', capabilities: [], errorCode });
    }
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
  return { discover: args => run(args, 'discover'), sync: args => run(args, 'sync') };
}
