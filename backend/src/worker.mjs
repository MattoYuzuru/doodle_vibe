import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

export function createWorker({store, createSources, intervalMs = 1000, workerId = randomUUID(), onError = () => {}, now = Date.now}) {
  let stopped = false, timer, running;
  let lastSchedule = -Infinity;
  async function tick() {
    if (stopped || running) return running;
    running = (async () => {
      if(now()-lastSchedule>=60_000) {
        lastSchedule=now();
        for(const connection of store.listDueConnections({olderThanMs:900_000,limit:20})) {
          store.enqueueJob(connection.userId,connection.id,{type:'sync'});
        }
      }
      const job = store.claimJob(workerId, {leaseMs:300_000});
      if (!job) return;
      const guarded = new Proxy(store, {get(target, name) {
        const value = target[name];
        if (typeof value !== 'function') return value;
        return (...args) => store.withClaim(job.id, job.claimToken, () => value.apply(target,args));
      }});
      const heartbeat = setInterval(() => {
        try { store.renewClaim(job.id,job.claimToken,{leaseMs:300_000}); }
        catch { clearInterval(heartbeat); }
      }, 30_000);
      heartbeat.unref();
      try {
        const sources = createSources(guarded);
        if (!['sync','discover'].includes(job.type)) throw new AppError('UNKNOWN_JOB_TYPE');
        const result = await sources[job.type]({userId:job.userId, connectionId:job.connectionId});
        const failed = result.status === 'error';
        store.finishJob(job.id,job.claimToken,{status:failed?'failed':'succeeded',errorCode:result.errorCode || null,result});
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'SOURCE_UNAVAILABLE';
        try { store.finishJob(job.id,job.claimToken,{status:'failed',errorCode:code,result:null}); } catch { /* Deleted or re-leased job. */ }
        onError({jobId:job.id,code});
      } finally { clearInterval(heartbeat); }
    })();
    try { await running; } finally { running = null; }
  }
  return {
    tick,
    start() { if (timer) return; timer = setInterval(() => void tick().catch(() => onError({code:'WORKER_FAILURE'})),intervalMs); timer.unref(); },
    async stop() { stopped = true; clearInterval(timer); await running; },
  };
}
