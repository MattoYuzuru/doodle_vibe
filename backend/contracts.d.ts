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
  dueAt?:string; location?:string; courseId?:string;
}
export type AuthField = 'token'|'username'|'password'|'service'|'calendarUrl'|'identifier';
/** Credential form offered for a connection; `note`/`notes` are stable codes the UI words itself. */
export interface AuthMethod {
  id:string; type:'token'|'password'|'calendar_url'|'identifier'|'oauth'; label:string; fields?:AuthField[];
  sourceType?:'moodle'|'ical'|'ruz'; note?:string; notes?:string[];
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
