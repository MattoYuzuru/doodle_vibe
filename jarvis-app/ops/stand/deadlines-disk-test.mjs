// Проверка копии дедлайнов на диске (moodle.mjs, 15 окт 2026). Копия пишется зашифрованной (ни токена, ни названий работ
// открытым текстом); после «перезапуска» возвращается в память и сразу видна фону; с allowDisk отдаётся без запросов к
// Moodle, а без него (прикрепление, отправка) Moodle всё равно читается; экран приложения при медленном Moodle или
// занятой очереди получает копию с stale и без moodle.down; сбросы (forgetDeadlines, смена курсов, новый вход) удаляют
// файл, и уже идущая запись его не воскрешает; чужая версия кода, другой токен, другой выбор курсов, подмена, порча,
// старость, более поздний сброс — копия выбрасывается и файл удаляется; MOODLE_DISK=0 — файлов нет вовсе (прежние
// удаляются при старте). С 15 окт 2026 (находки ревью) ещё: запоздавшее чтение не затирает список курсов (#0); выход,
// мёртвый токен и новый вход отзывают прежний токен — обход по старому списку копию не возвращает (#1, #23, #24);
// мёртвый токен не прячется за копией (#2); на сервере — сообщение владельцу об испорченном файле (#4), вход при
// нечитаемом файле — 424 без счёта попыток (#21), чистка .bad-* (#25).
// «Перезапуск» — новый дочерний процесс на той же папке. В конце — то же целиком на копии сервера (вход, первое открытие,
// kill и запуск заново, открытие при медленном Moodle, выход). Копия модулей во временной папке, все внешние адреса
// подменены на поддельный сервер 127.0.0.1:9971, копия сервера — на 127.0.0.1:9972; настоящие Moodle, журнал, Telegram,
// misis.ru и данные пользователей не затрагиваются.
// Запуск: node ops\stand\deadlines-disk-test.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", ".."), PORT = 9971, FAKE = `http://127.0.0.1:${PORT}`;
const root = join(tmpdir(), `deadlines-disk-test-${process.pid}`), SIM = join(root, "app");
const DISK = join(root, "dl"), F = join(DISK, "501.json"), PACE = join(root, "usage");
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
const patch = { "https://newlms.misis.ru": FAKE, "https://api.telegram.org": `${FAKE}/tg`, "https://dnevuch.ru": `${FAKE}/dnevuch`, "https://campusapp.ru": `${FAKE}/campus`, "https://ej.misis.ru": `${FAKE}/ej` };
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  let src = readFileSync(join(APP, f), "utf8");
  for (const [a, b] of Object.entries(patch)) src = src.split(a).join(b);
  writeFileSync(join(SIM, f), src);
}
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await sleep(50); return !!fn(); };

// ---------- поддельный Moodle: один курс, одна работа; /__count — сколько запросов пришло, /__set — медленно или «техработы» ----------
// С 15 окт 2026 ещё: enrolOnce — следующий запрос списка курсов ответит через столько мс (одно запоздавшее чтение),
// dead — токены через запятую, на которые Moodle отвечает invalidtoken (сменили пароль); tgSent — что ушло в Telegram.
const UID = { "tok-a": 1501, "tok-b": 1777, "tok-c": 1502, "tok-u7001": 17001 };
let http = 0, slowMs = 0, html = false, enrolOnce = 0, deadTok = new Set();
const tgSent = [];
const nowS = () => Math.floor(Date.now() / 1000);
const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") flat(v, key, out); else out[key] = v; } return out; };
function ws(fn, p, uid) {
  if (fn === "tool_mobile_call_external_functions") {
    const responses = [];
    for (let i = 0; p[`requests[${i}][function]`]; i++) responses.push({ error: false, data: JSON.stringify(ws(p[`requests[${i}][function]`], flat(JSON.parse(p[`requests[${i}][arguments]`] || "{}")), uid)) });
    return { responses };
  }
  switch (fn) {
    case "core_webservice_get_site_info": return { userid: uid, fullname: "Студент Тестовый", username: `u${uid}` };
    case "core_enrol_get_users_courses": return [{ id: 11, fullname: "Базы данных", hidden: false, lastaccess: nowS() - 3600, startdate: nowS() - 30 * 86400 }];
    case "mod_assign_get_assignments": return { courses: [{ id: 11, assignments: [{ id: 2201, cmid: 3301, name: "ЛР1 Секретное название", duedate: nowS() + 5 * 86400, grade: 10, submissiondrafts: 1,
      allowsubmissionsfromdate: nowS() - 86400, timemodified: nowS() - 86400, configs: [] }] }] };
    case "mod_quiz_get_quizzes_by_courses": return { quizzes: [] };
    case "mod_assign_get_submission_status": return { lastattempt: { submission: { id: 9001, status: "new", plugins: [] }, canedit: true, gradingstatus: "notgraded" } };
    case "core_comment_get_comments": return { comments: [] };
    default: return { exception: "x", errorcode: "unknownfn", message: fn };
  }
}
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const url = new URL(req.url, FAKE);
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/__count") return json({ n: http });
    if (url.pathname === "/__set") {
      if (url.searchParams.has("slow")) slowMs = Number(url.searchParams.get("slow"));
      if (url.searchParams.has("html")) html = url.searchParams.get("html") === "1";
      if (url.searchParams.has("enrolOnce")) enrolOnce = Number(url.searchParams.get("enrolOnce"));
      if (url.searchParams.has("dead")) deadTok = new Set(url.searchParams.get("dead").split(",").filter(Boolean));
      return json({ ok: true });
    }
    // Остальное, куда ходит копия сервера: Bot API, журнал, «Дневач», misis.ru, Gateway — пустые ответы.
    if (url.pathname.startsWith("/tg/")) {
      if (url.pathname.endsWith("/sendMessage")) { try { tgSent.push(JSON.parse(body)); } catch { tgSent.push({ raw: body }); } }
      if (url.pathname.endsWith("/getUpdates")) await sleep(1000);
      return json({ ok: true, result: url.pathname.endsWith("/getUpdates") ? [] : { message_id: 1 } });
    }
    if (url.pathname.startsWith("/ej") || url.pathname.startsWith("/dnevuch")) { res.writeHead(404); return res.end("not found"); }
    if (/^\/(session|schedule|eduop)/.test(url.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<p>Информация будет опубликована позже.</p>"); }
    const p = Object.fromEntries(new URLSearchParams(body));
    if (url.pathname === "/login/token.php") return json(p.username === "u7001" && p.password === "ok-u7001" ? { token: "tok-u7001" } : { error: "Неверный логин или пароль" });
    if (!p.wsfunction) return json({});
    http++;
    if (slowMs) await sleep(slowMs);
    if (p.wsfunction === "core_enrol_get_users_courses" && enrolOnce) { const ms = enrolOnce; enrolOnce = 0; await sleep(ms); }
    if (html) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>Site is undergoing maintenance</html>"); }
    if (deadTok.has(p.wstoken)) return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Ключ недействителен" });
    const uid = UID[p.wstoken];
    if (!uid) return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Ключ недействителен" });
    json(ws(p.wsfunction, p, uid));
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));

