// Contract stub: local development identity without Telegram (task C owns the implementation).
// Contract: enabled only by DOODLE_DEV_AUTH=1, only for loopback HOST, never with PUBLIC_BASE_URL or
// NODE_ENV=production (startup must fail), one synthetic user, requests need a loopback Host header.

/** @returns {null | {identify:(req:import('node:http').IncomingMessage) => ({id:string, displayName:string}|null)}} */
export function createDevAuth(_env = process.env) {
  return null;
}
