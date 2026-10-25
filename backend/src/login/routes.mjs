// HTTP and WebSocket routes of the login sessions (task A of docs/architecture/auth-sessions-contract.md).
// `handle` returns true when it answered the request; `upgrade` is wired to server 'upgrade' events.
// Identity is verified by http.mjs before `handle`; ownership of the connection/session is checked by the manager.
import { AppError } from '../errors.mjs';
import { acceptWebSocket } from './websocket.mjs';

/**
 * @typedef {object} LoginRouteContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {string} userId
 * @property {string} requestId
 * @property {(res:import('node:http').ServerResponse, status:number, value:unknown, requestId:string) => void} send
 * @property {() => Promise<unknown>} readBody
 */
const START_FIELDS = ['mode', 'username', 'password', 'keepCalendar'];

export function createLoginRoutes({ login, config = {}, origins = [] } = {}) {
  const allowedOrigins = () => new Set([config.publicBaseUrl, ...origins].filter(Boolean));
  const emptyBody = async ctx => {
    const body = await ctx.readBody();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AppError('INVALID_INPUT');
  };
  return {
    async handle(ctx) {
      if (!login) return false;
      const { req, res, url, userId, requestId, send } = ctx;
      const start = /^\/api\/v1\/connections\/([^/]+)\/login$/.exec(url.pathname);
      if (start && req.method === 'POST') {
        const body = await ctx.readBody();
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !START_FIELDS.includes(key))) throw new AppError('INVALID_INPUT');
        if (body.mode === 'interactive' && START_FIELDS.slice(1).some(key => key in body)) throw new AppError('INVALID_INPUT');
        if (body.keepCalendar !== undefined && typeof body.keepCalendar !== 'boolean') throw new AppError('INVALID_INPUT');
        send(res, 201, { login: await login.start(userId, start[1], body) }, requestId);
        return true;
      }
      const match = /^\/api\/v1\/login\/([^/]+)(?:\/(mfa|handoff|done|cancel|ticket))?$/.exec(url.pathname);
      if (!match) return false;
      const [, loginId, action] = match;
      if (!action && req.method === 'GET') { send(res, 200, { login: login.get(userId, loginId) }, requestId); return true; }
      if (req.method !== 'POST' || !action) return false;
      if (action === 'mfa') {
        const body = await ctx.readBody();
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'code')) throw new AppError('INVALID_INPUT');
        send(res, 202, { login: await login.submitMfa(userId, loginId, body.code) }, requestId);
        return true;
      }
      await emptyBody(ctx);
      if (action === 'ticket') send(res, 200, login.issueTicket(userId, loginId), requestId);
      else send(res, 200, { login: await login[action](userId, loginId) }, requestId);
      return true;
    },
    // Ticket is single use and bound to the session; Origin must be the app itself.
    upgrade(req, socket, head) {
      const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`); };
      let url; try { url = new URL(req.url, 'http://localhost'); } catch { return reject('400 Bad Request'); }
      const match = /^\/api\/v1\/login\/([^/]+)\/stream$/.exec(url.pathname);
      if (!login || !match) return reject('404 Not Found');
      if (!allowedOrigins().has(req.headers.origin)) return reject('403 Forbidden');
      const identity = login.consumeTicket(url.searchParams.get('ticket'), match[1]);
      if (!identity) return reject('401 Unauthorized');
      let controller = null; let socketApi = null;
      const sink = {
        frame: data => socketApi?.sendBinary(data), json: value => socketApi?.sendText(JSON.stringify(value)),
        close: reason => { try { socketApi?.sendText(JSON.stringify({ type: 'closed', reason })); } catch { /* ignore */ } socketApi?.close(1000); },
        get buffered() { return socketApi?.buffered ?? 0; },
      };
      socketApi = acceptWebSocket(req, socket, head, {
        maxMessage: 8192,
        onMessage: (kind, data) => {
          if (kind !== 'text' || !controller) return;
          let message; try { message = JSON.parse(data.toString('utf8')); } catch { return; }
          void controller.input(message);
        },
        onClose: () => controller?.detach(),
      });
      if (!socketApi) return;
      try { controller = login.attach(identity.userId, identity.loginId, sink); } catch { controller = null; }
      if (!controller) socketApi.close(1008);
    },
  };
}
