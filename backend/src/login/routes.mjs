// Contract stub: HTTP and WebSocket routes of the login sessions (task A owns the implementation).
// `handle` returns true when it answered the request; `upgrade` is wired to server 'upgrade' events.

/**
 * @typedef {object} LoginRouteContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {string} userId  verified identity; routes must still check ownership of connection/session
 * @property {string} requestId
 * @property {(res:import('node:http').ServerResponse, status:number, value:unknown, requestId:string) => void} send
 * @property {() => Promise<unknown>} readBody  JSON, size-limited
 */

/** @returns {{handle:(ctx:LoginRouteContext) => Promise<boolean>, upgrade:(req:import('node:http').IncomingMessage, socket:import('node:stream').Duplex, head:Buffer) => void}} */
export function createLoginRoutes(_options = {}) {
  return {
    handle: async () => false,
    upgrade: (_req, socket) => { socket.destroy(); },
  };
}
