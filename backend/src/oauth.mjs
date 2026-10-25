import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.mjs';

const digest = value => createHash('sha256').update(value).digest('base64url');
const secureUrl = value => {
  const url = new URL(value);
  if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AppError('INVALID_OAUTH_PROVIDER',500);
  return url.href;
};

// Providers are operator configuration, never discovered client registrations.
// This grants access to a configured resource, not an identity inferred from id_token.
export function createOAuthService({store, providers = [], publicBaseUrl, createTokenRequest, now = Date.now}) {
  if (!providers.length) return null;
  const callback = new URL('/api/v1/oauth/callback',secureUrl(publicBaseUrl)).href;
  const entries = new Map();
  for(const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(provider.id) || entries.has(provider.id) ||
        typeof provider.clientId !== 'string' || !provider.clientId || typeof provider.scope !== 'string') throw new AppError('INVALID_OAUTH_PROVIDER',500);
    const origin = new URL(secureUrl(provider.origin)).origin;
    entries.set(provider.id,{...provider,origin,authorizationEndpoint:secureUrl(provider.authorizationEndpoint),
      tokenRequest:createTokenRequest(secureUrl(provider.tokenEndpoint))});
  }
  const states = new Map();
  function secretFromResponse(provider, body, previous = {}) {
    if(typeof body.access_token!=='string' || !/^[A-Za-z0-9._~+\/=-]{8,8192}$/.test(body.access_token) ||
      (body.token_type && body.token_type.toLowerCase()!=='bearer')) throw new AppError('OAUTH_EXCHANGE_FAILED',502);
    const secret={origin:provider.origin,token:body.access_token,providerId:provider.id};
    if(typeof body.refresh_token==='string' && body.refresh_token.length<=16000) secret.refreshToken=body.refresh_token;
    else if(previous.refreshToken) secret.refreshToken=previous.refreshToken;
    if(Number.isFinite(body.expires_in) && body.expires_in>0) secret.expiresAt=new Date(now()+Math.min(body.expires_in,31536000)*1000).toISOString();
    return secret;
  }
  return {
    methods(connection) {
      return [...entries.values()].filter(p=>p.origin===new URL(connection.sourceUrl).origin).map(p=>({id:p.id,type:'oauth',label:p.label||p.id}));
    },
    begin(userId,connectionId,providerId) {
      const connection=store.getConnection(userId,connectionId),provider=entries.get(providerId);
      if(!provider || provider.origin!==new URL(connection.sourceUrl).origin) throw new AppError('OAUTH_PROVIDER_UNAVAILABLE',409);
      for(const [key,state] of states) if(state.until<=now()) states.delete(key);
      if(states.size>=1000) throw new AppError('OAUTH_BUSY',429);
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),browserBinding=randomBytes(32).toString('base64url');
      states.set(digest(state),{userId,connectionId,providerId,verifier,browserDigest:digest(browserBinding),until:now()+10*60_000});
      const authorizationUrl=new URL(provider.authorizationEndpoint);
      for(const [key,value] of Object.entries({response_type:'code',client_id:provider.clientId,redirect_uri:callback,
        scope:provider.scope,state,code_challenge:digest(verifier),code_challenge_method:'S256'})) authorizationUrl.searchParams.set(key,value);
      return {authorizationUrl:authorizationUrl.href,expiresAt:new Date(now()+10*60_000).toISOString(),browserBinding};
    },
    async complete(params,{browserBinding} = {}) {
      for(const key of ['state','code','error','iss']) if(params.getAll(key).length>1) throw new AppError('INVALID_OAUTH_CALLBACK');
      const raw=params.get('state');
      if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new AppError('INVALID_OAUTH_STATE');
      const state=states.get(digest(raw)); states.delete(digest(raw));
      if(!state || state.until<=now()) throw new AppError('INVALID_OAUTH_STATE');
      if(typeof browserBinding!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(browserBinding)||digest(browserBinding)!==state.browserDigest) throw new AppError('OAUTH_BROWSER_MISMATCH');
      if(params.has('error')) throw new AppError('OAUTH_ACCESS_DENIED',409);
      const code=params.get('code');
      if(!code || code.length>8192) throw new AppError('INVALID_OAUTH_CALLBACK');
      const provider=entries.get(state.providerId);
      // When configured, RFC9207 issuer must match; provider/state already binds token endpoint.
      if(provider.issuer && params.get('iss')!==provider.issuer) throw new AppError('OAUTH_ISSUER_MISMATCH');
      store.getConnection(state.userId,state.connectionId);
      const form=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callback,
        client_id:provider.clientId,code_verifier:state.verifier});
      if(provider.clientSecret) form.set('client_secret',provider.clientSecret);
      let response,body;
      try { response=await provider.tokenRequest(form); body=JSON.parse(response.body); }
      catch { throw new AppError('OAUTH_EXCHANGE_FAILED',502); }
      if(response.status!==200) throw new AppError('OAUTH_EXCHANGE_FAILED',502);
      const secret=secretFromResponse(provider,body);
      store.resetConnectionAuth(state.userId,state.connectionId,secret);
      store.enqueueJob(state.userId,state.connectionId,{type:'sync'});
      return {saved:true};
    },
    async refresh(userId,connectionId,{storage=store} = {}) {
      const connection=storage.getConnection(userId,connectionId);
      const secret=storage.readSecret(userId,connectionId);
      if(!secret?.providerId || !secret.expiresAt || Date.parse(secret.expiresAt)>now()+60_000) return;
      const provider=entries.get(secret.providerId);
      if(!provider || provider.origin!==new URL(connection.sourceUrl).origin || !secret.refreshToken) {
        storage.withCurrentSecret(userId,connectionId,secret,()=>storage.updateConnection(userId,connectionId,{status:'user_action_required',errorCode:'OAUTH_REAUTH_REQUIRED'}));
        throw new AppError('OAUTH_REAUTH_REQUIRED',409);
      }
      const form=new URLSearchParams({grant_type:'refresh_token',refresh_token:secret.refreshToken,client_id:provider.clientId});
      if(provider.clientSecret) form.set('client_secret',provider.clientSecret);
      let response,body;
      try { response=await provider.tokenRequest(form); body=JSON.parse(response.body); }
      catch { throw new AppError('OAUTH_REFRESH_UNAVAILABLE',503); }
      if(response.status===400 || response.status===401) {
        const applied=storage.withCurrentSecret(userId,connectionId,secret,()=>storage.updateConnection(userId,connectionId,{status:'user_action_required',errorCode:'OAUTH_REAUTH_REQUIRED'}));
        if(!applied) return;
        throw new AppError('OAUTH_REAUTH_REQUIRED',409);
      }
      if(response.status!==200) throw new AppError('OAUTH_REFRESH_UNAVAILABLE',503);
      storage.withCurrentSecret(userId,connectionId,secret,()=>storage.setSecret(userId,connectionId,secretFromResponse(provider,body,secret)));
    },
  };
}