// ---------- сценарии: каждый — отдельный процесс (перезапуск сервера) на той же папке копий и отметок ----------
writeFileSync(join(SIM, "scenario.mjs"), `
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as moodle from "./moodle.mjs";
import * as pace from "./moodle-pace.mjs";
const op = process.argv[2], DISK = process.env.MOODLE_DISK_DIR, F = join(DISK, "501.json"), T = "tok-a", TG = 501, FAKE = ${JSON.stringify(FAKE)};
const ov = JSON.parse(process.env.SC_OV || "{}"), token = process.env.SC_TOKEN || T;
const count = async () => (await (await fetch(FAKE + "/__count")).json()).n;
const set = (q) => fetch(FAKE + "/__set?" + q).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await sleep(50); return !!fn(); };
const fileAt = () => { try { return JSON.parse(readFileSync(F, "utf8")).at; } catch { return null; } };
const files = () => { try { return readdirSync(DISK).sort(); } catch { return []; } };
const restore = () => moodle.restoreDisk([{ tgId: TG, token, overrides: ov }]);
const out = {};
try {
  if (op === "write") {
    moodle.setOverrides(T, ov, TG);
    out.before = existsSync(F);
    const d = await pace.background("test", () => moodle.deadlines(T, true));
    out.fileNow = existsSync(F); // фоновое чтение дождалось записи копии
    out.updated = d.updated; out.title = d.items[0]?.title;
    moodle.setOverrides("tok-b", {}); // токен, чей владелец неизвестен, — копии нет
    await moodle.deadlines("tok-b", true);
    await sleep(300);
    out.files = files();
  } else if (op === "restore-young") {
    out.n = await restore();
    const c0 = await count();
    out.stale = moodle.staleDeadlines(T)?.updated ?? null;
    out.at = moodle.deadlinesAt(T); out.fileAt = fileAt();
    const d1 = await moodle.deadlines(T, false, { allowDisk: true });
    out.d1 = d1.updated; out.callsAllowDisk = (await count()) - c0;
    moodle.setOverrides(T, ov, TG); // первый вызов после старта с тем же выбором курсов
    out.kept = moodle.staleDeadlines(T)?.updated === out.stale && existsSync(F);
    const c1 = await count();
    const d2 = await moodle.deadlines(T);
    out.d2 = d2.updated; out.callsNoDisk = (await count()) - c1;
    out.rewritten = await waitFor(() => (fileAt() || 0) > out.fileAt);
    const c2 = await count();
    const d3 = await moodle.deadlinesForApp(T);
    out.d3same = d3.updated === d2.updated && !d3.stale; out.callsApp = (await count()) - c2;
  } else if (op === "submit-reads") {
    await restore();
    const c0 = await count();
    try { await moodle.submitOwn(T, 2201); out.err = null; } catch (e) { out.err = e.message; }
    out.calls = (await count()) - c0;
  } else if (op === "app-fast") {
    out.n = await restore();
    const was = moodle.staleDeadlines(T)?.updated;
    const d = await moodle.deadlinesForApp(T);
    out.stale = !!d.stale; out.newer = d.updated > was;
  } else if (op === "app-slow") {
    out.n = await restore();
    const was = moodle.staleDeadlines(T)?.updated;
    await set("slow=700");
    let t0 = Date.now();
    const d = await moodle.deadlinesForApp(T);
    out.ms = Date.now() - t0; out.stale = d.stale === true; out.source = d.source; out.same = d.updated === was; out.down = "moodle" in d;
    out.filled = await waitFor(() => (moodle.staleDeadlines(T)?.updated || 0) > was, 20000);
    const mem = moodle.staleDeadlines(T)?.updated;
    t0 = Date.now();
    const r = await moodle.deadlinesForApp(T, { refresh: true });
    out.refresh = { ms: Date.now() - t0, stale: r.stale === true, source: r.source, same: r.updated === mem };
    await waitFor(() => (moodle.staleDeadlines(T)?.updated || 0) > mem, 20000);
    await set("slow=0");
  } else if (op === "app-throttle") {
    // Чтения «вдогонку» не больше MOODLE_REFRESH_PARALLEL (здесь 1): второй заход, пока первое чтение идёт, получает копию
    // сразу, без ожидания 0,3 с и без второго чтения (данные к его очереди уже свежие).
    await restore();
    const was = moodle.staleDeadlines(T)?.updated;
    await set("slow=700");
    const p1 = moodle.deadlinesForApp(T);
    await sleep(20);
    const t0 = Date.now();
    const d2 = await moodle.deadlinesForApp(T);
    out.ms2 = Date.now() - t0; out.stale2 = d2.stale === true && d2.updated === was;
    out.stale1 = (await p1).stale === true;
    out.filled = await waitFor(() => (moodle.staleDeadlines(T)?.updated || 0) > was, 20000);
    const cf = await count();
    await sleep(1500);
    out.extra = (await count()) - cf;
    await set("slow=0");
  } else if (op === "app-queue") {
    await restore();
    await set("slow=1500");
    moodle.setOverrides("tok-b", {});
    void moodle.deadlines("tok-b", true).catch(() => null); // занимает единственное место очереди (MOODLE_CONC=1)
    await sleep(50);
    const t0 = Date.now();
    let d = null;
    try { d = await moodle.deadlinesForApp(T); } catch (e) { out.err = e.name + ": " + e.message; }
    out.ms = Date.now() - t0; out.stale = d?.stale === true; out.source = d?.source; out.down = !!d && "moodle" in d;
    await set("slow=0");
  } else if (op === "app-outage") {
    await restore();
    await set("html=1");
    try { await moodle.deadlinesForApp(T); out.thrown = false; } catch (e) { out.thrown = true; out.outage = moodle.isOutage(e); }
    out.stale = moodle.staleDeadlines(T) != null; // сервер ответит этими данными с плашкой, как раньше
    await set("html=0");
  } else if (op === "forget-race") {
    moodle.setOverrides("tok-c", {}, 502);
    await moodle.deadlines("tok-c", true);
    out.control = await waitFor(() => existsSync(join(DISK, "502.json")), 2000); // без сброса запись доходит до диска
    moodle.setOverrides(T, ov, TG);
    await moodle.deadlines(T, true); // запись копии уже в очереди
    out.inFlight = !existsSync(F);
    await moodle.forgetDeadlines(T);
    out.afterForget = existsSync(F);
    await sleep(600);
    out.later = existsSync(F);
    out.stamp = pace.stampAt("dl-drop:501") > 0;
    out.stale = moodle.staleDeadlines(T);
  } else if (op === "forget-only") {
    moodle.setOverrides(T, ov, TG);
    await moodle.forgetDeadlines(T);
    out.gone = !existsSync(F);
  } else if (op === "ovchange") {
    out.n = await restore();
    moodle.setOverrides(T, { 11: false }, TG);
    out.gone = await waitFor(() => !existsSync(F), 2000);
    out.stale = moodle.staleDeadlines(T);
  } else if (op === "login-forget") {
    out.n = await restore();
    await moodle.forgetUserDeadlines(TG, null);
    out.gone = !existsSync(F); out.stale = moodle.staleDeadlines(T);
  } else if (op === "restore-n") {
    out.n = await restore();
    out.exists = existsSync(F); out.files = files(); out.stale = !!moodle.staleDeadlines(T);
  } else if (op === "course-race") {
    // #0: чтение по прежнему выбору курсов ждёт список курсов, а человек тем временем включил курс.
    moodle.setOverrides(T, { 11: false }, TG);
    await moodle.deadlines(T, true); // номер пользователя известен; курс 11 выключен
    out.q0 = (await moodle.quizzesQuick(T)).courses.map((x) => x.id);
    await set("enrolOnce=1500");
    const late = moodle.deadlines(T, true); // его список курсов придёт через 1,5 с
    await sleep(300);
    moodle.setOverrides(T, { 11: true }, TG); // включил курс 11
    await moodle.deadlines(T, true);
    out.q1 = (await moodle.quizzesQuick(T)).courses.map((x) => x.id);
    out.lateCourses = (await late).courses.map((x) => x.id);
    out.q2 = (await moodle.quizzesQuick(T)).courses.map((x) => x.id);
  } else if (op === "revoke-logout") {
    // #1/#23: выход во время чтения и обход по списку вошедших, взятому до выхода (прежний токен, тот же tgId).
    moodle.setOverrides(T, ov, TG);
    await pace.background("test", () => moodle.deadlines(T, true));
    out.before = existsSync(F);
    await set("slow=300");
    const inflight = pace.background("test", () => moodle.deadlines(T, true));
    await sleep(100);
    await moodle.forgetDeadlines(T, TG, { revoke: true }); // /api/logout
    out.afterLogout = existsSync(F);
    await inflight.catch(() => null);
    await set("slow=0");
    await sleep(300);
    out.afterInflight = existsSync(F);
    moodle.setOverrides(T, ov, TG); // обход по старому списку
    await pace.background("test", () => moodle.deadlines(T, true));
    await moodle.deadlines(T, true); // и человеческое чтение тем же токеном
    await sleep(300);
    out.afterTick = existsSync(F);
  } else if (op === "relogin-other") {
    // #24: вошёл другой учётной записью (tok-b), обход ещё держит прежний токен.
    moodle.setOverrides(T, ov, TG);
    await pace.background("test", () => moodle.deadlines(T, true));
    await moodle.forgetUserDeadlines(TG, T, "tok-b"); // вход: Moodle выдал tok-b
    moodle.setOverrides("tok-b", ov, TG); // /api/me нового входа
    await pace.background("test", () => moodle.deadlines("tok-b", true));
    const at1 = fileAt();
    out.bWrote = at1 != null;
    await sleep(20);
    moodle.setOverrides(T, ov, TG); // обход по старому списку: прежний токен
    await pace.background("test", () => moodle.deadlines(T, true));
    await sleep(300);
    out.notOverwritten = fileAt() === at1;
    await sleep(20);
    await pace.background("test", () => moodle.deadlines("tok-b", true));
    out.bStillBound = (fileAt() || 0) > at1;
  } else if (op === "relogin-same") {
    // Вход заново, а Moodle выдал тот же токен: отзыв с него снимается (forgetUserDeadlines(…, fresh) и restoreDisk).
    moodle.setOverrides(T, ov, TG);
    await moodle.forgetDeadlines(T, TG, { revoke: true }); // выход
    await moodle.forgetUserDeadlines(TG, null, T); // вход заново: тот же токен
    moodle.setOverrides(T, ov, TG);
    await pace.background("test", () => moodle.deadlines(T, true));
    out.afterRelogin = existsSync(F);
    await moodle.forgetUserDeadlines(TG, T, T); // вход без выхода, тот же токен (old === fresh)
    out.goneOnLogin = !existsSync(F);
    await pace.background("test", () => moodle.deadlines(T, true));
    out.again = existsSync(F);
    await moodle.forgetDeadlines(T, TG, { revoke: true }); // выход
    out.n = await restore(); // «перезапуск»: в списке вошедших снова этот токен
    moodle.setOverrides(T, ov, TG);
    await pace.background("test", () => moodle.deadlines(T, true));
    out.afterRestore = existsSync(F);
  } else if (op === "dead-late") {
    // #2: отказ invalidtoken приходит после 6 с (здесь 0,3 с) — уже после того, как экран получил копию.
    out.n = await restore();
    await set("slow=700&dead=tok-a");
    const d = await moodle.deadlinesForApp(T);
    out.first = { stale: d.stale === true, source: d.source };
    out.gone = await waitFor(() => !existsSync(F), 5000);
    await sleep(100);
    const c1 = await count();
    try { await moodle.deadlinesForApp(T); out.second = "ok"; } catch (e) { out.second = e.message; }
    try { await moodle.deadlinesForApp(T, { refresh: true }); out.third = "ok"; } catch (e) { out.third = e.message; }
    out.extraCalls = (await count()) - c1;
    out.stillStale = moodle.staleDeadlines(T) != null; // фон до выхода ещё видит прежние данные — как раньше
    await set("slow=0&dead=");
    await moodle.forgetUserDeadlines(TG, T, T); // новый вход этим же токеном снимает отметку
    try { const r = await moodle.deadlinesForApp(T); out.relogin = !r.stale && r.items.length === 1; } catch (e) { out.relogin = e.message; }
  } else if (op === "dead-early") {
    // Отказ до истечения срока ожидания — наверх как раньше (сообщение самого Moodle), копия удаляется.
    out.n = await restore();
    await set("dead=tok-a");
    try { await moodle.deadlinesForApp(T); out.first = "ok"; } catch (e) { out.first = e.message; }
    out.gone = await waitFor(() => !existsSync(F), 3000);
    try { await moodle.deadlinesForApp(T); out.second = "ok"; } catch (e) { out.second = e.message; }
    await set("dead=");
  } else if (op === "disk-off") {
    moodle.setOverrides(T, ov, TG);
    await pace.background("test", () => moodle.deadlines(T, true));
    await moodle.deadlines(T, true);
    await sleep(300);
    out.dirExists = existsSync(DISK);
    out.n = await restore();
    await moodle.forgetDeadlines(T);
    out.stamp = pace.stampAt("dl-drop:501");
  }
} catch (e) { out.error = String(e?.stack || e); }
console.log("RESULT " + JSON.stringify(out));
process.exit(0);
`);

