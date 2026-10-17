// Проверка бага «ошибка чтения файла = новый пользователь» (15 окт 2026) в хранилищах сервера: users, белый список лаб,
// задания лаб, беседы, копия приложения, лимиты, база замечаний, счётчик Moodle и статистика бота. Файл держим открытым
// без общего доступа (как антивирус или ежедневная копия) — модуль должен ответить ошибкой (StateReadError, 424) и НЕ
// записать ничего поверх; испорченный JSON — отложить в .bad-* (один раз, а не на каждый обход).
// Копия модулей во временной папке, поддельный сервер на 127.0.0.1:9976 вместо Telegram и Moodle — настоящие данные,
// Moodle и Telegram не затрагиваются. Запуск: node ops\stand\state-stores-test.mjs
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname, APP = join(HERE, "..", "..");
const root = join(tmpdir(), `state-stores-test-${process.pid}`), SIM = join(root, "app");
const PORT = 9976, FAKE = `http://127.0.0.1:${PORT}`;
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
const HOSTS = [["https://api.telegram.org", `${FAKE}/tg`], ["https://newlms.misis.ru", FAKE], ["https://ej.misis.ru", `${FAKE}/ej`], ["https://misis.ru", `${FAKE}/misis`],
  ["https://dnevuch.ru", `${FAKE}/dnevuch`], ["https://campusapp.ru", `${FAKE}/campus`]];
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  let src = readFileSync(join(APP, f), "utf8");
  for (const [from, to] of HOSTS) src = src.split(from).join(to);
  writeFileSync(join(SIM, f), src);
}
for (const f of readdirSync(APP).filter((x) => x.endsWith(".md") && /instruction|lab-report/.test(x))) writeFileSync(join(SIM, f), readFileSync(join(APP, f)));
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(root, "home");
mkdirSync(HOME, { recursive: true });
// MOODLE_PACE_RELOAD_MS — непрочитанный при старте moodle-load.json перечитывается в фоне не раз в 15 с, а раз в 0,2 с.
Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"), MOODLE_PACE: "0", MOODLE_PACE_DIR: join(SIM, "usage"), MOODLE_PACE_RELOAD_MS: "200",
  BOT_STATS_DIR: join(SIM, "usage"), USAGE_STORE_DIR: join(SIM, "usage-store"), USAGE_TRANSCRIPTS_DIR: join(root, "transcripts"), USAGE_CHAT_TRANSCRIPTS_DIR: join(root, "transcripts"),
  LESSONS_DIR: join(SIM, "lessons") });

// Поддельный сервер: на всё — «ок» (сюда ничего не должно уходить, он лишь страховка от настоящих адресов).
const fake = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: {} })); }); });
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (p) => Promise.resolve().then(() => p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const unreadable = (r) => !r.ok && r.e?.name === "StateReadError" && r.e.status === 424;
const why = (r) => (r.ok ? `ответ: ${JSON.stringify(r.v)?.slice(0, 120)}` : `${r.e?.name}: ${String(r.e?.message).slice(0, 120)}`);
const imp = (f) => import(pathToFileURL(join(SIM, f)).href);
const bads = (dir, name) => readdirSync(dir).filter((f) => f.startsWith(`${name}.bad-`));
// Что модули написали в console.error, пока работала fn (в консоль теста эти строки не идут).
async function logged(fn) {
  const lines = [], orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}
// Ждать условия до ms миллисекунд (фоновые таймеры модулей).
async function until(cond, ms = 3000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); return cond(); }
// Новый экземпляр модуля (своё состояние в памяти) с временно подменёнными переменными окружения — они читаются при загрузке.
async function fresh(f, tag, env = {}) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await import(`${pathToFileURL(join(SIM, f)).href}?${tag}`); }
  finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// Держать файлы открытыми без общего доступа ms миллисекунд; промис — когда уже заняты, done — когда отпущены.
