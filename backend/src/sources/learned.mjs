// Contract stub: learned recipes v2 (task B owns the implementation).
// Types: LearnedRecipe / StoredSession in backend/contracts.d.ts; rules: docs/architecture/auth-sessions-contract.md §5-§6.
import { AppError } from '../errors.mjs';

/** Read-only POST endpoints a learned recipe may call. Data, not code; extended only through review. */
export const READ_ONLY_POST_ALLOWLIST = Object.freeze([
  Object.freeze({ path: '/lib/ajax/service.php', methods: Object.freeze(['core_course_get_enrolled_courses_by_timeline_classification', 'core_calendar_get_action_events_by_timesort']) }),
]);

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const notImplemented = () => { throw new AppError('LEARNED_NOT_IMPLEMENTED', 501); };

/** True for `{version:2, type:'learned', ...}` adapter recipes; ignores the typed v1 recipes of ADR-0004. */
export function isLearnedRecipe(recipe) {
  return plain(recipe) && recipe.version === 2 && recipe.type === 'learned';
}

/** Throws AppError('source_recipe_invalid') unless the recipe satisfies contract §5; returns a clean copy. */
export function validateLearnedRecipe(recipe, _options = {}) {
  if (!isLearnedRecipe(recipe)) throw new AppError('source_recipe_invalid', 400);
  return notImplemented();
}

/** Builds a candidate from in-memory observations (shape only); returns a LearnedRecipe or null. */
export async function learnFromObservations(_observations, _options = {}) { return notImplemented(); }

/** Executes a recipe with a StoredSession; returns normalized snapshots per kind or throws source_session_expired / source_format_changed. */
export async function syncLearned(_context) { return notImplemented(); }