function run(op, env = {}) {
  slowMs = 0; html = false; enrolOnce = 0; deadTok = new Set();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scenario.mjs", op], { cwd: SIM, windowsHide: true, env: { ...process.env, MOODLE_PACE: "0", MOODLE_PACE_DIR: PACE, MOODLE_DISK_DIR: DISK,
      USERPROFILE: join(root, "home"), HOME: join(root, "home"), PIN_ASSIGNS: "", MOODLE_DIRECT: "0", ...env } });
    let text = "";
    child.stdout.on("data", (d) => (text += d)); child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => child.kill(), 90e3);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const line = text.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT "));
      let r = null;
      try { r = line ? JSON.parse(line.slice(7)) : null; } catch { /* ниже */ }
      if (!r || r.error) console.log(`  (${op}: код ${code}) ${(r?.error || text).slice(-1200)}`);
      resolve(r || {});
    });
  });
}
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const rm = (p) => { try { unlinkSync(p); } catch { /* нет */ } };
const J = (x) => JSON.stringify(x);

// 1. Запись: фон ждёт копию, в файле нет ни токена, ни названий работ; токен без владельца копии не пишет.
let r = await run("write");
const text = existsSync(F) ? readFileSync(F, "utf8") : "";
let j = {}; try { j = JSON.parse(text); } catch { /* ниже */ }
check("фоновое чтение возвращается, когда копия уже на диске", r.before === false && r.fileNow === true, J(r));
check("копия зашифрована: поля v, tgId, at, semester, blob; токена и названий работ открытым текстом нет",
  J(Object.keys(j).sort()) === J(["at", "blob", "semester", "tgId", "v"]) && j.tgId === 501 && !text.includes("tok-a") && !/Секретное|ЛР1|Базы данных/.test(text) && String(j.blob).split(".").length === 3, text.slice(0, 120));