function lock(paths, ms) {
  const open = [].concat(paths).map((p, i) => `$f${i} = [IO.File]::Open('${p}', 'Open', 'ReadWrite', 'None')`).join("; ");
  const close = [].concat(paths).map((_, i) => `$f${i}.Close()`).join("; ");
  const ps = spawn("powershell", ["-NoProfile", "-Command", `${open}; 'locked'; Start-Sleep -Milliseconds ${ms}; ${close}; 'free'`], { windowsHide: true });
  let out = "";
  const done = new Promise((r) => ps.on("close", r));
  return new Promise((resolve) => ps.stdout.on("data", (d) => { out += d; if (out.includes("locked")) resolve({ done }); }));
}

// --- данные стенда ---
const KEY = randomBytes(32);
writeFileSync(join(SIM, "users.key"), KEY.toString("hex"));
const enc = (text) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", KEY, iv), e = Buffer.concat([c.update(text, "utf8"), c.final()]); return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${e.toString("hex")}`; };
const USERS = join(SIM, "users");
mkdirSync(USERS, { recursive: true });
const CAL1 = "calOne".padEnd(24, "x"), CAL2 = "calTwo".padEnd(24, "y");
const U1 = join(USERS, "5001.json"), U1_TEXT = JSON.stringify({ tgId: 5001, createdAt: 1, token: enc("tok-5001"), moodleUserId: 11, fullName: "Студент Один", username: "s1",
  group: "БИСТ-24-ПО-2", subgroup: "2", cal: { token: CAL1, at: 1 }, tgName: "Один", tgUsername: null, sessionChoices: { hidden: { "Б1.О.01": true } } }, null, 2);
writeFileSync(U1, U1_TEXT);
writeFileSync(join(USERS, "5002.json"), JSON.stringify({ tgId: 5002, createdAt: 1, token: enc("tok-5002"), fullName: "Студент Два", group: "БИСТ-24-ПО-1", cal: { token: CAL2, at: 1 } }, null, 2));
const U3_TEXT = '{"tgId": 5003, "token": "обры';
writeFileSync(join(USERS, "5003.json"), U3_TEXT);
const ALLOW = join(SIM, "lab-allowlist.txt"), ALLOW_TEXT = "# доступ к лабам с агентом\n5002\n7777\n";
writeFileSync(ALLOW, ALLOW_TEXT);
mkdirSync(join(SIM, "usage"), { recursive: true });
// Moodle на стенде — поддельный 127.0.0.1, поэтому и пауза записана для этого узла.
const now = Date.now();
const PACE = join(SIM, "usage", "moodle-load.json"), PACE_TEXT = JSON.stringify({
  days: { "2026-10-14": { total: 10, bg: 6, user: 4, fail: 1, peakMin: 3, byHour: { 10: 10 }, byWhat: { fn: 10 }, byName: { обход: 6 }, byHost: { "127.0.0.1": 10 } } },
  pause: { "127.0.0.1": { until: now + 6 * 3600e3, reason: "HTTP 403", kind: "block", level: 4, since: now - 60e3, at: now - 60e3, alerted: true, over: 0 } },
  marks: { "full:5001": now - 5000 } });
writeFileSync(PACE, PACE_TEXT);
const STATS = join(SIM, "usage", "bot-stats.json"), STATS_TEXT = JSON.stringify({ days: { "2026-10-14": { sent: 7 } }, started: { 5005: now - 86400e3 }, invitedBy: { 5005: 5001 } });
writeFileSync(STATS, STATS_TEXT);

