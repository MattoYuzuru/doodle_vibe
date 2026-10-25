import { presetForOrigin, SOURCE_TYPES } from './presets.mjs';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// Typed recipes name an executor shipped with the backend. They hold no URL, field
// mapping or user value, so a stored one can never widen what the executor may do.
export const typedRecipe = type => ({ version: 1, type });
export function isTypedRecipe(recipe) {
  return plain(recipe) && recipe.version === 1 && SOURCE_TYPES.includes(recipe.type) && Object.keys(recipe).length === 2;
}

// Preset first (data), then a previously verified adapter for the same origin.
export function resolveTyped(origin, adapter) {
  const preset = presetForOrigin(origin);
  if (preset) return { type: preset.source.type, preset: preset.source };
  if (adapter && isTypedRecipe(adapter.recipe)) return { type: adapter.recipe.type, preset: null };
  return null;
}

// A Moodle installation answers its web-service endpoints with a structured error
// even to anonymous requests. The error shape is a positive identification and,
// unlike page markers, also works when the site redirects every page to SSO.
export async function probeMoodle(read, origin) {
  for (const path of ['/login/token.php', '/webservice/rest/server.php?wsfunction=core_webservice_get_site_info&moodlewsrestformat=json']) {
    try {
      const response = await read(`${origin}${path}`);
      if (new URL(response.url ?? `${origin}${path}`).origin !== origin) continue;
      const data = JSON.parse(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
      if (plain(data) && typeof data.errorcode === 'string' && ('reproductionlink' in data || 'exception' in data || 'debuginfo' in data)) return true;
    } catch { /* Not Moodle, unreachable or not JSON: keep looking. */ }
  }
  return false;
}

const knownLms = [
  ['canvas', /instructure\.com|canvas-lms|ic-app-header/i],
  ['blackboard', /blackboard\.com|Blackboard Learn|bb-base-navigation/i],
  ['openedx', /Open edX|edx-platform|openedx/i],
  ['brightspace', /Brightspace|desire2learn|\/d2l\/lp\//i],
  ['sakai', /<title>[^<]*Sakai|sakaiproject\.org/i],
];
// Named so the user learns the system is recognised but not supported yet.
export function identifyOtherLms(text) {
  return knownLms.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}
