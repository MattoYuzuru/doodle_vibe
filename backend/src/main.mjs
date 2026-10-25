import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createDeepSeek } from './deepseek.mjs';
import { createSourceService, createBoundTokenRequest } from './sources/index.mjs';
import { createApp } from './http.mjs';
import { createWorker } from './worker.mjs';
import { createOAuthService } from './oauth.mjs';
import { createTelegramHandler } from './telegram.mjs';
import { createWebRetriever } from './web-retrieval.mjs';
import { createLoginSessionManager } from './login/session-manager.mjs';
import { createLoginRoutes } from './login/routes.mjs';
import { createDevAuth } from './dev-auth.mjs';

async function main() {
  process.umask(0o077);
  const config=loadConfig();
  const store=createStore({dbPath:config.dbPath,masterKey:config.masterKey});
  const model=createDeepSeek({apiKey:config.deepseekKey,model:config.deepseekModel});
  const log=event=>process.stdout.write(JSON.stringify(event)+'\n');
  let providers;
  try { providers=JSON.parse(process.env.OAUTH_PROVIDERS_JSON || '[]'); if(!Array.isArray(providers)) throw new Error(); }
  catch { throw new Error('INVALID_OAUTH_CONFIGURATION'); }
  const oauth=createOAuthService({store,providers,publicBaseUrl:config.publicBaseUrl,createTokenRequest:createBoundTokenRequest});
  const createSources=guardedStore=>{
    const service=createSourceService({store:guardedStore,proposeRecipe:model?.proposeRecipe,proposeLearnedRecipe:model?.proposeLearnedRecipe,agentModel:model});
    return {...service,sync:async args=>{ await oauth?.refresh(args.userId,args.connectionId,{storage:guardedStore}); return service.sync(args); }};
  };
  const login=createLoginSessionManager({store,config});
  const loginRoutes=createLoginRoutes({store,login,config});
  const server=createApp({store,config,createSources,model,oauth,login,loginRoutes,devAuth:createDevAuth(),onLog:log,retrieveWeb:createWebRetriever({store}),
    staticDir:resolve(dirname(fileURLToPath(import.meta.url)),'../..','jarvis-app/web/dist'),
    onTelegram:config.botToken&&config.webhookSecret?createTelegramHandler({publicBaseUrl:config.publicBaseUrl}):null});
  const worker=createWorker({store,createSources,onError:log});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  worker.start(); log({event:'started',version:config.version,ready:Boolean(config.botToken)});
  let shuttingDown=false;
  const shutdown=async()=>{
    if(shuttingDown) return; shuttingDown=true;
    const deadline=setTimeout(()=>process.exit(1),40_000); deadline.unref();
    await Promise.all([worker.stop(),login.close(),new Promise(resolve=>server.close(resolve))]);
    store.close(); clearTimeout(deadline);
  };
  process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
}
main().catch(()=>{process.stderr.write('Backend startup failed; check runtime configuration.\n');process.exitCode=1;});