// --- 1. Счётчик Moodle и статистика бота: файлы заняты в момент загрузки модулей ---
{
  const l = await lock([PACE, STATS], 6000);
  const users = await imp("users.mjs"); // тянет moodle-pace.mjs: чтение при загрузке — под замком
  const pace = await imp("moodle-pace.mjs");
  const stats = await imp("bot-stats.mjs");
  globalThis.__mods = { users, pace, stats };
  pace.stamp("seen:5001", 0, true); // запись «сразу» — при непрочитанном файле её быть не должно
  const first = stats.firstStart(6001); // тоже запись сразу
  // Находка #6 (15 окт 2026): пока файл не прочитан, пауза с диска неизвестна — фон стоит на осторожной паузе (любой узел),
  // запросы людей идут.
  const pu = pace.paused("127.0.0.1"), pe = pace.paused("ej.example");
  check("moodle-load.json не прочитан → фон на паузе «состояние паузы Moodle не прочитано» (для любого узла), срок — до следующей попытки чтения",
    pu?.reason === "состояние паузы Moodle не прочитано" && pu.kind === "unknown" && pe?.kind === "unknown" && pu.until > Date.now() && pu.until <= Date.now() + 250, JSON.stringify(pu));
  let bgErr = null;
  try { await pace.background("тест", () => pace.enter(`${FAKE}/webservice/rest/server.php`, "fn", true)); } catch (e) { bgErr = e; }
  check("фоновый запрос при неизвестном состоянии в сеть не идёт (PausedError)", bgErr?.name === "PausedError", String(bgErr?.message || bgErr));
  const ut = await outcome(pace.enter(`${FAKE}/webservice/rest/server.php`, "fn", true));
  if (ut.ok) pace.cancel(ut.v);
  check("запрос человека при неизвестном состоянии проходит", ut.ok && ut.v.bg === false, why(ut));
  await l.done;
  check("moodle-load.json занят при старте: после отметки с немедленной записью файл не тронут", readFileSync(PACE, "utf8") === PACE_TEXT);
  check("bot-stats.json занят при старте: после firstStart файл не тронут", first === true && readFileSync(STATS, "utf8") === STATS_TEXT);
  // Файл освободился — фоновое перечитывание (раз в 0,2 с на стенде) само сливает диск, без записи и без запросов.
  const merged = await until(() => pace.paused("127.0.0.1")?.kind === "block");
  const bp = pace.paused("127.0.0.1");
  check("файл освободился → фоновое перечитывание само подняло паузу с диска (block, уровень 4, прежний срок), чужой узел без паузы, файл не переписан",
    merged && bp.level === 4 && bp.until === now + 6 * 3600e3 && pace.paused("ej.example") === null && readFileSync(PACE, "utf8") === PACE_TEXT, JSON.stringify(bp));
  pace.stamp("seen:5002", 0, true);
  const disk = JSON.parse(readFileSync(PACE, "utf8"));
  const p = disk.pause["127.0.0.1"];
  check("файл освободился — следующая запись сливает: прежние отметки и пауза на месте, новые отметки добавлены",
    disk.marks["full:5001"] === now - 5000 && disk.marks["seen:5001"] > 0 && disk.marks["seen:5002"] > 0 && p?.level === 4 && p.until === now + 6 * 3600e3 && disk.days["2026-10-14"]?.total === 10
      && pace.paused("127.0.0.1")?.kind === "block", JSON.stringify(disk).slice(0, 300));
  stats.firstStart(6002);
  const st = JSON.parse(readFileSync(STATS, "utf8"));
  check("bot-stats: после освобождения слито — прежние Start и приглашения целы, новые добавлены",
    st.started["5005"] === now - 86400e3 && st.started["6001"] > 0 && st.started["6002"] > 0 && st.invitedBy["5005"] === 5001 && st.days["2026-10-14"]?.sent === 7, JSON.stringify(st));
}

