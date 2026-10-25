import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { createWorker } from '../src/worker.mjs';
import { createSourceService } from '../src/sources/index.mjs';

const botToken = 'fixture-bot-token-only';
const masterKey = Buffer.alloc(32, 71);
const initialNow = Date.parse('2026-10-25T12:00:00Z');
const origin = 'https://doodle.example';
const reply = (body, status = 200) => ({status, headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const event = { id:'class-1', title:'Fixture mathematics', start:'2026-10-26T09:00:00Z' };
function sign(id, time = initialNow, changes = {}) {
  const params = new URLSearchParams({auth_date:String(Math.floor(time/1000)),user:JSON.stringify({id:Number(id),first_name:`Fixture ${id}`}),...changes});
  const data = [...params].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = createHmac('sha256','WebAppData').update(botToken).digest();
  params.set('hash',createHmac('sha256',secret).update(data).digest('hex'));
  return params.toString();
}
function gate() { let release; const promise = new Promise(resolve => { release=resolve; }); return {promise,release}; }
async function harness(t, {request=async()=>reply({events:[event]}), createSources, clock}={}) {
  const dir=mkdtempSync(join(tmpdir(),'doodle-http-'));
  const dbPath=join(dir,'state.sqlite');
  let time=initialNow, store, server, worker;
  const now=clock??(()=>time);
  const logs=[];
  async function start() {
    store=createStore({dbPath,masterKey,now});
    const sources=createSources??(s=>createSourceService({store:s,request,now}));
    worker=createWorker({store,createSources:sources,onError:e=>logs.push(e)});
    server=createApp({store,config:{botToken,publicBaseUrl:origin,version:'fixture'},createSources:sources,now,onLog:e=>logs.push(e)});
    server.listen(0,'127.0.0.1'); await once(server,'listening');
  }
  async function stop() {
    await worker.stop();
    await new Promise(resolve=>server.close(resolve));
    store.close();
  }
  await start();
  t.after(async()=>{ await stop(); rmSync(dir,{recursive:true,force:true}); });
  const h={
    get store(){return store;},get worker(){return worker;},dbPath,logs,
    setTime(value){time=value;},
    async restart(){await stop();await start();},
    async api(id,path,{method='GET',body,headers={},raw,auth=sign(id,now())}={}) {
      const result=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,
        headers:{...(auth===null?{}:{'x-telegram-init-data':auth}),...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers},
        ...(body===undefined&&raw===undefined?{}:{body:raw??JSON.stringify(body)})});
      return {status:result.status,body:await result.json()};
    },
  };
  return h;
}
async function space(h,id,name='University') {
  const result=await h.api(id,'/api/v1/spaces',{method:'POST',body:{universityId:'fixture-university',name}});
  assert.equal(result.status,201);return result.body.space;
}
async function connection(h,id,sid,sourceUrl='https://university.example/schedule') {
  const result=await h.api(id,`/api/v1/spaces/${sid}/connections`,{method:'POST',body:{sourceUrl,kind:'lms'}});
  assert.equal(result.status,202);return result.body;
}

 test('HTTP verifies real Telegram signatures and rejects missing, forged, expired and duplicate identities',async t=>{
  const h=await harness(t);
  assert.equal((await h.api('1','/api/v1/me')).body.user.id,'1');
  for(const auth of [null,'not-init-data',sign('1').replace('Fixture','Tampered'),sign('1',initialNow-3_601_000),sign('1',initialNow+31_000),sign('1')+'&user=%7B%7D',sign('1',initialNow,{user:'{"id":-1}'})]){
    const result=await h.api('1','/api/v1/me',{auth});assert.equal(result.status,401);assert.equal(result.body.error.code,'UNAUTHORIZED');
  }
  assert.equal((await h.api('1','/api/v1/me',{headers:{origin:'https://attacker.example'}})).status,403);
  assert.ok(h.logs.every(e=>!JSON.stringify(e).includes(botToken)));
});

