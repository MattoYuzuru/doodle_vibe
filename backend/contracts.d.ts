/** Public v1 contract. Runtime routes are in src/http.mjs. Never send userId. */
export type SourceKind = 'lms' | 'schedule' | 'document' | 'table' | 'website';
export interface UniversitySpace { id:string; universityId:string; name:string; createdAt:string }
export interface Connection {
  id:string; spaceId:string; sourceUrl:string; kind:SourceKind; label:string;
  status:'pending'|'ready'|'user_action_required'|'error'; errorCode:string|null;
  adapterId:string|null; createdAt:string; updatedAt:string;
}
export interface SourceItem {
  id:string; externalId:string; connectionId:string; title:string; url:string;
  sourceUrl:string; fetchedAt:string; startsAt?:string; endsAt?:string;
  dueAt?:string; location?:string; courseId?:string; description?:string; extractedBy?:'agent';
}
export type AuthField = 'token'|'username'|'password'|'service'|'calendarUrl'|'identifier';
/** Credential form offered for a connection; `note`/`notes` are stable codes the UI words itself. */
export interface AuthMethod {
  /** `remote_login` (planned): open POST /connections/:id/login {mode:'interactive'}; `sso_password` (planned): login {mode:'password'}. */
  id:string; type:'remote_login'|'sso_password'|'token'|'password'|'calendar_url'|'identifier'|'oauth'; label:string; fields?:AuthField[];
  sourceType?:'moodle'|'ical'|'ruz'|'learned'; note?:string; notes?:string[];
}
/** POST /connections/:id/auth: exactly one form, `origin` equals the connection origin. */
export type AuthRequest = {origin:string} & (
  {token:string} | {username:string; password:string; service?:string} | {calendarUrl:string} | {identifier:string});
export interface Job {
  id:string; spaceId:string; connectionId:string; type:'discover'|'sync';
  status:'queued'|'running'|'succeeded'|'failed'; errorCode:string|null;
  result:unknown; attempts:number; createdAt:string; updatedAt:string;
}
export interface Citation {id:string; title:string; url:string; fetchedAt:string; stale:boolean}
export interface ChatAnswer {
  answer:string; sources:Citation[]; mode:'retrieval'|'model'; errorCode:string|null;
  spaceId:string; generatedAt:string;
  retrieval:null|{fetched:number;cached:number;errorCodes:string[];limitations:string[]};
}
export interface ApiError {error:{code:string;requestId:string}}

// --- Planned (ADR-0005, docs/architecture/auth-sessions-contract.md): remote-browser login, stored session, learned recipes ---
export type LoginMode = 'interactive' | 'password';
export type LoginStatus = 'starting' | 'awaiting_user' | 'filling' | 'awaiting_mfa' | 'capturing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
/** Public state of a login session; never contains credentials, codes, page content or query strings. */
export interface LoginSession {
  id: string; connectionId: string; mode: LoginMode; status: LoginStatus; errorCode: string | null;
  createdAt: string; expiresAt: string; idleExpiresAt: string | null;
  viewport: { width: number; height: number };
  /** origin + path of the current page, no query or hash */
  url: string | null;
  mfa: { kind: 'totp' | 'code'; attemptsLeft: number } | null;
}
export type LoginStartRequest = { mode: 'interactive' } | { mode: 'password'; username: string; password: string; keepCalendar?: boolean };
export interface LoginMfaRequest { code: string }
export interface LoginTicket { ticket: string; expiresAt: string; path: string }
/** Server -> client: binary messages are JPEG frames; text messages are JSON of this type. */
export type StreamServerMessage =
  | { type: 'hello'; width: number; height: number } | { type: 'status'; login: LoginSession }
  | { type: 'cursor'; cursor: string } | { type: 'closed'; reason: string };
/** Client -> server (coordinates in frame pixels). */
export type StreamClientMessage =
  | { type: 'mouse'; action: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'left' | 'right' | 'middle'; dx?: number; dy?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string }
  | { type: 'text'; text: string } | { type: 'resize'; width: number; height: number } | { type: 'ping' };
/** HTTP error codes of the login routes. */
export type LoginErrorCode = 'LOGIN_UNAVAILABLE' | 'LOGIN_COOLDOWN' | 'LOGIN_BUSY' | 'LOGIN_NOT_WAITING_MFA' | 'RATE_LIMITED';
/** connection/job errorCodes added by login and sync-by-session. */
export type LoginSourceErrorCode = 'source_session_expired' | 'source_login_failed' | 'source_bot_protection' | 'source_login_unrecognized'
  | 'source_login_form_ambiguous' | 'mfa_failed' | 'mfa_expired' | 'login_credentials_lost';

export interface StoredCookie { name: string; value: string; domain: string; path: string; expires?: number; secure: boolean; httpOnly: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }
/** Encrypted inside the connection secret as `{origin, session}`; never leaves the executor. */
export interface StoredSession {
  version: 2; capturedAt: string; expiresAt: string; identityDigest?: string; cookies: StoredCookie[];
  bearer?: { token: string; scheme: 'Bearer'; source: 'localStorage' | 'sessionStorage' | 'xhr-header'; key?: string; host: string; expiresAt?: string };
  calendarUrl?: string;
}

export type RecipeTransform = 'iso' | 'unixSeconds' | 'unixMillis';
export interface RecipeField { path: string; transform?: RecipeTransform }
export interface LearnedEndpoint {
  id: string; kind: 'courses' | 'schedule' | 'deadlines' | 'documents';
  request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown };
  response: { itemsPath: string; fields: { id: RecipeField; title: RecipeField; url?: RecipeField; startsAt?: RecipeField; endsAt?: RecipeField; dueAt?: RecipeField; location?: RecipeField; courseId?: RecipeField; description?: RecipeField } };
  pagination?: { type: 'offset' | 'page' | 'cursor'; param: string; limit: number; maxPages: number; cursorPath?: string };
}
/** Shared per origin, free of personal values; stored as an adapter row (id `learned:<digest>:<revision>`). */
export interface LearnedRecipe {
  version: 2; type: 'learned'; origin: string; revision: number; learnedAt: string; rollbackOf?: number;
  auth: { type: 'cookie' } | { type: 'bearer' };
  bootstrap?: Array<{ id: string; method: 'GET'; path: string; extract: Record<string, string> }>;
  endpoints: LearnedEndpoint[];
  validation: { requireKinds: Array<LearnedEndpoint['kind']>; minItems?: number };
}
/** Every errorCode a connection or job can carry; the UI words each one itself. */
export type SourceErrorCode = 'source_auth_required' | 'source_network_restricted' | 'source_identifier_not_found' | 'source_identifier_ambiguous'
  | 'source_lms_unsupported' | 'source_mapping_required' | 'source_format_unsupported' | 'source_recipe_invalid' | 'source_format_changed'
  | 'source_response_invalid' | 'source_unavailable' | 'source_timeout' | 'source_rate_limited' | LoginSourceErrorCode;
