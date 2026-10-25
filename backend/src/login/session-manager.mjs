// Contract stub: docs/architecture/auth-sessions-contract.md (task A owns the implementation).
// Parallel branches import this module and rely on the exported shape, not on its current behaviour.
import { AppError } from '../errors.mjs';

/**
 * @typedef {import('../../contracts.d.ts').LoginSession} LoginSession
 * @typedef {import('../../contracts.d.ts').LoginStartRequest} LoginStartRequest
 * @typedef {import('../../contracts.d.ts').StoredSession} StoredSession
 * @typedef {import('../../contracts.d.ts').AuthMethod} AuthMethod
 *
 * @typedef {object} LoginSessionManager
 * @property {() => {interactive:boolean, password:boolean}} capabilities  what this process can do (Chromium present, preset known)
 * @property {(connection:object) => AuthMethod[]} authMethods  `remote_login` / `sso_password` entries; [] when unavailable
 * @property {(userId:string, connectionId:string, request:LoginStartRequest) => Promise<LoginSession>} start  replaces the user's previous session; rejects LOGIN_UNAVAILABLE / LOGIN_COOLDOWN / LOGIN_BUSY
 * @property {(userId:string, loginId:string) => LoginSession} get  404 for unknown, foreign or forgotten sessions
 * @property {(userId:string, loginId:string, code:string) => Promise<LoginSession>} submitMfa
 * @property {(userId:string, loginId:string) => Promise<LoginSession>} handoff  password mode -> awaiting_user
 * @property {(userId:string, loginId:string) => Promise<LoginSession>} cancel
 * @property {(userId:string, loginId:string) => {ticket:string, expiresAt:string, path:string}} issueTicket  single use, 30 s
 * @property {(userId:string, connectionId:string) => LoginSession|null} active  session of this connection, for GET /connections/:id
 * @property {(connectionId:string) => Promise<void>} cancelForConnection  called on disconnect
 * @property {() => Promise<void>} close  destroys every context (shutdown)
 */

/** Disabled manager: every start is refused, nothing is launched. Replaced by task A. */
export function createLoginSessionManager(_options = {}) {
  const unavailable = () => { throw new AppError('LOGIN_UNAVAILABLE', 409); };
  return /** @type {LoginSessionManager} */ ({
    capabilities: () => ({ interactive: false, password: false }),
    authMethods: () => [],
    start: async () => unavailable(),
    get: () => { throw new AppError('NOT_FOUND', 404); },
    submitMfa: async () => { throw new AppError('NOT_FOUND', 404); },
    handoff: async () => { throw new AppError('NOT_FOUND', 404); },
    cancel: async () => { throw new AppError('NOT_FOUND', 404); },
    issueTicket: () => { throw new AppError('NOT_FOUND', 404); },
    active: () => null,
    cancelForConnection: async () => {},
    close: async () => {},
  });
}