// --- 1а. Счётчик Moodle не читается долго (находка #6): осторожная пауза не дольше срока, затем громкая запись и обычный
// фон; отказ сайта при непрочитанном файле сначала сливает диск — без повторной тревоги владельцу ---
{
  const D = join(SIM, "usage-unknown"), F = join(D, "moodle-load.json");
  mkdirSync(F, { recursive: true }); // вместо файла — папка: чтение падает сразу (EISDIR), пока её не заменят файлом
  // Фоновое перечитывание здесь редкое (60 с) — чтобы слияние делал именно отказ сайта (trip), а не таймер.
  let p2;
  const loadLog = await logged(async () => { p2 = await fresh("moodle-pace.mjs", "unknown", { MOODLE_PACE_DIR: D, MOODLE_PACE_UNKNOWN_MS: "700", MOODLE_PACE_RELOAD_MS: "60000" }); });
  const alerts = [];
  p2.onAlert((t) => alerts.push(t));
  const q = p2.paused("127.0.0.1");
  check("файл не прочитан при старте → осторожная пауза фона, не дольше срока от запуска", loadLog.some((x) => x.includes("не читается")) && q?.kind === "unknown" && q.until <= Date.now() + 700, JSON.stringify(q));
  await sleep(800);
  let after = "x", again = "x";
  const loud = await logged(async () => { after = p2.paused("127.0.0.1"); again = p2.paused("127.0.0.1"); });
  check("срок вышел, файл так и не прочитан → фон идёт как обычно (пауза null) и в журнале одна громкая запись", after === null && again === null && loud.filter((x) => x.includes("ВНИМАНИЕ")).length === 1, loud.join(" / ").slice(0, 200));
  const t0 = Date.now();
  rmSync(F, { recursive: true, force: true });
  writeFileSync(F, JSON.stringify({ days: {}, marks: {}, pause: { "127.0.0.1": { until: t0 + 6 * 3600e3, reason: "HTTP 403", kind: "block", level: 4, since: t0 - 60e3, at: t0 - 60e3, alerted: true, over: 0 } } }));
  const ut = await p2.enter(`${FAKE}/webservice/rest/server.php`, "fn", true);
  p2.leave(ut, { status: 403 }); // Moodle отказал запросу человека → trip
  await sleep(50); // тревога уходит через промис
  const tp = p2.paused("127.0.0.1");
  check("отказ сайта при непрочитанном файле: сначала слит диск — пауза прежняя (уровень 4, шесть часов), повторной тревоги нет",
    alerts.length === 0 && tp?.kind === "block" && tp.level === 4 && tp.until === t0 + 6 * 3600e3, `тревог: ${alerts.length}; ${JSON.stringify(tp)}`);
  p2.stamp("done", 0, true); // записать сейчас, чтобы при выходе экземпляру нечего было дописывать в уже удалённую папку
  const disk = JSON.parse(readFileSync(F, "utf8"));
  check("и запись после этого — поверх слитого: пауза с диска цела", disk.pause["127.0.0.1"]?.level === 4 && disk.pause["127.0.0.1"].until === t0 + 6 * 3600e3 && disk.marks.done > 0, JSON.stringify(disk.pause));
}

// --- 1б. Статистика бота долго не читается (находка #7): повтор чтения — один таймер, сколько бы ни было /start ---
{
  const D = join(SIM, "usage-b"), F = join(D, "bot-stats.json");
  mkdirSync(F, { recursive: true }); // папка вместо файла — чтение падает сразу
  let s2;
  await logged(async () => { s2 = await fresh("bot-stats.mjs", "retry", { BOT_STATS_DIR: D }); });
  // Считаем минутные таймеры повтора: взведённые и ещё не снятые/не сработавшие.
  const live = new Set(), origSet = globalThis.setTimeout, origClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (ms !== 60e3) return origSet(fn, ms, ...a);
    const t = origSet(() => { live.delete(t); fn(...a); }, ms);
    live.add(t);
    return t;
  };
  globalThis.clearTimeout = (t) => { live.delete(t); return origClear(t); };
  let firsts = [], res = null;
  try {
    await logged(() => { firsts = [7001, 7002, 7003, 7004, 7005].map((id) => s2.firstStart(id)); s2.note("sent"); });
    const stuck = live.size;
    rmSync(F, { recursive: true, force: true });
    writeFileSync(F, JSON.stringify({ days: { "2026-10-14": { sent: 3 } }, started: { 7000: now - 86400e3 }, invitedBy: { 7000: 5001 } }));
    res = { stuck, first: s2.firstStart(7101), left: live.size };
  } finally { globalThis.setTimeout = origSet; globalThis.clearTimeout = origClear; }
  check("bot-stats.json не читается: пять новых /start подряд → один таймер повтора, а не пять цепочек", firsts.every(Boolean) && res?.stuck === 1, `таймеров: ${res?.stuck}`);
  const st = JSON.parse(readFileSync(F, "utf8"));
  check("файл стал читаемым → следующий /start слил и записал, таймер повтора снят",
    res?.first === true && res.left === 0 && st.started["7000"] === now - 86400e3 && [7001, 7002, 7003, 7004, 7005, 7101].every((id) => st.started[id] > 0) && st.invitedBy["7000"] === 5001 && st.days["2026-10-14"]?.sent === 3,
    `таймеров: ${res?.left}; ${JSON.stringify(st).slice(0, 200)}`);
}
const { users } = globalThis.__mods;

