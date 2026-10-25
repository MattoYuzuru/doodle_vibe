import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createWorker } from './worker.mjs';
import { createSourceService } from './sources/index.mjs';
import { authMethodsFor, UNIVERSITY_PRESETS } from './sources/presets.mjs';
import { buildSecret } from './auth-input.mjs';

// Local, owner-driven check of the real executors. It uses the same store, jobs,
// worker and source service as the backend, without Telegram or HTTP. Credentials
// are typed by the owner at the terminal (hidden), go straight to encrypted storage
// and are never printed, logged or kept in the process environment.
const hidden = new Set(['password', 'token', 'calendarUrl']);
const userId = 'live-owner';
const hints = {
  source_auth_required: 'нужен вход: данные неверны, ссылка отозвана или система требует SSO без токена',
  source_network_restricted: 'РУЗ отвечает только из сети вуза (Wi‑Fi HSE.Student или VPN); запусти проверку оттуда',
  source_identifier_not_found: 'студент не найден: уточни почту, ФИО или номер из РУЗ',
  source_identifier_ambiguous: 'найдено несколько студентов: введи почту вуза или числовой номер из РУЗ',
  source_lms_unsupported: 'эта LMS распознана, но адаптера для неё пока нет',
  source_mapping_required: 'формат ответа не распознан однозначно',
  source_format_unsupported: 'формат ответа или правило календаря пока не поддерживаются',
  source_response_invalid: 'источник вернул неполный или повреждённый ответ; прежние данные сохранены',
  source_unavailable: 'источник недоступен', source_timeout: 'источник не ответил вовремя',
  source_rate_limited: 'источник просит повторить позже',
};
const hint = code => (code ? `${code}${hints[code] ? ` — ${hints[code]}` : ''}` : '');

export function parseArgs(argv) {
  const options = { universities: [], urls: [], documents: [], envFile: null, db: null, limit: 8, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; const value = () => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[++i]; };
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--env-file') options.envFile = value();
    else if (flag === '--db') options.db = value();
    else if (flag === '--university') options.universities.push(value());
    else if (flag === '--url') options.urls.push(value());
    else if (flag === '--document') options.documents.push(value());
    else if (flag === '--limit') options.limit = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 0 || options.limit > 100) throw new Error('--limit must be 0..100');
  return options;
}