check("токен, чей владелец (tgId) неизвестен, копии не пишет", J(r.files) === J(["501.json"]), J(r.files));
const updated = r.updated;

// 2. Перезапуск с молодой копией: данные сразу, allowDisk — без Moodle, без allowDisk — чтение Moodle.
r = await run("restore-young");
check("после перезапуска staleDeadlines и deadlinesAt видят копию сразу", r.n?.restored === 1 && r.stale === updated && r.at === r.fileAt && r.at > 0, J(r.n));
check("deadlines(…, { allowDisk: true }) отдаёт молодую копию без запросов к Moodle", r.d1 === updated && r.callsAllowDisk === 0, `запросов ${r.callsAllowDisk}`);
check("первый setOverrides после старта с тем же выбором курсов копию не стирает", r.kept === true);
check("без allowDisk копия не в счёт: Moodle читается, данные новее, копия на диске переписана", r.d2 > updated && r.callsNoDisk >= 3 && r.rewritten === true, `запросов ${r.callsNoDisk}`);
check("экран приложения: свежие данные в памяти — сразу, без запросов и без stale", r.d3same === true && r.callsApp === 0, J({ d3same: r.d3same, callsApp: r.callsApp }));

r = await run("submit-reads");
check("отправка работы после перезапуска решает по Moodle, а не по копии", /нет файла/.test(r.err || "") && r.calls >= 4, `${r.err}; запросов ${r.calls}`);

