// Sync by a stored browser session (contract §4, §6): the secret `{origin, session}` is read inside the job only; a learned
// recipe (or the agent fallback) fetches with the user's own credentials. Expiry never asks for a login: the connection becomes
// `user_action_required` + `source_session_expired`, previous snapshots stay, and the scheduler stops polling it.
import { AppError } from '../errors.mjs';
import { ensureSeedRecipe, syncLearned, recordRecipeHealth } from './learned.mjs';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** `{origin, session}` with a v2 StoredSession for exactly this origin, else null (other secret forms belong to other executors). */
export function storedSessionOf(secret, origin) {
  return plain(secret) && secret.origin === origin && plain(secret.session) && secret.session.version === 2 ? secret.session : null;
}

const expiredResult = capabilities => ({ status: 'user_action_required', capabilities, errorCode: 'source_session_expired' });

function save(store, userId, connection, outcome, fetchedAt) {
  store.getConnection(userId, connection.id); // disconnect during the network work must not resurrect data
  for (const snapshot of outcome.snapshots) store.putSnapshot(userId, connection.id, { kind: snapshot.kind, items: snapshot.items, fetchedAt, complete: true });
  for (const document of outcome.documents ?? []) store.putDocument(userId, connection.spaceId, document);
}

export async function syncWithSession({ store, request, userId, connection, session, fetchedAt, now = Date.now(), agent }) {
  const origin = new URL(connection.sourceUrl).origin;
  // Known expiry costs no request at all.
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now) return expiredResult([]);
  const learned = ensureSeedRecipe(store, origin, { now });
  try {
    if (learned) {
      let outcome;
      try { outcome = await syncLearned({ recipe: learned.recipe, session, request, connection, fetchedAt, now }); }
      catch (error) {
        // Shadow verification: a format break is counted per user; three different users in a row roll the revision back.
        if (error instanceof AppError && error.code === 'source_format_changed') recordRecipeHealth(store, learned.adapter, userId, false, { now });
        throw error;
      }
      save(store, userId, connection, outcome, fetchedAt);
      const capabilities = Object.keys(outcome.counts);
      if (outcome.failures.length) {
        const codes = outcome.failures.map(failure => failure.code);
        if (codes.includes('source_format_changed')) recordRecipeHealth(store, learned.adapter, userId, false, { now });
        // `error` keeps the scheduler retrying (a rollback or a recipe fix may repair it); saved kinds are already stored.
        return { status: 'error', capabilities, errorCode: codes[0], adapterId: learned.adapter.id, counts: outcome.counts, partial: true };
      }
      recordRecipeHealth(store, learned.adapter, userId, true);
      return { status: 'ready', capabilities, adapterId: learned.adapter.id, counts: outcome.counts };
    }
    if (agent) {
      const outcome = await agent.retrieve({ request, session, connection, origin, fetchedAt, now });
      save(store, userId, connection, outcome, fetchedAt);
      const capabilities = Object.keys(outcome.counts);
      return { status: 'ready', capabilities, counts: outcome.counts, extractedBy: 'agent' };
    }
    return { status: 'user_action_required', capabilities: [], errorCode: 'source_mapping_required' };
  } catch (error) {
    if (error instanceof AppError && error.status === 404) throw error; // connection removed
    if (error instanceof AppError && error.code === 'source_session_expired') return expiredResult([]);
    const errorCode = error instanceof AppError ? error.code : 'source_unavailable';
    return { status: 'error', capabilities: [], errorCode };
  }
}
