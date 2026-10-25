import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createWorker } from '../src/worker.mjs';
test('periodic sync selects only due owned sources, deduplicates and waits for user action',async t=>{
  let time=Date.parse('2026-10-25T12:00:00Z');
  const store=createStore({dbPath:':memory:',masterKey:randomBytes(32),now:()=>time});t.after(()=>store.close());
  store.ensureUser({id:'1'});const space=store.createSpace('1',{universityId:'hse',name:'HSE'});
  const ready=store.createConnection('1',space.id,{sourceUrl:'https://example.edu/',kind:'website'});
  const auth=store.createConnection('1',space.id,{sourceUrl:'https://sso.example.edu/',kind:'lms'});
  store.updateConnection('1',ready.id,{status:'ready'});store.updateConnection('1',auth.id,{status:'user_action_required'});
  assert.equal(store.listDueConnections().length,0);time+=901_000;
  assert.deepEqual(store.listDueConnections().map(x=>x.id),[ready.id]);
  store.enqueueJob('1',ready.id,{type:'sync'});assert.equal(store.listDueConnections().length,0);
  let count=0;
  const worker=createWorker({store,now:()=>time,createSources:guarded=>({sync:async({userId,connectionId})=>{
    count++;guarded.updateConnection(userId,connectionId,{status:'ready'});return {status:'ready'};
  }})});
  await worker.tick();await worker.tick();assert.equal(count,1);
  time+=901_000;await worker.tick();assert.equal(count,2);
  store.deleteSpace('1',space.id);assert.equal(store.listDueConnections().length,0);await worker.stop();
});
test('explicit reconnect cancels old worker and removes former account snapshots and search documents',t=>{
  const store=createStore({dbPath:':memory:',masterKey:randomBytes(32)});t.after(()=>store.close());
  store.ensureUser({id:'1'});const space=store.createSpace('1',{universityId:'hse',name:'HSE'});
  const connection=store.createConnection('1',space.id,{sourceUrl:'https://example.edu/',kind:'lms'});
  store.putSnapshot('1',connection.id,{kind:'courses',items:[{id:'old'}],fetchedAt:new Date().toISOString(),complete:true});
  store.putDocument('1',space.id,{id:'old',connectionId:connection.id,url:'https://example.edu/doc',title:'Former account',text:'old identity',fetchedAt:new Date().toISOString()});
  store.enqueueJob('1',connection.id,{type:'sync'});const claim=store.claimJob('old');
  store.resetConnectionAuth('1',connection.id,{origin:'https://example.edu',token:'new-identity-token'});
  assert.throws(()=>store.withClaim(claim.id,claim.claimToken,()=>store.setSecret('1',connection.id,{origin:'https://example.edu',token:'stale-token'})),{code:'NOT_FOUND'});
  assert.equal(store.listSnapshots('1',space.id).length,0);assert.equal(store.searchDocuments('1',space.id,'identity').length,0);
  assert.equal(store.readSecret('1',connection.id).token,'new-identity-token');
});