// --- 2. users/<id>.json занят ---
{
  const l = await lock(U1, 9000);
  const prof = await outcome(users.profile(5001));
  check("users/5001.json занят → profile() отвечает StateReadError (424), а не «новый пользователь»", unreadable(prof), why(prof));
  const touch = await outcome(users.touchTelegram(5001, { id: 5001, first_name: "Новое", last_name: "Имя" }));
  check("touchTelegram при занятом файле → ошибка (ничего не пишет)", unreadable(touch), why(touch));
  const grp = await outcome(users.setGroup(5001, "ГРУППА-1"));
  check("setGroup при занятом файле → ошибка", unreadable(grp), why(grp));
  const sc = await outcome(users.setSessionChoice(5001, "hidden", "Б1.О.02", true));
  check("setSessionChoice при занятом файле → ошибка", unreadable(sc), why(sc));
  const all = await outcome(users.allLoggedIn());
  const ids = all.ok ? all.v.map((x) => x.tgId) : [];
  check("allLoggedIn: пропущен только занятый 5001 (и испорченный 5003), 5002 с токеном на месте", all.ok && ids.includes(5002) && !ids.includes(5001) && !ids.includes(5003)
    && all.v.find((x) => x.tgId === 5002)?.token === "tok-5002", why(all));
  const miss = await outcome(users.byCalToken("z".repeat(24)));
  check("byCalToken: секрет не найден, а чей-то файл не прочитался → StateReadError (не «не найден» / 404)", unreadable(miss), why(miss));
  const hit = await outcome(users.byCalToken(CAL2));
  check("byCalToken: секрет читаемого пользователя находится и при занятом файле другого", hit.ok && hit.v === 5002, why(hit));
  await l.done;
  check("после блокировки users/5001.json побайтно тот же", readFileSync(U1, "utf8") === U1_TEXT);
  const p = await users.profile(5001);
  check("файл освободился — профиль прежний: вход, группа, подгруппа, уточнения сессии", p.loggedIn === true && p.group === "БИСТ-24-ПО-2" && p.subgroup === "2" && p.moodle?.fullName === "Студент Один"
    && (await users.sessionChoices(5001)).hidden["Б1.О.01"] === true, JSON.stringify(p).slice(0, 200));
  await users.touchTelegram(5001, { id: 5001, first_name: "Новое", last_name: "Имя" });
  const saved = JSON.parse(readFileSync(U1, "utf8"));
  check("запись после освобождения идёт поверх настоящей записи (токен и календарь целы), а не пустой", saved.tgName === "Новое Имя" && saved.token === JSON.parse(U1_TEXT).token && saved.cal?.token === CAL1);
  check("ссылка календаря 5001 снова находится", (await users.byCalToken(CAL1)) === 5001);
}

// --- 3. Испорченный users/<id>.json ---
{
  const b1 = bads(USERS, "5003.json");
  const p3 = await outcome(users.profile(5003));
  check("испорченный users/5003.json отложен в .bad-* (копия совпадает), пользователь считается не вошедшим", b1.length === 1 && readFileSync(join(USERS, b1[0]), "utf8") === U3_TEXT
    && p3.ok && p3.v.loggedIn === false, `${b1.join()} ${why(p3)}`);
  await sleep(1100); // имя копии — с точностью до секунды
  await users.allLoggedIn(); await users.listUsers();
  check("повторные обходы не плодят новых копий испорченного файла", bads(USERS, "5003.json").length === 1, bads(USERS, "5003.json").join());
  check("сам испорченный файл не перезаписан (без входа пользователя)", readFileSync(join(USERS, "5003.json"), "utf8") === U3_TEXT);
}

