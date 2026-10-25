import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createBrowserFactory } from './login/browser.mjs';
import { createLoginSessionManager } from './login/session-manager.mjs';
import { createSourceService } from './sources/index.mjs';
import { terminalIo } from './live-check.mjs';

// Owner-driven check of the login session manager against a real university, without
// Telegram or HTTP. Password mode: the owner types the credentials (hidden) and any MFA code
// in this terminal. Interactive mode with --headed: a visible Chromium window opens and the
// owner signs in by hand (SSO, MFA, CAPTCHA). Only cookie names and counts are printed.
const targets = { hse: { url: 'https://edu.hse.ru/', label: 'ВШЭ' }, cu: { url: 'https://my.centraluniversity.ru/', label: 'Центральный университет' }, elk: { url: 'https://lk.hse.ru/', label: 'ВШЭ (личный кабинет)' } };
const usage = `Проверка входа в вуз (без Telegram и HTTP).

  npm --prefix backend run login -- --env-file <файл> --university hse --mode password
  npm --prefix backend run login -- --env-file <файл> --university cu --mode interactive --headed

Опции: --university hse|elk|cu, --mode password|interactive, --headed (видимое окно Chromium для interactive),
--keep-calendar (сохранить ссылку календаря Moodle), --db <путь> (по умолчанию .live/login-check.sqlite).
Нужны DATA_ENCRYPTION_KEY в файле окружения и Chromium (CHROMIUM_PATH или playwright install chromium).
Логин, пароль и код вводятся в терминале скрыто и не печатаются.`;

export function parseArgs(argv) {
  const options = { university: null, mode: 'password', headed: false, keepCalendar: false, envFile: null, db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; const value = () => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[++i]; };
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--university') options.university = value();
    else if (flag === '--mode') options.mode = value();
    else if (flag === '--headed') options.headed = true;
    else if (flag === '--keep-calendar') options.keepCalendar = true;
    else if (flag === '--env-file') options.envFile = value();
    else if (flag === '--db') options.db = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!['password', 'interactive'].includes(options.mode)) throw new Error('--mode must be password or interactive');
  return options;
}

export async function runLoginCheck({ store, io, university, mode, keepCalendar = false, factory, request, now = Date.now, limits }) {
  const target = targets[university];
  if (!target) { io.print(`Неизвестный вуз «${university}». Доступны: ${Object.keys(targets).join(', ')}`); return { status: 'failed', errorCode: 'unknown_university' }; }
  const userId = 'login-owner';
  store.ensureUser({ id: userId, displayName: 'Login check' });
  const space = store.createSpace(userId, { universityId: university, name: target.label });
  const connection = store.createConnection(userId, space.id, { sourceUrl: target.url, kind: 'lms', label: target.label });
  const manager = createLoginSessionManager({ store, factory, now, limits });
  try {
    if (!manager.capabilities().interactive) { io.print('Chromium не найден: задай CHROMIUM_PATH или выполни npx playwright install chromium.'); return { status: 'failed', errorCode: 'LOGIN_UNAVAILABLE' }; }
    const request0 = mode === 'password'
      ? { mode, username: await io.ask('  логин/почта: '), password: await io.askSecret('  пароль (ввод скрыт): '), ...(keepCalendar ? { keepCalendar: true } : {}) }
      : { mode };
    let login = await manager.start(userId, connection.id, request0);
    request0.password = undefined;
    io.print(`Сессия входа начата (${login.mode}).`);
    let lastStatus = '';
    for (;;) {
      login = manager.get(userId, login.id);
      if (login.status !== lastStatus) { lastStatus = login.status; io.print(`  состояние: ${login.status}${login.errorCode ? ` (${login.errorCode})` : ''}`); }
      if (login.status === 'awaiting_mfa') {
        const code = await io.ask(`  код второго фактора (${login.mfa.kind}, осталось попыток ${login.mfa.attemptsLeft}): `);
        await manager.submitMfa(userId, login.id, code.trim());
      } else if (login.status === 'awaiting_user') {
        io.print(mode === 'interactive' ? '  войди в открывшемся окне; проверка завершится сама' : '  автоматический вход остановлен: нужен человек (включи --headed и режим interactive)');
        if (mode !== 'interactive') { await manager.cancel(userId, login.id); break; }
      } else if (['succeeded', 'failed', 'cancelled', 'expired'].includes(login.status)) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    if (login.status !== 'succeeded') return { status: login.status, errorCode: login.errorCode };
    const { session } = store.readSecret(userId, connection.id);
    io.print(`Сессия сохранена (зашифрована): cookies ${session.cookies.length} [${[...new Set(session.cookies.map(c => c.name))].join(', ')}], bearer ${session.bearer ? `есть (${session.bearer.source})` : 'нет'}, действует до ${session.expiresAt}`);
    // The first sync reads by the stored session (learned recipe, seed or agent) with the same executor the worker uses.
    const sources = createSourceService({ store, request, now });
    const result = await sources.sync({ userId, connectionId: connection.id });
    io.print(`  первая синхронизация по сессии: ${result.status}${result.counts ? ` ${JSON.stringify(result.counts)}` : ''}${result.errorCode ? ` (${result.errorCode})` : ''}`);
    return { status: 'succeeded', cookies: session.cookies.length, bearer: Boolean(session.bearer), calendar: Boolean(session.calendarUrl) };
  } finally { await manager.close(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.university) { process.stdout.write(`${usage}\n`); process.exitCode = options.help ? 0 : 2; return; }
  if (options.envFile) process.loadEnvFile(options.envFile);
  process.umask(0o077);
  const config = loadConfig({ DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY });
  const dbPath = options.db ?? '.live/login-check.sqlite';
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = createStore({ dbPath, masterKey: config.masterKey });
  const io = terminalIo();
  try {
    const factory = createBrowserFactory({ ...(options.headed ? { headless: false } : {}) });
    const result = await runLoginCheck({ store, io, factory, ...options });
    process.exitCode = result.status === 'succeeded' ? 0 : 1;
  } finally { io.close(); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`Проверка остановлена: ${error.code ?? error.message}\n`); process.exitCode = 1; });
}
