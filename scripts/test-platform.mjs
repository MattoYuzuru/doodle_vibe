import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=resolve(root,'backend/test');
const files=readdirSync(directory).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>resolve(directory,x));
if(!files.length) throw new Error('No platform test files');
mkdirSync(resolve(root,'artifacts/platform'),{recursive:true});
const env={};
for(const key of ['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot','CI','NO_COLOR']) if(process.env[key]) env[key]=process.env[key];
const child=spawnSync(process.execPath,['--test','--test-reporter=spec','--test-reporter-destination=stdout',
  '--test-reporter=junit','--test-reporter-destination=artifacts/platform/junit.xml',...files],
  {cwd:root,env,stdio:'inherit',timeout:120_000});
if(child.error) console.error('Platform test process failed:',child.error.code);
process.exitCode=child.status??1;