// --- 4. Белый список лаб занят ---
{
  // Находка #20 (15 окт 2026): список уже читался (profile в разделах 2–3) — при занятом файле доступ берётся из последнего
  // удачного чтения, и profile не падает у всех; правка списка по-прежнему только после свежего чтения. Модуль, который
  // список ещё ни разу не прочитал (новый экземпляр), — ошибка, а не «нет доступа».
  const l = await lock(ALLOW, 9000);
  let la, la1, pr, set, fl, fp;
  const log = await logged(async () => {
    la = await outcome(users.labsAllowed(5002));
    la1 = await outcome(users.labsAllowed(5001));
    pr = await outcome(users.profile(5002));
    set = await outcome(users.setLabAccess(5001, true));
    const u2 = await fresh("users.mjs", "noallow");
    fl = await outcome(u2.labsAllowed(5002));
    fp = await outcome(u2.profile(5002));
  });
  check("lab-allowlist.txt занят → labsAllowed по последнему прочитанному списку (5002 — да, 5001 — нет)", la.ok && la.v === true && la1.ok && la1.v === false, `${why(la)} ${why(la1)}`);
  check("profile() при занятом списке отвечает, labsAllowed из памяти", pr.ok && pr.v.labsAllowed === true && pr.v.moodle?.fullName === "Студент Два", why(pr));
  check("в журнале об этом — одна строка в минуту, а не на каждый вызов", log.filter((x) => x.includes("по последнему прочитанному списку")).length === 1, log.join(" / ").slice(0, 300));
  check("setLabAccess при занятом списке → ошибка (правка — только после свежего чтения)", unreadable(set), why(set));
  check("список ещё ни разу не прочитан (новый экземпляр модуля) → labsAllowed и profile — ошибка, а не «нет доступа»", unreadable(fl) && unreadable(fp), `${why(fl)} ${why(fp)}`);
  await l.done;
  check("после блокировки lab-allowlist.txt не изменён", readFileSync(ALLOW, "utf8") === ALLOW_TEXT);
  check("доступ по списку прежний", (await users.labsAllowed(5002)) === true && (await users.labsAllowed(5001)) === false);
  await users.setLabAccess(5001, true);
  const t = readFileSync(ALLOW, "utf8");
  check("правка после освобождения: комментарий и прежние id на месте, новый добавлен", t.includes("# доступ к лабам с агентом") && /^5002$/m.test(t) && /^7777$/m.test(t) && /^5001$/m.test(t), JSON.stringify(t));
  const l2 = await lock(ALLOW, 3000);
  const la2 = await outcome(users.labsAllowed(5001));
  await l2.done;
  check("после правки запомнен уже новый список: при занятом файле 5001 — с доступом", la2.ok && la2.v === true, why(la2));
}

// --- 5. Задание лабы jobs/<ключ>.json занято ---
{
  const JOBS = join(SIM, "jobs");
  mkdirSync(JOBS, { recursive: true });
  const job = (id, extra) => ({ id, tgId: 5001, key: `5001-${id}`, dir: join(HOME, "moodle-work", "users", "5001", id), title: `ЛР ${id}`, course: "Курс", due: null, report: null, moodle: null, agent: null,
    messages: [{ role: "user", text: "начни", at: now - 60e3 }, { role: "assistant", text: "прочитал условие", at: now - 50e3 }], token: "a1b2c3d4e5f6a1b2c3d4e5f6", createdAt: now - 60e3, updatedAt: now - 50e3, ...extra });
  const J1 = join(JOBS, "5001-901.json"), J1_TEXT = JSON.stringify(job("901", { status: "report", report: { name: "Отчёт 901.pdf", pdf: join(root, "нет.pdf") }, fix: { keys: ["k1"], sending: [], delivered: true, done: true } }), null, 2);
  writeFileSync(J1, J1_TEXT);
  writeFileSync(join(JOBS, "5001-902.json"), JSON.stringify(job("902", { status: "waiting" }), null, 2));
  const lab = await imp("lab.mjs");
  const l = await lock(J1, 7000);
  const g = await outcome(lab.get(5001, "901"));
  check("jobs/5001-901.json занят → lab.get отвечает ошибкой (не «задания нет» / idle)", unreadable(g), why(g));
  const s = await outcome(lab.start("901", { tgId: 5001, title: "ЛР 901", course: "Курс", token: "tok" }));
  check("lab.start при занятом задании → ошибка, нового задания нет", !s.ok && unreadable(s), why(s));
  const li = await outcome(lab.list(5001));
  check("lab.list: занятое задание пропущено, остальные плашки на месте", li.ok && li.v.some((x) => x.id === "902") && !li.v.some((x) => x.id === "901"), why(li));
  const rm = [{ key: "k1", text: "нет графика" }];
  const mr = await outcome(lab.markRemarks(5001, "901", rm));
  check("markRemarks при занятом задании — замечания без пометок, без ошибки", mr.ok && mr.v === rm, why(mr));
  await l.done;
  check("после блокировки задание побайтно то же", readFileSync(J1, "utf8") === J1_TEXT);
  const g2 = await lab.get(5001, "901");
  check("файл освободился — задание прежнее (переписка, отчёт)", g2?.messages?.length === 2 && g2.status === "report" && g2.report?.name === "Отчёт 901.pdf", JSON.stringify(g2)?.slice(0, 160));
  check("и пометки замечаний считаются", (await lab.markRemarks(5001, "901", rm))[0]?.state === "fixed");
}

