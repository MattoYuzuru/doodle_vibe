import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// Node 24 emits top-level testcases directly under testsuites. Put these fixtures
// in a JUnit suite so CI readers can count actual cases, failures and skips.
const reportPath=resolve(root,'artifacts/platform/junit.xml');
try {
  const xml=readFileSync(reportPath,'utf8');
  if(!xml.includes('<testcase ')) throw new Error('No platform test cases in report');
  writeFileSync(reportPath,xml.replace('<testsuites>','<testsuites><testsuite name="platform">')
    .replace('</testsuites>','</testsuite></testsuites>'));
} catch { console.error('Platform JUnit report is missing or empty');process.exitCode=1; }
if(!process.exitCode) process.exitCode=child.status??1;