// 3. Экран приложения после перезапуска: быстрый Moodle — свежие; медленный — копия с stale без moodle.down; наша очередь — так же.
r = await run("app-fast");
check("копия + быстрый Moodle: экран получает свежие данные, без stale", r.n?.restored === 1 && r.stale === false && r.newer === true, J(r));
r = await run("app-slow", { MOODLE_STALE_AFTER_MS: "300" });
check("копия + медленный Moodle: через ~0,3 с копия с stale: true, source: disk, без moodle.down", r.stale === true && r.source === "disk" && r.same === true && r.down === false && r.ms < 1500, J({ ms: r.ms, stale: r.stale, source: r.source, down: r.down }));
check("чтение после ответа не бросается — кэш дозаполняется", r.filled === true);
check("«Обновить» при медленном Moodle — прежние данные из памяти с stale, source: memory", r.refresh?.stale === true && r.refresh?.source === "memory" && r.refresh?.same === true && r.refresh?.ms < 1500, J(r.refresh));
r = await run("app-throttle", { MOODLE_STALE_AFTER_MS: "300", MOODLE_REFRESH_PARALLEL: "1" });
check("чтения «вдогонку» ограничены: второй заход при занятом месте — копия сразу, лишнего чтения нет", r.stale1 === true && r.stale2 === true && r.ms2 < 150 && r.filled === true && r.extra === 0, J(r));
r = await run("app-queue", { MOODLE_PACE: "1", MOODLE_CONC: "1", MOODLE_USER_GAP_MS: "0", MOODLE_QUEUE_WAIT_MS: "300", MOODLE_STALE_AFTER_MS: "5000", MOODLE_PACE_DIR: join(root, "usage-q") });
check("наша очередь не дождалась (QueueError) — копия с stale, без moodle.down и без ожидания 5 с", r.stale === true && r.source === "disk" && r.down === false && r.ms < 2500 && !r.err, J(r));
r = await run("app-outage", { MOODLE_STALE_AFTER_MS: "5000", MOODLE_PACE_DIR: join(root, "usage-o") });
check("сбой Moodle (техработы) — ошибка наверх, как раньше (сервер покажет копию с плашкой)", r.thrown === true && r.outage === true && r.stale === true, J(r));

// 4. Сбросы: forgetDeadlines (и уже идущая запись не воскрешает файл), отметка dl-drop, смена курсов, новый вход.
rm(F); rm(join(DISK, "502.json"));
r = await run("forget-race");
check("контроль: без сброса запись после чтения человека доходит до диска", r.control === true);
check("forgetDeadlines сразу после чтения: идущая запись файл не воскрешает", r.inFlight === true && r.afterForget === false && r.later === false && r.stale === null, J(r));
check("сброс ставит отметку dl-drop", r.stamp === true);
r = await run("restore-n");
check("после сброса и перезапуска копии нет", r.n?.restored === 0 && r.exists === false && r.stale === false, J(r.n));

await run("write");
const saved = readFileSync(F);
r = await run("forget-only");
check("forgetDeadlines удаляет файл", r.gone === true);
writeFileSync(F, saved); // как будто удалить не дали (EPERM)
r = await run("restore-n");
check("копия не новее отметки сброса при старте не берётся и удаляется", r.n?.restored === 0 && r.n?.bad === 1 && r.exists === false, J(r.n));

await run("write");
r = await run("ovchange");
check("смена выбора курсов стирает копию и запись в памяти", r.n?.restored === 1 && r.gone === true && r.stale === null, J(r));
await run("write");
r = await run("login-forget");
check("новый вход (forgetUserDeadlines) стирает копию и запись в памяти", r.n?.restored === 1 && r.gone === true && r.stale === null, J(r));