test('two users and two spaces isolate HTTP reads, mutations, jobs, chat and documents end to end',async t=>{
  const h=await harness(t);
  const spaces=[await space(h,'1','A1'),await space(h,'1','A2'),await space(h,'2','B1'),await space(h,'2','B2')];
  const sources=[];
  for(let i=0;i<spaces.length;i++){
    const user=i<2?'1':'2', s=spaces[i];
    const created=await connection(h,user,s.id);sources.push(created);
    await h.worker.tick();
    assert.equal((await h.api(user,`/api/v1/jobs/${created.job.id}`)).body.job.status,'succeeded');
    const data=await h.api(user,`/api/v1/spaces/${s.id}/schedule`);
    assert.equal(data.body.items.length,1);assert.equal(data.body.items[0].connectionId,created.connection.id);
    h.store.putDocument(user,s.id,{id:'same-external',connectionId:created.connection.id,url:'https://university.example/doc',title:`FAQ ${i}`,text:`library fixture${i}`,fetchedAt:new Date(initialNow).toISOString()});
  }
  assert.notEqual(sources[0].connection.id,sources[1].connection.id);
  const target=spaces[0].id,cid=sources[0].connection.id,jid=sources[0].job.id;
  const attempts=[
    [`/api/v1/spaces/${target}`,'GET'],[`/api/v1/spaces/${target}`,'DELETE'],
    [`/api/v1/spaces/${target}/connections`,'GET'],[`/api/v1/spaces/${target}/connections`,'POST',{sourceUrl:'https://university.example/',kind:'lms'}],
    [`/api/v1/spaces/${target}/schedule`,'GET'],[`/api/v1/spaces/${target}/deadlines`,'GET'],[`/api/v1/spaces/${target}/courses`,'GET'],
    [`/api/v1/spaces/${target}/documents?q=library`,'GET'],[`/api/v1/spaces/${target}/faq`,'GET'],
    [`/api/v1/spaces/${target}/chat`,'GET'],[`/api/v1/spaces/${target}/chat`,'POST',{text:'Расписание'}],
    [`/api/v1/connections/${cid}`,'GET'],[`/api/v1/connections/${cid}`,'DELETE'],
    [`/api/v1/connections/${cid}/sync`,'POST',{}],[`/api/v1/connections/${cid}/discover`,'POST',{}],
    [`/api/v1/connections/${cid}/auth`,'POST',{origin:'https://university.example',token:'synthetic'}],
    [`/api/v1/jobs/${jid}`,'GET'],
  ];
  for(const [path,method,body]of attempts){const result=await h.api('2',path,{method,body});assert.equal(result.status,404,`${method} ${path}`);assert.equal(result.body.error.code,'NOT_FOUND');}
  const chat=await h.api('1',`/api/v1/spaces/${target}/chat`,{method:'POST',body:{text:'Какое расписание?'}});
  assert.equal(chat.status,200);assert.ok(chat.body.sources.length);assert.ok(chat.body.sources.every(s=>s.id.includes(sources[0].connection.id)));
  assert.equal((await h.api('1',`/api/v1/spaces/${spaces[1].id}/chat`)).body.messages.length,0);
  const docs=await h.api('1',`/api/v1/spaces/${target}/documents?q=library`);
  assert.equal(docs.body.documents.length,1);assert.equal(docs.body.documents[0].title,'FAQ 0');
  assert.equal((await h.api('1',`/api/v1/connections/${cid}`,{method:'DELETE'})).status,200);
  assert.equal((await h.api('1',`/api/v1/spaces/${target}/schedule`)).body.items.length,0);
  assert.equal((await h.api('1',`/api/v1/spaces/${target}/documents?q=library`)).body.documents.length,0);
  assert.equal((await h.api('1',`/api/v1/jobs/${jid}`)).status,404);
  assert.equal((await h.api('1',`/api/v1/spaces/${spaces[1].id}/schedule`)).body.items.length,1);
});

test('HTTP enforces JSON structure, bounded request bodies and same-origin writes',async t=>{
  const h=await harness(t);
  for(const [options,status,code]of [
    [{body:{universityId:'fixture',name:'A',admin:true}},400,'INVALID_INPUT'],
    [{raw:'{'},400,'INVALID_JSON'],
    [{raw:'{}',headers:{'content-type':'text/plain'}},415,'JSON_REQUIRED'],
    [{raw:JSON.stringify({name:'x'.repeat(70_000)})},413,'BODY_TOO_LARGE'],
    [{body:{universityId:'fixture',name:'A'},headers:{origin:'https://attacker.example'}},403,'ORIGIN_REJECTED'],
  ]){const result=await h.api('1','/api/v1/spaces',{method:'POST',...options});assert.equal(result.status,status);assert.equal(result.body.error.code,code);}
  assert.equal(h.store.listSpaces('1').length,0);
});

