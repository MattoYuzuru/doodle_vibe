import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { AppError } from './errors.mjs';
import { verifyTelegramInitData } from './auth.mjs';
import { createChatService } from './chat.mjs';
import { buildSecret, AUTH_FIELDS } from './auth-input.mjs';
import { authMethodsFor } from './sources/presets.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(body, allowed) {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new AppError('INVALID_INPUT');
  return body;
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('INVALID_INPUT');
  return value.trim();
}
async function readBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError('JSON_REQUIRED',415);
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65_536) throw new AppError('BODY_TOO_LARGE',413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('INVALID_JSON'); }
}
function publicConnection(record) {
  const {userId, ...connection} = record;
  return connection;
}
function sameSecret(a,b) {
  const left=Buffer.from(a||''),right=Buffer.from(b||'');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left,right);
}

export function createApp({store, config, createSources, model = null, retrieveWeb, staticDir, oauth = null, onLog = () => {}, onTelegram = null, now = Date.now}) {
  const chat = createChatService({store,model,retrieveWeb,now});
  const counters = new Map();
  function limit(userId, bucket, maximum) {
    const key = `${userId}:${bucket}`, time = now();
    let entry = counters.get(key);
    if (!entry || entry.until <= time) { entry = {count:0,until:time+60_000}; counters.set(key,entry); }
    if (++entry.count > maximum) throw new AppError('RATE_LIMITED',429);
    if (counters.size > 20_000) for (const [id,item] of counters) if(item.until <= time) counters.delete(id);
  }
  const send = (res,status,value,requestId) => {
    res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
      'x-content-type-options':'nosniff','x-request-id':requestId});
    res.end(JSON.stringify(value));
  };
  // Credential forms the executor supports for this origin, then operator OAuth providers.
  const authMethods = connection => [...authMethodsFor(store,connection),...(oauth?.methods(connection)||[])];
  async function handler(req,res) {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') {
        return send(res,200,{status:'ok',version:config.version,ready:Boolean(config.botToken),
          components:{database:true,telegram:Boolean(config.botToken),model:Boolean(model)}},requestId);
      }
      if (path === '/api/telegram/webhook' && req.method === 'POST') {
        if (!onTelegram || !sameSecret(req.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) throw new AppError('NOT_FOUND',404);
        const reply=await onTelegram(await readBody(req));
        return send(res,200,reply||{ok:true},requestId);
      }
      if (path === '/api/v1/oauth/callback' && req.method === 'GET' && oauth) {
        const cookies = (req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Secure-doodle-oauth='));
        const browserBinding=cookies.length===1?cookies[0].slice('__Secure-doodle-oauth='.length):undefined;
        await oauth.complete(url.searchParams,{browserBinding});
        res.setHeader('set-cookie','__Secure-doodle-oauth=; Path=/api/v1/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});
        return res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Doodle</title><p>Подключение сохранено. Вернись в Telegram и обнови данные.</p></html>');
      }
      if (!path.startsWith('/api/')) {
        if (!staticDir || !['GET','HEAD'].includes(req.method)) throw new AppError('NOT_FOUND',404);
        const root = resolve(staticDir);
        let file = resolve(root, '.' + decodeURIComponent(path));
        if (file !== root && !file.startsWith(root+sep)) throw new AppError('NOT_FOUND',404);
        try { if (!(await stat(file)).isFile()) file = resolve(root,'index.html'); }
        catch { if (extname(path)) throw new AppError('NOT_FOUND',404); file = resolve(root,'index.html'); }
        const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css',
          '.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.json':'application/json'};
        let content; try { content = await readFile(file); } catch { throw new AppError('NOT_FOUND',404); }
        res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','x-content-type-options':'nosniff',
          'referrer-policy':'strict-origin-when-cross-origin','cache-control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (req.headers.origin && req.headers.origin !== config.publicBaseUrl) throw new AppError('ORIGIN_REJECTED',403);
      const identity = verifyTelegramInitData(req.headers['x-telegram-init-data'],config.botToken,{now});
      store.ensureUser(identity);
      const userId = identity.id;
      limit(userId,'api',120);
      if (path === '/api/v1/me' && req.method === 'GET') return send(res,200,{user:store.getUser(userId),spaces:store.listSpaces(userId)},requestId);
      if (path === '/api/v1/spaces') {
        if (req.method === 'GET') return send(res,200,{spaces:store.listSpaces(userId)},requestId);
        if (req.method === 'POST') {
          const body = fields(await readBody(req),['universityId','name']);
          if (store.listSpaces(userId).length >= 20) throw new AppError('SPACE_LIMIT',409);
          return send(res,201,{space:store.createSpace(userId,{universityId:text(body.universityId),name:text(body.name)})},requestId);
        }
      }
      let match = path.match(/^\/api\/v1\/spaces\/([^/]+)(?:\/(connections|schedule|deadlines|courses|documents|faq|chat))?$/);
      if (match) {
        const [,spaceId,resource] = match;
        const space = store.getSpace(userId,spaceId);
        if (!resource && req.method === 'GET') return send(res,200,{space},requestId);
        if (!resource && req.method === 'DELETE') return send(res,200,store.deleteSpace(userId,spaceId),requestId);
        if (resource === 'connections') {
          if (req.method === 'GET') return send(res,200,{connections:store.listConnections(userId,spaceId).map(publicConnection)},requestId);
          if (req.method === 'POST') {
            limit(userId,'jobs',15);
            const body = fields(await readBody(req),['sourceUrl','kind','label']);
            if (store.listConnections(userId,spaceId).length >= 30) throw new AppError('CONNECTION_LIMIT',409);
            const sourceUrl = text(body.sourceUrl,2048);
            const parsed = new URL(sourceUrl);
            // Full DNS/IP/redirect checks happen in the executor before every request.
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new AppError('UNSAFE_SOURCE_URL');
            if (!['lms','schedule','document','table','website'].includes(body.kind)) throw new AppError('INVALID_SOURCE_KIND');
            const connection = store.createConnection(userId,spaceId,{sourceUrl:parsed.href,kind:body.kind,label:body.label === undefined?'':text(body.label)});
            const job = store.enqueueJob(userId,connection.id,{type:'discover'});
            return send(res,202,{connection:publicConnection(connection),job},requestId);
          }
        }
        if (['schedule','deadlines','courses'].includes(resource) && req.method === 'GET') {
          const snapshots = store.listSnapshots(userId,spaceId,{kind:resource});
          return send(res,200,{spaceId,items:snapshots.flatMap(s => s.items),sources:snapshots.map(s=>({connectionId:s.connectionId,fetchedAt:s.fetchedAt,
            stale:now()-Date.parse(s.fetchedAt)>24*3600_000})),connections:store.listConnections(userId,spaceId).map(publicConnection)},requestId);
        }
        if (['documents','faq'].includes(resource) && req.method === 'GET') {
          const query = url.searchParams.get('q');
          const documents = query ? store.searchDocuments(userId,spaceId,query,{limit:20}) : store.listDocuments(userId,spaceId,{limit:20});
          return send(res,200,{documents,kind:'source_documents'},requestId);
        }
        if (resource === 'chat') {
          if (req.method === 'GET') return send(res,200,{messages:store.listMessages(userId,spaceId,{limit:50})},requestId);
          if (req.method === 'POST') {
            limit(userId,'chat',8);
            const body = fields(await readBody(req),['text']);
            return send(res,200,await chat.ask(userId,spaceId,body.text),requestId);
          }
        }
      }
      match = path.match(/^\/api\/v1\/connections\/([^/]+)(?:\/(auth|sync|discover|oauth))?$/);
      if (match) {
        const [,connectionId,action] = match;
        const connection = store.getConnection(userId,connectionId);
        if (!action && req.method === 'GET') return send(res,200,{connection:publicConnection(connection),authMethods:authMethods(connection)},requestId);
        if (!action && req.method === 'DELETE') return send(res,200,store.deleteConnection(userId,connectionId),requestId);
        if (action === 'auth' && req.method === 'POST') {
          limit(userId,'jobs',15);
          const secret = buildSecret(fields(await readBody(req),AUTH_FIELDS),connection.sourceUrl);
          store.resetConnectionAuth(userId,connectionId,secret);
          const job = store.enqueueJob(userId,connectionId,{type:'sync'});
          return send(res,202,{saved:true,job},requestId);
        }
        if (action === 'oauth' && req.method === 'POST') {
          if (!oauth) throw new AppError('OAUTH_NOT_CONFIGURED',409);
          const body = fields(await readBody(req),['providerId']);
          const {browserBinding,...flow}=oauth.begin(userId,connectionId,text(body.providerId));
          res.setHeader('set-cookie',`__Secure-doodle-oauth=${browserBinding}; Path=/api/v1/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
          return send(res,200,flow,requestId);
        }
        if (['sync','discover'].includes(action) && req.method === 'POST') {
          limit(userId,'jobs',15);
          fields(await readBody(req),[]);
          return send(res,202,{job:store.enqueueJob(userId,connectionId,{type:action})},requestId);
        }
      }
      match = path.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (match && req.method === 'GET') return send(res,200,{job:store.getJob(userId,match[1])},requestId);
      // Only read compatibility is retained. The multi-university UI uses /api/v1.
      if (path === '/api/me' && req.method === 'GET') {
        const spaces = store.listSpaces(userId);
        const ready = spaces.flatMap(s=>store.listConnections(userId,s.id)).some(c=>c.status==='ready');
        return send(res,200,{tgId:Number(userId),loggedIn:ready,moodle:ready?{fullName:identity.displayName}:null,
          group:null,groupCandidates:[],subgroup:'1',variant:null,labsAllowed:false,labsOff:true,labTrial:null,
          labRequest:null,isOwner:false,courseOverrides:{},shareRemarks:false,quota:null,spaces,platformApi:'/api/v1'},requestId);
      }
      throw new AppError('NOT_FOUND',404);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      const status = error instanceof AppError ? error.status : 500;
      onLog({requestId,code,status});
      if (!res.headersSent) send(res,status,{error:{code,requestId}},requestId);
      else res.end();
    }
  }
  const server = createServer((req,res) => void handler(req,res));
  server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  return server;
}