// 4а. Находки ревью 15 окт 2026: запоздавшее чтение и выбор курсов (#0), отзыв токена при выходе и новом входе
// (#1, #23, #24), мёртвый токен за копией (#2).
r = await run("course-race");
check("#0: запоздавшее чтение по прежнему выбору курсов не затирает список курсов быстрого опроса",
  J(r.q0) === "[]" && J(r.q1) === "[11]" && J(r.lateCourses) === "[]" && J(r.q2) === "[11]", J(r));
r = await run("course-race", { MOODLE_DISK: "0", MOODLE_DISK_DIR: join(root, "dl-off-race"), MOODLE_PACE_DIR: join(root, "usage-off-race") });
check("#0 при MOODLE_DISK=0 — так же", J(r.q1) === "[11]" && J(r.q2) === "[11]", J(r));
rm(F);
r = await run("revoke-logout");
check("#1/#23: после выхода ни идущее чтение, ни обход по старому списку вошедших копию на диск не возвращают",
  r.before === true && r.afterLogout === false && r.afterInflight === false && r.afterTick === false, J(r));
rm(F);
r = await run("relogin-other");
check("#24: вход другой учётной записью — обход с прежним токеном не перезаписывает копию и не отвязывает новый токен",
  r.bWrote === true && r.notOverwritten === true && r.bStillBound === true, J(r));
r = await run("restore-n", { SC_TOKEN: "tok-b" });
check("#24: после «перезапуска» копия расшифровывается новым токеном (в файле данные новой учётной записи)", r.n?.restored === 1, J(r.n));
rm(F);
r = await run("relogin-same");
check("вход заново тем же токеном (после выхода и без него) и restoreDisk снимают отзыв — копия снова пишется",
  r.afterRelogin === true && r.goneOnLogin === true && r.again === true && r.afterRestore === true, J(r));
await run("write");
r = await run("dead-late", { MOODLE_STALE_AFTER_MS: "300" });
check("#2: отказ invalidtoken после срока ожидания — копия удалена, следующие вызовы бросают «invalidtoken…» без запросов к Moodle",
  r.n?.restored === 1 && r.first?.stale === true && r.first?.source === "disk" && r.gone === true && /^invalidtoken\b/.test(r.second || "") && /^invalidtoken\b/.test(r.third || "") && r.extraCalls === 0, J(r));
check("#2: новый вход этим же токеном снимает отметку — свежие данные", r.relogin === true, J(r.relogin));
await run("write");
r = await run("dead-early");
check("#2: отказ invalidtoken до срока ожидания — наверх как раньше (ответ Moodle), копия удалена",
  /^invalidtoken: Ключ недействителен/.test(r.first || "") && r.gone === true && /^invalidtoken\b/.test(r.second || ""), J(r));

// 5. Неподходящие копии выбрасываются, файл удаляется.
const discard = async (name, env, prep) => {
  await run("write");
  if (prep) prep();
  const x = await run("restore-n", env);
  check(name, x.n?.restored === 0 && (x.n?.bad === 1 || x.n?.old === 1) && x.exists === false && x.stale === false, J(x.n));
};
await discard("другая версия кода (PIN_ASSIGNS) — копия выброшена, файл удалён", { PIN_ASSIGNS: "777" });
await discard("другой токен у того же пользователя — не расшифровывается, файл удалён", { SC_TOKEN: "tok-b" });
await discard("другой выбор курсов при старте — не расшифровывается, файл удалён", { SC_OV: J({ 11: false }) });
await discard("подменённый blob — не расшифровывается, файл удалён", {}, () => {
  const x = JSON.parse(readFileSync(F, "utf8")); const [a, b, c] = x.blob.split(".");
  x.blob = [a, b, (c[5] === "A" ? "B" : "A") + c.slice(1, 5) + c[0] + c.slice(6)].join("."); writeFileSync(F, JSON.stringify(x));
});
await discard("подменённый семестр — копия выброшена, файл удалён", {}, () => { const x = JSON.parse(readFileSync(F, "utf8")); x.semester = "Весна 1999"; writeFileSync(F, JSON.stringify(x)); });
await discard("копия старше MOODLE_DISK_MAX_MS — выброшена, файл удалён", { MOODLE_DISK_MAX_MS: "1" });
await discard("испорченный JSON — копии нет, файл удалён", {}, () => writeFileSync(F, "{oops"));
check("отложенная копия испорченного файла (.bad-*) убрана чисткой", !readdirSync(DISK).some((f) => f.includes(".bad-")), J(readdirSync(DISK)));

// 6. Чистка при старте: обрывки записи, копии не вошедших, отложенные испорченные.
await run("write");
writeFileSync(join(DISK, "999.json"), "{}");
writeFileSync(join(DISK, "501.json.1234.abcd.tmp"), "x");
writeFileSync(join(DISK, "501.json.bad-20261015-120000"), "x");
r = await run("restore-n");
check("чистка при старте: *.tmp, *.bad-* и копии не вошедших удалены, своя копия цела", r.n?.restored === 1 && J(r.files) === J(["501.json"]) && r.n?.removed === 3, J({ n: r.n, files: r.files }));