// --- 6. Беседы: chats.json испорчен, затем занят ---
{
  const chats = await imp("chats.mjs");
  const C = join(SIM, "chats.json");
  writeFileSync(C, '{"-100123": {"title": "обры');
  const c1 = await outcome(chats.list());
  check("испорченный chats.json → ошибка (не пустой список), копия в .bad-*", unreadable(c1) && bads(SIM, "chats.json").length === 1, why(c1));
  await sleep(1100);
  const c2 = await outcome(chats.list());
  check("пока файл не поправили — снова ошибка, без новой копии", unreadable(c2) && bads(SIM, "chats.json").length === 1, bads(SIM, "chats.json").join());
  const C_TEXT = JSON.stringify({ "-100123": { title: "Беседа 1", group: "БИСТ-24-ПО-2", subgroup: null }, "-100456": { title: "Беседа 2", group: "БИСТ-24-ПО-1", subgroup: "1" } }, null, 2);
  writeFileSync(C, C_TEXT);
  const l = await lock(C, 5000);
  const mig = await outcome(chats.onMessage({ chat: { id: -100123, type: "group" }, migrate_to_chat_id: -100999 }));
  check("chats.json занят → изменение привязок (переезд в супергруппу) — ошибка", unreadable(mig), why(mig));
  await l.done;
  check("после блокировки chats.json не изменён", readFileSync(C, "utf8") === C_TEXT);
  await chats.onMessage({ chat: { id: -100123, type: "group" }, migrate_to_chat_id: -100999 });
  const all = JSON.parse(readFileSync(C, "utf8"));
  check("файл освободился — переезд записан, вторая беседа на месте", all["-100999"]?.group === "БИСТ-24-ПО-2" && !all["-100123"] && all["-100456"]?.title === "Беседа 2" && (await chats.list()).length === 2, JSON.stringify(all));
}

// --- 7. Копия приложения cloud/<id>.json ---
{
  const cloud = await imp("cloud-backup.mjs");
  const CL = join(SIM, "cloud");
  mkdirSync(CL, { recursive: true });
  const K1 = join(CL, "5001.json"), K1_TEXT = JSON.stringify({ at: 123, data: { notes: [{ id: 1, text: "заметка" }] } });
  writeFileSync(K1, K1_TEXT);
  const l = await lock(K1, 4000);
  const r = await outcome(cloud.load(5001));
  check("cloud/5001.json занят → ошибка (424), а не «копии нет»", unreadable(r), why(r));
  await l.done;
  check("копия цела и читается", readFileSync(K1, "utf8") === K1_TEXT && (await cloud.load(5001))?.at === 123);
  writeFileSync(join(CL, "5002.json"), '{"at": 1, "data": {"no');
  check("испорченная копия → null и отложена в .bad-*", (await cloud.load(5002)) === null && bads(CL, "5002.json").length === 1);
  await Promise.all([cloud.save(5001, { notes: [{ id: 2 }] }), cloud.save(5001, { notes: [{ id: 3 }] })]);
  check("две одновременные записи одного человека не мешают друг другу", [2, 3].includes(JSON.parse(readFileSync(K1, "utf8")).data.notes[0].id) && !readdirSync(CL).some((f) => f.endsWith(".tmp")), readdirSync(CL).join());
}

