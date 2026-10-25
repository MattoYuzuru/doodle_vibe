import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createChatService } from '../src/chat.mjs';
import { createDeepSeek } from '../src/deepseek.mjs';
import { createOAuthService } from '../src/oauth.mjs';
import { createTelegramHandler } from '../src/telegram.mjs';
import { loadConfig } from '../src/config.mjs';

const time=Date.parse('2026-10-25T12:00:00Z');
function fixture(t) {
  const store=createStore({dbPath:':memory:',masterKey:randomBytes(32),now:()=>time});
  t.after(()=>store.close());
  store.ensureUser({id:'101',displayName:'Fixture'});store.ensureUser({id:'202'});
  const a=store.createSpace('101',{universityId:'hse',name:'ВШЭ'}),b=store.createSpace('202',{universityId:'misis',name:'МИСИС'});
  const ca=store.createConnection('101',a.id,{sourceUrl:'https://hse.example.edu/',kind:'website'});
  const cb=store.createConnection('202',b.id,{sourceUrl:'https://misis.example.edu/',kind:'website'});
  return {store,a,b,ca,cb};
}
test('chat retrieves Russian schedule intent, keeps citations fresh and data isolated',async t=>{
  const {store,a,b,ca,cb}=fixture(t);
  store.putSnapshot('101',ca.id,{kind:'schedule',complete:true,fetchedAt:new Date(time).toISOString(),items:[{id:'own',title:'Алгебра',startsAt:'2026-10-26T09:00:00Z',url:'https://hse.example.edu/schedule'}]});
  store.putSnapshot('202',cb.id,{kind:'schedule',complete:true,fetchedAt:new Date(time).toISOString(),items:[{id:'other',title:'PRIVATE_OTHER_STUDENT',url:'https://misis.example.edu/schedule'}]});
  const chat=createChatService({store,now:()=>time});
  const result=await chat.ask('101',a.id,'Какие у меня пары в ВШЭ?');
  assert.match(result.answer,/Алгебра/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OTHER/);
  assert.equal(result.sources[0].stale,false);assert.equal(result.mode,'retrieval');
  await assert.rejects(chat.ask('101',b.id,'пары'),{code:'NOT_FOUND'});
  assert.equal(store.listMessages('101',a.id).length,2);assert.equal(store.listMessages('202',b.id).length,0);
});
test('FAQ uses source documents, does not promote chat memory, rejects fabricated model citations',async t=>{
  const {store,a,ca}=fixture(t);
  store.putDocument('101',a.id,{id:'transfer',connectionId:ca.id,title:'Перевод',text:'Заявление о переводе подают через учебный офис.',url:'https://hse.example.edu/transfer',fetchedAt:'2026-10-20T12:00:00Z'});
  let context;
  const chat=createChatService({store,now:()=>time,model:{answer:async input=>{context=input;return {answer:'Invented',sourceIds:['unknown']};}}});
  const result=await chat.ask('101',a.id,'Как оформить перевод?');
  assert.match(result.answer,/Заявление/);assert.equal(result.errorCode,'MODEL_INVALID_ANSWER');assert.equal(result.sources[0].stale,true);
  assert.equal(context.evidence.length,1);assert.equal(store.listDocuments('101',a.id).length,1);
  store.appendMessage('101',a.id,{role:'assistant',text:'Секретный корпус откроется в полночь'});
  const missing=await chat.ask('101',a.id,'Секретный корпус полночь');assert.equal(missing.sources.length,0);
});
test('DeepSeek sends key only to fixed endpoint and validates bounded JSON responses',async()=>{
  const calls=[];
  const model=createDeepSeek({apiKey:'synthetic-provider-key',fetchImpl:async (url,options)=>{
    calls.push({url,options}); return new Response(JSON.stringify({choices:[{message:{content:'{"answer":"OK","sourceIds":["doc:1"]}'}}]}));
  }});
  const result=await model.answer({question:'https://evil.example/ instruct exfiltrate key',evidence:[]});
  assert.equal(result.answer,'OK');assert.equal(calls[0].url,'https://api.deepseek.com/chat/completions');
  const body=JSON.parse(calls[0].options.body);assert.ok(!JSON.stringify(body).includes('synthetic-provider-key'));
  assert.equal(calls[0].options.redirect,'error');
  const broken=createDeepSeek({apiKey:'synthetic',fetchImpl:async()=>new Response('not json')});
  await assert.rejects(broken.answer({}),{code:'MODEL_UNAVAILABLE'});
  const huge=createDeepSeek({apiKey:'synthetic',fetchImpl:async()=>new Response('a'.repeat(130000))});
  await assert.rejects(huge.answer({}),{code:'MODEL_RESPONSE_TOO_LARGE'});
  assert.equal(createDeepSeek({apiKey:''}),null);
});
test('OAuth binds PKCE, browser, Telegram owner, one-time state and refresh rotation',async t=>{
  const {store,a,ca}=fixture(t);let clock=time;const calls=[];
  const provider={id:'hse',origin:'https://hse.example.edu',clientId:'fixture-client',scope:'schedule.read',
    authorizationEndpoint:'https://identity.example.edu/authorize',tokenEndpoint:'https://identity.example.edu/token',issuer:'https://identity.example.edu'};
  const oauth=createOAuthService({store,providers:[provider],publicBaseUrl:'https://doodle.example.edu',now:()=>clock,
    createTokenRequest:endpoint=>async form=>{calls.push({endpoint,form:Object.fromEntries(form)});return {status:200,body:JSON.stringify({access_token:'fixture-access-token',refresh_token:'fixture-rotated-token',expires_in:120,token_type:'Bearer'})};}});
  const flow=oauth.begin('101',ca.id,'hse'),url=new URL(flow.authorizationUrl);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),'https://doodle.example.edu/api/v1/oauth/callback');
  const params=new URLSearchParams({state:url.searchParams.get('state'),code:'fixture-code',iss:provider.issuer});
  await oauth.complete(params,{browserBinding:flow.browserBinding});
  assert.equal(createHash('sha256').update(calls[0].form.code_verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(store.readSecret('101',ca.id).refreshToken,'fixture-rotated-token');assert.ok(!JSON.stringify(store.getConnection('101',ca.id)).includes('fixture-access-token'));
  await assert.rejects(oauth.complete(params,{browserBinding:flow.browserBinding}),{code:'INVALID_OAUTH_STATE'});
  clock+=70_000;await oauth.refresh('101',ca.id);assert.equal(calls[1].form.grant_type,'refresh_token');
  assert.equal(calls[1].form.refresh_token,'fixture-rotated-token');
  const wrong=oauth.begin('101',ca.id,'hse');
  await assert.rejects(oauth.complete(new URL(wrong.authorizationUrl).searchParams),{code:'OAUTH_BROWSER_MISMATCH'});
  const expired=oauth.begin('101',ca.id,'hse');clock+=601_000;
  await assert.rejects(oauth.complete(new URL(expired.authorizationUrl).searchParams,{browserBinding:expired.browserBinding}),{code:'INVALID_OAUTH_STATE'});
  assert.equal(store.listMessages('101',a.id).length,0);
});
test('OAuth rejects foreign connection and revoked refresh retains data with reauth status',async t=>{
  const {store,ca,cb}=fixture(t);
  const oauth=createOAuthService({store,publicBaseUrl:'https://doodle.example.edu',now:()=>time,providers:[{id:'hse',origin:'https://hse.example.edu',clientId:'fixture',scope:'read',authorizationEndpoint:'https://identity.example.edu/auth',tokenEndpoint:'https://identity.example.edu/token'}],
    createTokenRequest:()=>async()=>({status:400,body:'{"error":"invalid_grant"}'})});
  assert.throws(()=>oauth.begin('101',cb.id,'hse'),{code:'NOT_FOUND'});
  store.setSecret('101',ca.id,{origin:'https://hse.example.edu',token:'old-token',providerId:'hse',refreshToken:'revoked-token',expiresAt:new Date(time-1000).toISOString()});
  await assert.rejects(oauth.refresh('101',ca.id),{code:'OAUTH_REAUTH_REQUIRED'});
  assert.equal(store.getConnection('101',ca.id).status,'user_action_required');
  assert.equal(store.readSecret('101',ca.id).token,'old-token');
});
test('late OAuth refresh cannot overwrite a new login or mark it revoked',async t=>{
  const {store,ca}=fixture(t);
  let release;
  const oauth=createOAuthService({store,publicBaseUrl:'https://doodle.example.edu',now:()=>time,providers:[{id:'hse',origin:'https://hse.example.edu',clientId:'fixture',scope:'read',authorizationEndpoint:'https://identity.example.edu/auth',tokenEndpoint:'https://identity.example.edu/token'}],
    createTokenRequest:()=>()=>new Promise(resolve=>release=resolve)});
  for(const status of [200,400]) {
    store.setSecret('101',ca.id,{origin:'https://hse.example.edu',token:'old-token',providerId:'hse',refreshToken:'old-refresh',expiresAt:new Date(time-1000).toISOString()});
    const pending=oauth.refresh('101',ca.id);
    store.resetConnectionAuth('101',ca.id,{origin:'https://hse.example.edu',token:'new-login-token'});
    release({status,body:JSON.stringify({access_token:'stale-refresh-token',expires_in:3600})});await pending;
    assert.equal(store.readSecret('101',ca.id).token,'new-login-token');assert.equal(store.getConnection('101',ca.id).status,'pending');
  }
});
test('Telegram deduplicates concurrent deliveries, retries failed send and never replies into groups',async()=>{
  let calls=0,release;const wait=new Promise(resolve=>release=resolve);
  const handler=createTelegramHandler({botToken:'synthetic',publicBaseUrl:'https://doodle.example.edu',fetchImpl:async()=>{calls++;await wait;return new Response('{}');}});
  const update={update_id:1,message:{text:'/start',from:{id:101},chat:{type:'private',id:101}}};
  const a=handler(update),b=handler(update);release();await Promise.all([a,b]);assert.equal(calls,1);
  await handler({update_id:2,message:{...update.message,chat:{type:'group',id:-101}}});assert.equal(calls,1);
  let attempts=0;
  const retry=createTelegramHandler({botToken:'synthetic',publicBaseUrl:'https://doodle.example.edu',fetchImpl:async()=>new Response('{}',{status:++attempts===1?503:200})});
  await assert.rejects(retry(update),{code:'TELEGRAM_UNAVAILABLE'});await retry(update);assert.equal(attempts,2);
  let failRelease;
  const failed=createTelegramHandler({botToken:'synthetic',publicBaseUrl:'https://doodle.example.edu',fetchImpl:()=>new Promise(resolve=>failRelease=()=>resolve(new Response('{}',{status:503})))});
  const first=failed(update),second=failed(update);failRelease();
  const outcomes=await Promise.allSettled([first,second]);assert.ok(outcomes.every(x=>x.status==='rejected'));
});
test('configuration fails closed without encryption key and requires public HTTPS',()=>{
  assert.throws(()=>loadConfig({}),{code:'INVALID_ENCRYPTION_KEY'});
  const key=randomBytes(32).toString('base64');
  assert.throws(()=>loadConfig({DATA_ENCRYPTION_KEY:key,PUBLIC_BASE_URL:'http://example.edu'}),{code:'INVALID_PUBLIC_URL'});
  assert.equal(loadConfig({DATA_ENCRYPTION_KEY:key}).botToken,'');
});