// 7. MOODLE_DISK=0 — всё как раньше: файлов нет, восстановления нет, отметок сброса нет.
r = await run("disk-off", { MOODLE_DISK: "0", MOODLE_DISK_DIR: join(root, "dl-off"), MOODLE_PACE_DIR: join(root, "usage-off") });
check("MOODLE_DISK=0: папки копий нет, restoreDisk ничего не делает, сброс отметку не ставит", r.dirExists === false && r.n?.restored === 0 && r.stamp === 0, J(r));
// #27: функция работала, потом её выключили — прежние копии при старте удаляются (чужие файлы в папке не трогаются).
{
  const OFF = join(root, "dl-off-old");
  mkdirSync(OFF, { recursive: true });
  for (const f of ["501.json", "502.json", "501.json.1234.abcd.tmp", "501.json.bad-20261015-120000", "keep.txt"]) writeFileSync(join(OFF, f), "x");
  r = await run("restore-n", { MOODLE_DISK: "0", MOODLE_DISK_DIR: OFF, MOODLE_PACE_DIR: join(root, "usage-off2") });
  check("#27: MOODLE_DISK=0 — при старте прежние копии (*.json, *.tmp, *.bad-*) удалены", r.n?.restored === 0 && r.n?.removed === 4 && J(r.files) === J(["keep.txt"]), J({ n: r.n, files: r.files }));
}