test('HTTP credential flow preserves password bytes; restart reuses encrypted token and failed sync preserves snapshots',async t=>{
  let exchanges=0,broken=false;
  const password=' fixture-password ';
  const request=async(url,options)=>{
    const params=new URLSearchParams(options?.body);
    if(url.endsWith('/login/token.php')){exchanges++;assert.equal(params.get('password'),password);return reply({token:'SYNTHETIC-MOODLE-TOKEN'});}
    if(broken)return reply({},503);
    if(params.get('wsfunction')==='core_webservice_get_site_info')return reply({userid:77});
    if(params.get('wsfunction')==='core_enrol_get_users_courses')return reply([{id:8,fullname:'Fixture Physics'}]);
    if(params.get('wsfunction')==='mod_assign_get_assignments')return reply({courses:[{id:8,assignments:[{id:9,cmid:10,name:'Fixture Homework',duedate:1793010000}]}]});
    throw new Error('Unexpected fixture request');
  };
  const h=await harness(t,{request});const s=await space(h,'1');const created=await connection(h,'1',s.id,'https://newlms.misis.ru/');
  await h.worker.tick();
  const auth=await h.api('1',`/api/v1/connections/${created.connection.id}/auth`,{method:'POST',body:{origin:'https://newlms.misis.ru',username:'fixture',password}});
  assert.equal(auth.status,202);assert.equal(h.store.readSecret('1',created.connection.id).password,password);
  assert.ok(!JSON.stringify(auth.body).includes(password));
  // The HTTP-enqueued sync and encrypted password both survive a process restart.
  await h.restart();await h.worker.tick();
  assert.equal(exchanges,1);assert.equal((await h.api('1',`/api/v1/jobs/${auth.body.job.id}`)).body.job.status,'succeeded');
  const before=(await h.api('1',`/api/v1/spaces/${s.id}/deadlines`)).body.items;
  assert.equal(before.length,1);assert.equal(h.store.readSecret('1',created.connection.id).password,undefined);
  await h.restart();
  const again=await h.api('1',`/api/v1/connections/${created.connection.id}/sync`,{method:'POST',body:{}});
  await h.worker.tick();assert.equal(exchanges,1);assert.equal((await h.api('1',`/api/v1/jobs/${again.body.job.id}`)).body.job.status,'succeeded');
  broken=true;
  const failed=await h.api('1',`/api/v1/connections/${created.connection.id}/sync`,{method:'POST',body:{}});
  await h.worker.tick();
  assert.equal((await h.api('1',`/api/v1/jobs/${failed.body.job.id}`)).body.job.status,'failed');
  assert.deepEqual((await h.api('1',`/api/v1/spaces/${s.id}/deadlines`)).body.items,before);
  const state=await h.api('1',`/api/v1/connections/${created.connection.id}`);
  assert.equal(state.body.connection.status,'error');assert.equal(state.body.connection.errorCode,'source_unavailable');
  assert.ok(!JSON.stringify([state.body,h.logs]).includes('SYNTHETIC-MOODLE-TOKEN'));
});

test('worker cannot commit stale results after durable lease reclamation or connection deletion',async t=>{
  let time=initialNow, pending;
  const h=await harness(t,{clock:()=>time,request:async()=>{pending=gate();await pending.promise;return reply({events:[event]});}});
  const s=await space(h,'1');const created=await connection(h,'1',s.id);
  const tick=h.worker.tick();assert.ok(pending);
  const other=createStore({dbPath:h.dbPath,masterKey,now:()=>time});
  time+=300_001;
  const claim=other.claimJob('replacement',{leaseMs:300_000});assert.equal(claim.id,created.job.id);
  pending.release();await tick;
  assert.equal(h.store.listSnapshots('1',s.id).length,0);
  assert.equal(other.getJob('1',claim.id).status,'running');
  other.withClaim(claim.id,claim.claimToken,()=>other.putSnapshot('1',created.connection.id,{kind:'schedule',items:[{id:'replacement',title:'Fresh'}],fetchedAt:new Date(time).toISOString(),complete:true}));
  other.finishJob(claim.id,claim.claimToken,{status:'succeeded'});other.close();
  assert.equal(h.store.listSnapshots('1',s.id)[0].items[0].id,'replacement');
  const retry=await h.api('1',`/api/v1/connections/${created.connection.id}/sync`,{method:'POST',body:{}});assert.equal(retry.status,202);
  const deleting=h.worker.tick();assert.ok(pending);
  assert.equal((await h.api('1',`/api/v1/connections/${created.connection.id}`,{method:'DELETE'})).status,200);
  pending.release();await deleting;
  assert.equal(h.store.listSnapshots('1',s.id).length,0);
  assert.equal((await h.api('1',`/api/v1/jobs/${retry.body.job.id}`)).status,404);
  assert.ok(h.logs.some(log=>log.code==='STALE_CLAIM'));
});