// --- 8. Лимиты usage/limits.json заняты ---
{
  const usage = await imp("usage.mjs");
  const ST = join(SIM, "usage-store");
  mkdirSync(ST, { recursive: true });
  const L = join(ST, "limits.json"), L_TEXT = JSON.stringify({ unit: "tokens", default: 100000, users: { 5002: 5000 }, alerted: { "5002:2026-10:80": 1 } }, null, 1);
  writeFileSync(L, L_TEXT);
  const l = await lock(L, 5000);
  const sl = await outcome(usage.setLimit(5003, 1000));
  check("limits.json занят → сохранение лимита владельцем — ошибка, файл не «чинится» пустым", unreadable(sl), why(sl));
  const gd = await outcome(usage.guard(5002, "start"));
  check("и проверка перед работой студента — ошибка, а не «без лимита»", !gd.ok, why(gd));
  await l.done;
  check("после блокировки limits.json не изменён и не отложен в .bad", readFileSync(L, "utf8") === L_TEXT && !existsSync(`${L}.bad`));
  await usage.setLimit(5003, 1000);
  const lf = JSON.parse(readFileSync(L, "utf8"));
  check("лимит сохранён поверх прежних (личные и отметки целы)", lf.users["5002"] === 5000 && lf.users["5003"] === 1000 && lf.default === 100000 && lf.alerted["5002:2026-10:80"] === 1, JSON.stringify(lf));
}

// --- 9. База замечаний lessons/<работа>.json ---
{
  const lessons = await imp("lessons.mjs");
  const LS = join(SIM, "lessons");
  mkdirSync(LS, { recursive: true });
  const me = lessons.srcOf(5001);
  const A = join(LS, "111.json"), A_TEXT = JSON.stringify({ assignId: 111, title: "ЛР 111", courseId: 5, course: "Курс", items: [
    { tkey: "t1", text: "Старое замечание к работе других студентов", srcs: ["aaaaaaaaaa"], returnedBy: [], agentBy: [], firstAt: 1, lastAt: 1 },
    { tkey: "t2", text: "Замечание этого студента к работе", srcs: [me], returnedBy: [], agentBy: [], firstAt: 1, lastAt: 1 }] }, null, 1);
  writeFileSync(A, A_TEXT);
  const remark = { text: "Нет графика зависимости, нужно добавить подписи осей", at: now };
  const items = [111, 222].map((id) => ({ id: `moodle:assign:${id}`, title: `ЛР ${id}`, courseId: 5, remarks: [remark], submission: { status: "submitted" } }));
  const l = await lock(A, 6000);
  const h = await outcome(lessons.harvest(5001, items, [{ id: 5, name: "Курс" }], { fullName: "Студент Один" }));
  check("lessons/111.json занят → harvest не падает: другая работа собрана", h.ok && existsSync(join(LS, "222.json")) && JSON.parse(readFileSync(join(LS, "222.json"), "utf8")).items.length === 1, why(h));
  const pu = await outcome(lessons.purge(5001));
  check("отказ от согласия при занятом файле → ошибка (повторить), остальные файлы очищены", unreadable(pu) && JSON.parse(readFileSync(join(LS, "222.json"), "utf8")).items.length === 0, why(pu));
  await l.done;
  check("после блокировки lessons/111.json побайтно тот же (замечания других не стёрты)", readFileSync(A, "utf8") === A_TEXT);
  await lessons.purge(5001);
  const a = JSON.parse(readFileSync(A, "utf8"));
  check("повторный отказ после освобождения убирает замечания этого студента, чужие остаются", a.items.length === 1 && a.items[0].tkey === "t1", JSON.stringify(a.items.map((i) => i.tkey)));
}

fake.close();
try { unlinkSync(join(SIM, "node_modules")); } catch { /* ссылки уже нет */ }
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