// 8. Копия сервера целиком: вход, первое открытие (копия на диск), kill и запуск заново, открытие при медленном Moodle,
// дочитывание, выход (копия удалена). Окружение — как у load-test: туннели, копия данных, сторож и Gateway выключены.
{
  const SPORT = 9972, SB = `http://127.0.0.1:${SPORT}`, BOT = "123456:DISK-TEST", SDISK = join(root, "dl-srv"), SF = join(SDISK, "7001.json");
  const SHOME = join(root, "srv-home"), SAPPDATA = join(root, "srv-appdata");
  writeFileSync(join(SIM, "bot-token.txt"), BOT);
  writeFileSync(join(SIM, "current-url.txt"), "https://disk.example.test");
  mkdirSync(join(SAPPDATA, "npm", "node_modules", "openclaw"), { recursive: true }); // OpenClaw нет: его вызовы падают сразу
  mkdirSync(SHOME, { recursive: true });
  let srv = null, slog = "", allLog = ""; // slog — журнал последнего запуска, allLog — обоих
  const start = async () => {
    slog = "";
    srv = spawn(process.execPath, ["server.mjs"], { cwd: SIM, windowsHide: true, env: { ...process.env, PORT: String(SPORT), HOST: "127.0.0.1", USERPROFILE: SHOME, HOME: SHOME, APPDATA: SAPPDATA,
      LOCALAPPDATA: join(root, "srv-local"), PIN_ASSIGNS: "", GATEWAY_URL: FAKE + "/campus", CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0", BOT_UPDATES: "1", MOODLE_NIGHT: "off",
      MOODLE_PACE: "0", MOODLE_DIRECT: "0", MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/", MISIS_SCHEDULE_INDEX: FAKE + "/schedule/",
      MOODLE_DISK_DIR: SDISK, MOODLE_STALE_AFTER_MS: "500" } });
    const onOut = (d) => { slog += d; allLog += d; };
    srv.stdout.on("data", onOut); srv.stderr.on("data", onOut);
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${SB}/api/health`)).ok) return true; } catch { /* стартует */ } await sleep(200); }
    return false;
  };
  const kill = async () => { if (!srv || srv.exitCode !== null) return; const gone = new Promise((r2) => srv.once("exit", r2)); srv.kill(); await gone; };
  process.on("exit", () => { try { srv?.kill(); } catch { /* уже нет */ } });
  const initData = (id) => {
    const params = new URLSearchParams({ auth_date: String(nowS()), query_id: "q" + id, user: JSON.stringify({ id, first_name: "Диск" + id, username: "disk" + id }) });
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    params.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(dataCheck).digest("hex"));
    return params.toString();
  };
  const api = async (path, body, id = 7001) => {
    const t = Date.now();
    try {
      const res = await fetch(SB + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(60e3),
        headers: { "x-telegram-init-data": initData(id), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j = null; try { j = await res.json(); } catch { /* не JSON */ }
      return { s: res.status, j, ms: Date.now() - t };
    } catch (e) { return { s: String(e.name || e), j: null, ms: Date.now() - t }; }
  };
  try {
    const up1 = await start();
    const login = await api("/api/login", { username: "u7001", password: "ok-u7001" });
    const d1 = await api("/api/deadlines");
    const wrote = await waitFor(() => existsSync(SF), 3000);
    check("сервер: вход и первое открытие — свежие данные, копия легла на диск", up1 && login.s === 200 && d1.s === 200 && !d1.j?.stale && d1.j?.items?.length === 1 && wrote,
      `старт ${up1}, вход ${login.s}, дедлайны ${d1.s} stale=${d1.j?.stale}, файл ${wrote}`);
    await kill();
    // К второму запуску (находки ревью #4 и #25, 15 окт 2026): испорченный файл другого пользователя — владельцу сообщение
    // без содержимого; отложенные копии .bad-* старше 30 дней удаляются при старте, свежие остаются.
    const SU = join(SIM, "users"), SN = join(SIM, "notify"), SJ = join(SIM, "jobs");
    for (const d of [SU, SN, SJ]) mkdirSync(d, { recursive: true });
    writeFileSync(join(SU, "8888.json"), '{"tgId": 8888, "fullName": "СЕКРЕТ-ПОРЧИ"');
    const oldBad = [join(SN, "9999.json.bad-20250101-000000"), join(SJ, "9999-5.json.bad-20250101-000000")], youngBad = join(SN, "9999.json.bad-20261015-000000");
    for (const p of [...oldBad, youngBad]) writeFileSync(p, "x");
    const longAgo = new Date(Date.now() - 40 * 86400e3);
    for (const p of oldBad) utimesSync(p, longAgo, longAgo);
    tgSent.length = 0;
    const up2 = await start();
    const line = /deadlines-disk: восстановлено (\d+) из (\d+)/.exec(slog);
    slowMs = 800;
    const d2 = await api("/api/deadlines");
    check("сервер после kill и запуска: копия восстановлена до listen; медленный Moodle — копия с stale, source: disk, без плашки, за ~0,5 с",
      up2 && line?.[1] === "1" && d2.s === 200 && d2.j?.stale === true && d2.j?.source === "disk" && !d2.j?.moodle && d2.j?.updated === d1.j?.updated && d2.ms < 2500,
      `${line?.[0] || "строки о восстановлении нет"}; ${d2.s} stale=${d2.j?.stale} source=${d2.j?.source} moodle=${J(d2.j?.moodle)} за ${d2.ms} мс`);
    slowMs = 0;
    let d3 = null;
    for (let i = 0; i < 15 && !(d3?.s === 200 && !d3.j?.stale); i++) { await sleep(700); d3 = await api("/api/deadlines"); }
    check("сервер: начатое чтение дозаполнило кэш — следующее открытие свежими данными без stale", d3?.s === 200 && !d3.j?.stale && d3.j?.updated > d1.j?.updated, `${d3?.s} stale=${d3?.j?.stale}`);
    const ownerMsg = () => tgSent.find((m) => m.chat_id === 945210206 && /8888\.json/.test(m.text || ""))?.text || "";
    await waitFor(() => !!ownerMsg(), 3000);
    const msg = ownerMsg();
    check("#4: испорченный users\\8888.json — владельцу сообщение: путь относительно папки приложения и имя .bad-копии, без содержимого",
      /users[\\/]8888\.json/.test(msg) && /8888\.json\.bad-\d{8}-\d{6}/.test(msg) && !msg.includes("СЕКРЕТ") && !msg.includes(SIM), msg || J(tgSent.map((m) => m.chat_id)));
    const cleaned = await waitFor(() => oldBad.every((p) => !existsSync(p)), 3000);
    check("#25: отложенные копии *.bad-* старше 30 дней удалены при старте, свежие на месте", cleaned && existsSync(youngBad), J({ old: oldBad.map((p) => existsSync(p)), young: existsSync(youngBad) }));
    // #21: users\7002.json не читается (здесь — папка вместо файла: StateReadError) — вход отвечает 424 и попыткой не считается.
    mkdirSync(join(SU, "7002.json"), { recursive: true });
    const tries = [];
    for (let i = 0; i < 6; i++) tries.push((await api("/api/login", { username: "u7001", password: "ok-u7001" }, 7002)).s);
    rmSync(join(SU, "7002.json"), { recursive: true, force: true });
    check("#21: файл пользователя не читается — вход отвечает 424 и в счёт неудачных попыток не идёт (шестая — не 429)", tries.every((s) => s === 424), J(tries));
    const myBad = join(SU, "7001.json.bad-20261015-120000");
    writeFileSync(myBad, "x");
    const out = await api("/api/logout", {});
    const gone = await waitFor(() => !existsSync(SF), 2000);
    check("сервер: выход удаляет копию дедлайнов с диска", out.s === 200 && out.j?.loggedIn === false && gone, `${out.s} файл удалён: ${gone}`);
    check("#25: выход удаляет отложенные копии users\\7001.json.bad-* этого человека, чужие на месте", !existsSync(myBad) && readdirSync(SU).some((f) => f.startsWith("8888.json.bad-")), J(readdirSync(SU)));
    // Вход заново: Moodle выдаёт тот же токен — отзыв (выход) с него снят, копия снова пишется.
    const login2 = await api("/api/login", { username: "u7001", password: "ok-u7001" });
    const d4 = await api("/api/deadlines");
    const wrote2 = await waitFor(() => existsSync(SF), 3000);
    check("сервер: вход заново тем же токеном после выхода — копия снова ложится на диск", login2.s === 200 && d4.s === 200 && !d4.j?.stale && wrote2, `вход ${login2.s}, дедлайны ${d4.s} stale=${d4.j?.stale}, файл ${wrote2}`);
    // #2: токен умер (сменили пароль), а Moodle отвечает дольше срока ожидания: экран сначала получает прежние данные,
    // отказ приходит позже — копия удаляется, и следующее открытие снимает вход.
    slowMs = 800; deadTok = new Set(["tok-u7001"]);
    const d5 = await api("/api/deadlines?refresh");
    const gone2 = await waitFor(() => !existsSync(SF), 4000);
    const d6 = await api("/api/deadlines");
    slowMs = 0; deadTok = new Set();
    const me = await api("/api/me");
    check("#2 сервер: токен умер при медленном Moodle — сначала прежние данные (stale), потом копия удалена и вход снят (401 login_required)",
      d5.s === 200 && d5.j?.stale === true && gone2 && d6.s === 401 && d6.j?.error === "login_required" && me.j?.loggedIn === false,
      `${d5.s} stale=${d5.j?.stale}; файл удалён ${gone2}; ${d6.s} ${J(d6.j)}; loggedIn=${me.j?.loggedIn}`);
    const errs = allLog.split(/\r?\n/).filter((l) => /Unhandled|unhandledRejection|TypeError|ReferenceError|копия не (записана|удалена)|обход прерван/.test(l));
    check("в журнале копии сервера нет необработанных ошибок и сбоев записи копии", !errs.length, errs.slice(0, 3).join(" ⏎ "));
    check("в журнале копии сервера нет токена", !allLog.includes("tok-u7001"));
  } finally { await kill(); }
}

fake.closeAllConnections();
await new Promise((r2) => fake.close(r2));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
