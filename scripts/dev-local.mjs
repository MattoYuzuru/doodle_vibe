// One command for the owner: `npm run dev:local` builds the Mini App when needed, starts the new backend with the
// synthetic dev identity (backend/src/dev-auth.mjs) on loopback and opens the universities screen in the default
// browser. State (SQLite + generated key) lives outside the repository, so connections survive restarts.
// No .env is read; real keys (DEEPSEEK_API_KEY, CHROMIUM_PATH) are used only if already in the environment.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'jarvis-app/web');
const args = new Set(process.argv.slice(2));
const port = Number(process.env.DEV_LOCAL_PORT || 18190);
// 18180 is the owner's temporary panel and 4173 is `vite preview`; never take either.
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 18180 || port === 4173) throw new Error('DEV_LOCAL_PORT must be a free unprivileged port other than 18180 and 4173');
const url = `http://127.0.0.1:${port}/#/universities`;
const state = process.env.DEV_LOCAL_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'doodle-dev-local');

function newest(directory) {
  let time = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    time = Math.max(time, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return time;
}
function needsBuild() {
  const built = join(web, 'dist/index.html');
  if (!existsSync(built)) return true;
  const sources = Math.max(newest(join(web, 'src')), statSync(join(web, 'index.html')).mtimeMs, statSync(join(web, 'package.json')).mtimeMs);
  return sources > statSync(built).mtimeMs;
}
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) { console.error(`\n${command} ${commandArgs.join(' ')} failed`); process.exit(result.status ?? 1); }
}
function portFree() {
  return new Promise(done => {
    const probe = createServer().once('error', () => done(false)).once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}
function healthy() {
  return new Promise(done => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, res => { res.resume(); done(res.statusCode === 200); });
    req.on('error', () => done(false)).on('timeout', () => { req.destroy(); done(false); }).end();
  });
}
function open(target) {
  const [command, commandArgs] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : ['xdg-open', [target]];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true }).on('error', () => console.log(`Open ${target} in a browser.`)).unref();
}

if (!existsSync(join(web, 'node_modules')) || !existsSync(join(root, 'backend/node_modules'))) {
  console.log('Installing dependencies (npm run bootstrap)…');
  run('npm', ['run', 'bootstrap']);
}
if (!args.has('--no-build') && needsBuild()) { console.log('Building the Mini App…'); run('npm', ['run', 'build']); }
if (!(await portFree())) { console.error(`Port ${port} is busy. Set DEV_LOCAL_PORT to another free port (not 18180 or 4173).`); process.exit(1); }

mkdirSync(join(state, 'keys'), { recursive: true, mode: 0o700 });
mkdirSync(join(state, 'data'), { recursive: true, mode: 0o700 });
const keyPath = join(state, 'keys/data-encryption.key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
chmodSync(keyPath, 0o600);

// Only what the backend needs plus optional tooling; nothing from the user's shell that looks like a secret.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
for (const key of ['CHROMIUM_PATH', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  DOODLE_DEV_AUTH: '1', HOST: '127.0.0.1', PORT: String(port), APP_VERSION: 'dev-local',
  DATA_ENCRYPTION_KEY: readFileSync(keyPath, 'utf8').trim(), DOODLE_DB_PATH: join(state, 'data/platform.sqlite'),
});
const backend = spawn(process.execPath, ['src/main.mjs'], { cwd: join(root, 'backend'), env, stdio: ['ignore', 'pipe', 'inherit'] });
// Backend log lines are JSON events without bodies; show only the ones that matter locally.
backend.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (/"event":"(started|job_error)"|"status":5\d\d/.test(line)) console.log(line); });
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; backend.kill('SIGTERM'); } };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
backend.on('exit', code => { if (!stopping) console.error(`Backend exited (${code}). See the message above.`); process.exit(stopping ? 0 : code ?? 1); });

for (let i = 0; i < 100 && !(await healthy()); i++) await new Promise(r => setTimeout(r, 150));
if (!(await healthy())) { console.error('Backend did not become healthy.'); stop(); }
else {
  console.log(`\nDoodle (local): ${url}\nSynthetic user, data in ${state}\nChromium for remote login: ${env.CHROMIUM_PATH ? 'CHROMIUM_PATH is set' : 'not configured (remote login is offered only when the backend finds it)'}\nCtrl+C to stop.`);
  if (!args.has('--no-open')) open(url);
}