const dateOf = item => item.startsAt ?? item.dueAt ?? '';
export async function runLiveCheck({ store, io, universities = [], urls = [], documents = [], limit = 8, request, now = Date.now }) {
  const report = [];
  store.ensureUser({ id: userId, displayName: 'Live check' });
  const createSources = guarded => createSourceService({ store: guarded, request, now });
  const worker = createWorker({ store, createSources, now });
  async function finish(job) {
    for (let i = 0; i < 4; i++) {
      const current = store.getJob(userId, job.id);
      if (['succeeded', 'failed'].includes(current.status)) return current;
      await worker.tick();
    }
    return store.getJob(userId, job.id);
  }
  async function connect(space, sourceUrl, kind, label) {
    const connection = store.createConnection(userId, space.id, { sourceUrl, kind, label });
    io.print(`\n— ${label}: ${sourceUrl}`);
    let job = await finish(store.enqueueJob(userId, connection.id, { type: 'discover' }));
    let current = store.getConnection(userId, connection.id);
    io.print(`  определение источника: ${current.status}${current.errorCode ? ` (${hint(current.errorCode)})` : ''}`);
    for (let attempt = 0; attempt < 3 && current.status === 'user_action_required' && current.errorCode === 'source_auth_required'; attempt++) {
      const methods = authMethodsFor(store, current);
      if (!methods.length) break;
      io.print('  способы входа:');
      methods.forEach((method, index) => io.print(`   ${index + 1}. ${method.label}${method.note ? ` [${method.note}]` : ''}${method.notes?.length ? ` [${method.notes.join(', ')}]` : ''}`));
      const answer = (await io.ask('  номер способа (Enter — пропустить источник): ')).trim();
      if (!answer) break;
      const method = methods[Number(answer) - 1];
      if (!method) { io.print('  нет такого номера'); continue; }
      const body = { origin: new URL(sourceUrl).origin };
      for (const field of method.fields) body[field] = hidden.has(field) ? await io.askSecret(`  ${field} (ввод скрыт): `) : await io.ask(`  ${field}: `);
      let secret;
      try { secret = buildSecret(body, current.sourceUrl); } catch { io.print('  ввод отклонён проверкой формата'); continue; }
      store.resetConnectionAuth(userId, connection.id, secret);
      job = await finish(store.enqueueJob(userId, connection.id, { type: 'sync' }));
      current = store.getConnection(userId, connection.id);
      io.print(`  синхронизация: ${current.status}${current.errorCode ? ` (${hint(current.errorCode)})` : ''}`);
    }
    if (current.status === 'ready' && job.result?.counts) io.print(`  загружено: ${JSON.stringify(job.result.counts)}`);
    report.push({ label, status: current.status, errorCode: current.errorCode, counts: job.result?.counts ?? null });
  }
  for (const id of universities) {
    const preset = UNIVERSITY_PRESETS.find(item => item.id === id);
    if (!preset) { io.print(`Неизвестный пресет «${id}». Доступны: ${UNIVERSITY_PRESETS.map(item => item.id).join(', ')}`); continue; }
    const space = store.createSpace(userId, { universityId: preset.id, name: preset.name });
    io.print(`\nПространство «${preset.name}» создано.`);
    for (const source of preset.sources) await connect(space, `${source.origin}/`, source.type === 'moodle' ? 'lms' : 'schedule', source.label);
    await show(space);
  }
  if (urls.length || documents.length) {
    const space = store.createSpace(userId, { universityId: 'custom', name: 'Другой вуз' });
    for (const url of urls) await connect(space, url, /\.ics$/i.test(new URL(url).pathname) ? 'schedule' : 'lms', 'Источник по ссылке');
    for (const url of documents) await connect(space, url, 'document', 'Публичная страница');
    await show(space);
  }
  async function show(space) {
    io.print(`\nДанные пространства «${space.name}» (из локальной БД, как их увидит API):`);
    for (const kind of ['schedule', 'deadlines', 'courses']) {
      const items = store.listSnapshots(userId, space.id, { kind }).flatMap(snapshot => snapshot.items);
      io.print(`  ${kind}: ${items.length}`);
      for (const item of items.slice(0, limit)) io.print(`    ${dateOf(item).slice(0, 16).replace('T', ' ')}  ${item.title}${item.location ? ` — ${item.location}` : ''}`);
    }
    const docs = store.listDocuments(userId, space.id, { limit: 100 });
    io.print(`  documents: ${docs.length}`);
    for (const doc of docs.slice(0, limit)) io.print(`    ${doc.title} — ${doc.url}`);
  }
  await worker.stop();
  return report;
}

// Hidden input without echo; the value never touches argv, env, history or logs.
function terminalIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    print: line => process.stdout.write(`${line}\n`),
    ask: question => rl.question(question),
    askSecret: question => new Promise((resolve, reject) => {
      if (!process.stdin.isTTY) { reject(new Error('Secret input needs an interactive terminal')); return; }
      rl.pause(); process.stdout.write(question); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      let value = '';
      const onData = chunk => {
        for (const char of chunk) {
          if (char === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
          if (char === '\r' || char === '\n') { process.stdin.setRawMode(false); process.stdin.off('data', onData); process.stdout.write('\n'); rl.resume(); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else if (char >= ' ') value += char;
        }
      };
      process.stdin.on('data', onData);
    }),
    close: () => rl.close(),
  };
}

const usage = `Локальная проверка источников (без Telegram и HTTP).

  npm --prefix backend run live -- --env-file <файл с DATA_ENCRYPTION_KEY> --university hse
  npm --prefix backend run live -- --env-file <файл> --url https://timetable.example/group.ics
  npm --prefix backend run live -- --env-file <файл> --document https://www.hse.ru/...

Опции: --university <hse|misis> (повторяемо), --url <ссылка LMS или .ics>, --document <публичная страница>,
--db <путь к SQLite, по умолчанию .live/live-check.sqlite>, --limit <сколько записей показать>.
Переменная DATA_ENCRYPTION_KEY — 32 случайных байта в base64 (openssl rand -base64 32).
Файл с переменными читает Node при запуске; скрипт не печатает его содержимое.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage}\n`); return; }
  if (options.envFile) process.loadEnvFile(options.envFile);
  if (!options.universities.length && !options.urls.length && !options.documents.length) { process.stdout.write(`${usage}\n`); process.exitCode = 2; return; }
  process.umask(0o077);
  const config = loadConfig({ DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY });
  const dbPath = options.db ?? '.live/live-check.sqlite';
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = createStore({ dbPath, masterKey: config.masterKey });
  const io = terminalIo();
  try { await runLiveCheck({ store, io, ...options }); }
  finally { io.close(); store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`Проверка остановлена: ${error.code ?? error.message}\n`); process.exitCode = 1; });
}
