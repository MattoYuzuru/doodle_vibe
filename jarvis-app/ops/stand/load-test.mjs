// Нагрузочная проверка Doodle на стенде (15 окт 2026): N пользователей, поддельный Moodle с задержками как у настоящей
// сети, ограничитель запросов к Moodle (moodle-pace) включён как в работе (--pace=off — без пауз, для замера самого
// сервера). Настоящие Moodle, журнал, Telegram, misis.ru и данные пользователей НЕ затрагиваются: копия сервера лежит в
// %TEMP%\doodle-load, все внешние адреса подменены на 127.0.0.1:9944, домашняя папка и APPDATA процесса — свои.
// Порты 8898 и 9944 — не те, что у sim-test (8799/9911) и живого сервера (8787), но запускать вместе с sim-test не стоит:
// замеры обоих исказятся.
//
// Запуск: node ops\stand\load-test.mjs 100 [--pace=off] [--wait=15] [--restart]
//   N — число пользователей (по 25 в группе, у группы 8 своих курсов); --wait — сколько минут ждать первых обходов и
//   доставки уведомлений. Итог — в консоль и в %TEMP%\doodle-load\result-<N>.json.
//   --restart (15 окт 2026, «дедлайны на диск»): после открытия из памяти копия сервера убивается (как на живом ПК) и
//   запускается заново из той же папки — копии дедлайнов deadlines-cache\ остаются, — и все разом открывают приложение:
//   задержка /api/deadlines и сколько ответов пришло прежними данными (stale) — в result.phases.restartOpen.
//
// Что меряется: (1) вход N человек волнами по 10; (2) все разом открывают приложение (дедлайны ещё не прочитаны —
// как после перезапуска сервера); (3) то же повторно (из памяти); (4) все разом открывают «Сессию»; (5) фон: за сколько
// времени быстрый опрос тестов и проверка материалов доходят до каждого, через сколько приходят «Новый тест» и «Новый
// материал» после появления в курсе; память и процессор сервера, отклик /api/health (задержки цикла событий).
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const ROOT = join(tmpdir(), "doodle-load"), SIM = join(ROOT, "app");
const FAKE_PORT = 9944, PORT = 8898, FAKE = `http://127.0.0.1:${FAKE_PORT}`, B = `http://127.0.0.1:${PORT}`;
const BOT = "123456:LOAD-TEST-TOKEN";
const args = process.argv.slice(2);
const opt = (name, d) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=")[1] : d; };
const N = Number(args.find((a) => /^\d+$/.test(a)) || 50);
const PACE = opt("pace", "on") !== "off";
const WAIT_MS = Number(opt("wait", 15)) * 60e3;
// --app=<папка> — модули сервера (*.mjs) взять из другой папки (сравнение «до/после» на сохранённой копии кода);
// --tag=<метка> — добавить к имени файла итога.
const CODE = opt("app", APP), TAG = opt("tag", "");
// --steady=<мин> — после первых обходов ещё столько минут обычной работы: запросы к Moodle в минуту и повторный замер
// доставки «Новый тест» / «Новый материал», когда сервер уже знает «тихие» курсы.
const STEADY_MS = Number(opt("steady", 0)) * 60e3;
const RESTART = args.includes("--restart");
const GROUP_SIZE = 25, COURSES = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} с] ${s}`);

// ---------- копия сервера с подменёнными адресами ----------
for (const p of [8787, 8799, 9911]) if (p === PORT || p === FAKE_PORT) throw new Error("порт занят живым сервером или стендом");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
const patch = { "https://newlms.misis.ru": FAKE, "https://api.telegram.org": `${FAKE}/tg`, "https://dnevuch.ru": `${FAKE}/dnevuch`, "https://campusapp.ru": `${FAKE}/campus`, "https://ej.misis.ru": `${FAKE}/ej` };
// Отметки длительности обходов (только в копии): по ним видно, сколько занимает один проход по всем пользователям.
const passes = [["notify", "notifyBusy = true;", "finally { notifyBusy = false; }"], ["quick", "quickBusy = true;", "finally { quickBusy = false; }"], ["materials", "materialsBusy = true;", "finally { materialsBusy = false; }"]];
for (const f of readdirSync(CODE).filter((x) => x.endsWith(".mjs"))) {
  let src = readFileSync(join(CODE, f), "utf8");
  for (const [a, b] of Object.entries(patch)) src = src.split(a).join(b);
  if (f === "server.mjs") for (const [name, start, end] of passes) {
    if (!src.includes(start) || !src.includes(end)) throw new Error(`server.mjs: не нашёл «${start}» — поправьте load-test.mjs`);
    src = src.replace(start, `${start} const __t_${name} = Date.now();`).replace(end, `finally { ${end.slice(10, -2)}; console.log(\`LOADTEST pass ${name} \${Date.now() - __t_${name}}\`); }`);
  }
  writeFileSync(join(SIM, f), src);
}
for (const f of readdirSync(APP).filter((x) => x.endsWith(".md") && /instruction|lab-report/.test(x))) cpSync(join(APP, f), join(SIM, f));
for (const f of ["schedule_xls.py", "curriculum_pdf.py", "session_xls.py", "sheet_xls.py"]) cpSync(join(APP, f), join(SIM, f));
writeFileSync(join(SIM, "bot-token.txt"), BOT);
writeFileSync(join(SIM, "current-url.txt"), "https://load.example.test");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(ROOT, "home"), APPDATA = join(ROOT, "appdata");
mkdirSync(join(APPDATA, "npm", "node_modules", "openclaw"), { recursive: true }); // OpenClaw нет: вызовы агента и Gateway падают сразу
mkdirSync(HOME, { recursive: true });

// ---------- поддельный Moodle, Telegram, «Дневач», misis.ru ----------
const SUBJECTS = ["Теория информационных процессов и систем", "Моделирование информационных процессов и систем", "Цифровая электроника", "Методы оптимизации",
  "Оптимизация клиент-серверных приложений", "Операционные системы", "Иностранный язык", "Базы данных"];
const groupOf = (n) => Math.floor((n - 1) / GROUP_SIZE);
const GROUPS = Array.from({ length: Math.ceil(N / GROUP_SIZE) }, (_, g) => `БИСТ-24-ПО-${g + 1}`);
const coursesOf = (n) => Array.from({ length: COURSES }, (_, k) => 100000 + groupOf(n) * 100 + k + 1);
const userOf = (token) => { const m = /^tok-u(\d+)$/.exec(token || ""); return m ? Number(m[1]) : null; };
const extraQuiz = new Map(); // курс → тест, появившийся по ходу проверки
const extraMods = new Map(); // курс → [{ id, name, at }]
const stats = { http: 0, inner: 0, byFn: {}, perMin: {}, quick: new Map(), contentsFirst: new Map(), probes: 0, own: 0, active: 0, peak: 0 };
const note = (fn, inner) => { if (inner) stats.inner++; else { stats.http++; const m = Math.floor((Date.now() - t0) / 60e3); stats.perMin[m] = (stats.perMin[m] || 0) + 1; } stats.byFn[fn] = (stats.byFn[fn] || 0) + 1; };
const flatParams = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") flatParams(v, key, out); else out[key] = v; } return out; };
const idsFrom = (p) => Object.keys(p).filter((k) => /^courseids\[\d+\]$/.test(k)).map((k) => Number(p[k]));

function ws(fn, p, n, inner) {
  note(fn, inner);
  const mine = coursesOf(n);
  switch (fn) {
    case "tool_mobile_call_external_functions": {
      const responses = [];
      for (let i = 0; p[`requests[${i}][function]`]; i++) {
        let a = {}; try { a = JSON.parse(p[`requests[${i}][arguments]`] || "{}"); } catch { /* пусто */ }
        const r = ws(p[`requests[${i}][function]`], flatParams(a), n, true);
        responses.push(r && r.exception ? { error: true, exception: JSON.stringify(r) } : { error: false, data: JSON.stringify(r) });
      }
      return { responses };
    }
    case "core_webservice_get_site_info": return { userid: 1000 + n, fullname: `Студент ${n} Нагрузочный`, username: `u${n}` };
    case "core_enrol_get_users_courses": return [
      ...mine.map((id, k) => ({ id, fullname: `${SUBJECTS[k]}. Осень 2026`, hidden: false, lastaccess: nowS() - 3600, startdate: nowS() - 40 * 86400 })),
      { id: 900000 + n, fullname: `Старый курс ${n}. Весна 2026`, hidden: true, lastaccess: nowS() - 150 * 86400, startdate: nowS() - 250 * 86400 },
    ];
    case "mod_assign_get_assignments": return { courses: idsFrom(p).map((id) => ({ id, fullname: `c${id}`, assignments: id >= 900000 ? [] : [1, 2, 3].map((k) => ({
      id: id * 10 + k, cmid: id * 100 + k, name: `ЛР${k} курса ${id}`, duedate: nowS() + (k * 3 + (id % 5)) * 86400, grade: 10, allowsubmissionsfromdate: nowS() - 20 * 86400, timemodified: nowS() - 20 * 86400,
      submissiondrafts: 1, configs: [["enabled", "1"], ["maxfilesubmissions", "1"], ["filetypeslist", ".pdf"]].map(([name, value]) => ({ plugin: "file", subtype: "assignsubmission", name, value })) })) })) };
    case "mod_quiz_get_quizzes_by_courses": {
      if (!inner) { const a = stats.quick.get(n) || []; a.push(Date.now()); stats.quick.set(n, a); }
      return { quizzes: idsFrom(p).filter((id) => id < 900000).flatMap((id) => [{ id: id * 10 + 9, course: id, coursemodule: id * 100 + 9, name: `Тест курса ${id}`, timeopen: nowS() - 7 * 86400, timeclose: nowS() + 5 * 86400, grade: 10, sumgrades: 10, visible: 1, timelimit: 600, attempts: 1 },
        ...(extraQuiz.has(id) ? [extraQuiz.get(id)] : [])]) };
    }
    case "mod_assign_get_submission_status": return { lastattempt: { submission: { id: n * 1e6 + Number(p.assignid), status: Number(p.assignid) % 3 === 0 ? "submitted" : "new" }, canedit: true, gradingstatus: "notgraded" } };
    case "mod_quiz_get_user_best_grade": return { hasgrade: false };
    case "mod_quiz_get_user_attempts": return { attempts: [] };
    case "mod_quiz_get_quiz_access_information": return { canattempt: true, preventaccessreasons: [] };
    case "mod_quiz_get_attempt_access_information": return { isfinished: false, preventnewattemptreasons: [] };
    case "core_comment_get_comments": return { comments: [] };
    case "core_group_get_course_user_groups": return { groups: [{ name: `${GROUPS[groupOf(n)]}  Глобальная группа` }] };
    case "core_course_get_updates_since": {
      const cid = Number(p.courseid), since = Number(p.since);
      // Как настоящий Moodle: новый тест — тоже изменение модуля курса.
      const q = extraQuiz.get(cid), quizMod = q && q.addedAt >= since ? [{ contextlevel: "module", id: q.coursemodule, updates: [{ name: "configuration" }] }] : [];
      return { instances: [...(extraMods.get(cid) || []).filter((m) => m.at >= since).map((m) => ({ contextlevel: "module", id: m.id, updates: [{ name: "configuration" }] })), ...quizMod] };
    }
    case "core_course_get_contents": {
      const cid = Number(p.courseid);
      if (!stats.contentsFirst.has(`${n}:${cid}`)) stats.contentsFirst.set(`${n}:${cid}`, Date.now());
      const q = extraQuiz.get(cid);
      return [{ name: "Общее", modules: [{ id: cid * 100 + 50, name: "Методичка", modname: "resource", visible: 1, uservisible: true, url: `${FAKE}/mod/resource/view.php?id=${cid * 100 + 50}` },
        ...(extraMods.get(cid) || []).map((m) => ({ id: m.id, name: m.name, modname: "resource", visible: 1, uservisible: true, url: `${FAKE}/mod/resource/view.php?id=${m.id}` })),
        ...(q ? [{ id: q.coursemodule, name: q.name, modname: "quiz", visible: 1, uservisible: true, url: `${FAKE}/mod/quiz/view.php?id=${q.coursemodule}` }] : [])] }];
    }
    case "mod_forum_get_forums_by_courses": return idsFrom(p).map((id) => ({ id: id * 10 + 5, course: id, type: "news", name: "Объявления", numdiscussions: 0 }));
    case "mod_forum_get_forum_discussions": return { discussions: [] };
    case "gradereport_user_get_grade_items": return { usergrades: [{ gradeitems: [{ itemname: "ЛР1", itemtype: "mod", graderaw: 7, grademax: 10 }, { itemname: "ЛР2", itemtype: "mod", graderaw: null, grademax: 10 }, { itemname: "Итог", itemtype: "course", graderaw: 7, grademax: 100 }] }] };
    case "mod_page_get_pages_by_courses": return { pages: [] };
    case "core_course_get_courses_by_field": return { courses: String(p.value).split(",").map((v) => ({ id: Number(v), summary: "", contacts: [] })) };
    case "core_user_get_course_user_profiles": return [];
    default: return { exception: "x", errorcode: "unknownfn", message: fn };
  }
}
const tgSent = []; // { chat, text, at }
const dnevuchPage = () => `<html><script>var groups=${JSON.stringify(GROUPS.map((g) => ({ number: g })))};\nlet scheduleData = ${JSON.stringify([[{ date: new Date().toISOString().slice(0, 10), time: "09:00 - 10:35", classes: [{ name: SUBJECTS[0], lessonType: "Лекционные", teacher: "", place: "ауд. 1", subGroup: "" }] }]])};\n</script></html>`;
const fake = createServer((req, res) => {
  const chunks = []; req.on("data", (d) => chunks.push(d));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, FAKE);
    const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const html = (t) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(t); };
    if (url.pathname.startsWith("/tg/")) {
      if (url.pathname.endsWith("/getUpdates")) { await sleep(20e3); return json({ ok: true, result: [] }); } // как долгий опрос Telegram
      if (url.pathname.endsWith("/sendMessage")) { try { const j = JSON.parse(body || "{}"); tgSent.push({ chat: Number(j.chat_id), text: String(j.text || ""), at: Date.now() }); } catch { /* */ } }
      await sleep(60 + Math.random() * 60); // Bot API отвечает за ~0,1 с
      return json({ ok: true, result: { message_id: tgSent.length } });
    }
    if (url.pathname.startsWith("/dnevuch")) return html(dnevuchPage());
    if (url.pathname.startsWith("/eduop")) return html(`<a href="/sveden/files/x/Opisanie_09.03.02-BIST-24.plx.pdf">Описание результатов освоения образовательных траекторий 09.03.02-БИСТ-24.plx</a> <a href="/sveden/files/aic/09.03.02-BIST-24.plx.pdf">Учебный план</a>`);
    if (url.pathname.endsWith("/09.03.02-BIST-24.plx.pdf")) { res.writeHead(200, { "content-type": "application/pdf" }); return res.end(readFileSync(join(HERE, "fixtures", "09.03.02-BIST-24.plx.pdf"))); }
    if (url.pathname.startsWith("/session") || url.pathname.startsWith("/schedule")) return html("<p>Информация будет опубликована позже.</p>");
    if (url.pathname.startsWith("/campus")) return json({ items: [] });
    if (url.pathname.startsWith("/ej")) { res.writeHead(404); return res.end("not found"); }
    const p = Object.fromEntries(new URLSearchParams(body));
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    const batch = p.wsfunction === "tool_mobile_call_external_functions" ? Object.keys(p).filter((k) => /^requests\[\d+\]\[function\]$/.test(k)).length : 0;
    await sleep(batch ? 120 + 12 * batch + Math.random() * 80 : 80 + Math.random() * 140); // RTT ~90 мс + работа Moodle
    stats.active--;
    if (url.pathname === "/login/token.php") return json(p.password === `ok-${p.username}` && /^u\d+$/.test(p.username) ? { token: `tok-${p.username}` } : { error: "Неверный логин или пароль" });
    const n = userOf(p.wstoken);
    if (!n) return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Ключ недействителен" });
    json(ws(p.wsfunction, p, n, false));
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

// ---------- копия сервера ----------
const serverLog = join(ROOT, "server.log");
writeFileSync(serverLog, "");
const passLog = { notify: [], quick: [], materials: [] };
let restoredLine = null; // строка сервера «deadlines-disk: восстановлено …» последнего запуска
const onOut = (d) => {
  appendFileSync(serverLog, d);
  for (const m of String(d).matchAll(/LOADTEST pass (\w+) (\d+)/g)) passLog[m[1]].push({ at: Date.now(), ms: Number(m[2]) });
  const r = /deadlines-disk: восстановлено[^\r\n]*/.exec(String(d));
  if (r) restoredLine = r[0];
};
let child = null;
// Запуск копии сервера и ожидание /api/health. Для --restart — второй раз из той же папки: users\, users.key,
// deadlines-cache\ и отметки moodle-pace переживают перезапуск, как на живом ПК.
async function startServer() {
  child = spawn(process.execPath, ["server.mjs"], { cwd: SIM, windowsHide: true, env: {
    ...process.env, PORT: String(PORT), HOST: "127.0.0.1", USERPROFILE: HOME, HOME, APPDATA, LOCALAPPDATA: join(ROOT, "local"), PIN_ASSIGNS: "",
    GATEWAY_URL: FAKE + "/campus", CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0", BOT_UPDATES: "1", MOODLE_NIGHT: "off",
    MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/", MISIS_SCHEDULE_INDEX: FAKE + "/schedule/",
    PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(process.env.APPDATA || "", "Python"), ...(PACE ? {} : { MOODLE_PACE: "0" }),
  } });
  child.stdout.on("data", onOut); child.stderr.on("data", onOut);
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* стартует */ } await sleep(200); }
}
const stop = () => { try { child?.kill(); } catch { /* */ } fake.close(); };
process.on("exit", stop);
await startServer();

// ---------- клиент ----------
function initData(id) {
  const params = new URLSearchParams({ auth_date: String(nowS()), query_id: "q" + id, user: JSON.stringify({ id, first_name: "Нагр" + id, username: "load" + id }) });
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheck).digest("hex"));
  return params.toString();
}
const lat = {}; // путь → [мс]; коды ответов — codes
const codes = {};
async function api(id, path, body, label = path.split("?")[0]) {
  const t = Date.now();
  let s = 0, j = null;
  try {
    // Адрес клиента — как у запроса через туннель Cloudflare (у каждого свой).
    const r = await fetch(B + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(180e3),
      headers: { "x-telegram-init-data": initData(id), "cf-connecting-ip": `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    s = r.status; try { j = await r.json(); } catch { /* не JSON */ }
  } catch (e) { s = e.name === "TimeoutError" ? "timeout" : "net"; }
  (lat[label] ||= []).push(Date.now() - t);
  (codes[label] ||= {})[s] = ((codes[label] ||= {})[s] || 0) + 1;
  return { s, j };
}
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const sum = (label) => { const a = lat[label] || []; return { n: a.length, p50: q(a, 0.5), p95: q(a, 0.95), max: a.length ? Math.max(...a) : null, codes: codes[label] }; };
const resetLat = () => { for (const k of Object.keys(lat)) delete lat[k]; for (const k of Object.keys(codes)) delete codes[k]; };
const ids = Array.from({ length: N }, (_, i) => 7001 + i), nOf = (id) => id - 7000;

// Память и процессор копии сервера раз в 15 с; отклик /api/health раз в 2 с (задержки цикла событий).
const proc = [];
const sampleProc = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id ${child.pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.TotalProcessorTime.TotalMilliseconds)"`], { encoding: "utf8", windowsHide: true });
  const [ws, priv, cpu] = String(r.stdout || "").trim().split(/\s+/).map(Number);
  if (ws) proc.push({ at: Date.now(), ws, priv, cpu, pid: child.pid }); // pid — после --restart счётчик процессора начинается заново
};
const procTimer = setInterval(sampleProc, 15e3);
const health = [];
const healthTimer = setInterval(async () => { const t = Date.now(); try { await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(30e3) }); } catch { /* */ } health.push(Date.now() - t); }, 2000);
sampleProc();
const result = { N, pace: PACE, groups: GROUPS.length, courses: GROUPS.length * COURSES, phases: {} };

try {
  log(`== ${N} пользователей, групп ${GROUPS.length}, курсов ${GROUPS.length * COURSES}, ограничитель Moodle ${PACE ? "как в работе" : "выключен"} ==`);
  // 1. Вход волнами по 10 (люди приходят не все в одну секунду) + выбор группы.
  let t = Date.now();
  for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map(async (id) => {
    await api(id, "/api/me");
    await api(id, "/api/login", { username: `u${nOf(id)}`, password: `ok-u${nOf(id)}` });
    await api(id, "/api/group", { group: GROUPS[groupOf(nOf(id))] });
  }));
  result.phases.login = { ms: Date.now() - t, login: sum("/api/login") };
  log(`вход: ${Date.now() - t} мс, /api/login p50 ${sum("/api/login").p50} p95 ${sum("/api/login").p95} мс, коды ${JSON.stringify(codes["/api/login"])}`);
  resetLat();

  // 2. Все разом открывают приложение, дедлайны ещё не прочитаны (как после перезапуска сервера).
  t = Date.now();
  await Promise.all(ids.map((id) => Promise.all([api(id, "/api/me"), api(id, "/api/deadlines"), api(id, "/api/schedule"), api(id, "/api/labs")])));
  result.phases.coldOpen = { ms: Date.now() - t, deadlines: sum("/api/deadlines"), me: sum("/api/me"), schedule: sum("/api/schedule") };
  log(`все открыли разом (холодно): ${Date.now() - t} мс; /api/deadlines ${JSON.stringify(sum("/api/deadlines"))}`);
  resetLat();

  // 3. То же из памяти сервера.
  t = Date.now();
  await Promise.all(ids.map((id) => Promise.all([api(id, "/api/me"), api(id, "/api/deadlines"), api(id, "/api/schedule"), api(id, "/api/labs")])));
  result.phases.warmOpen = { ms: Date.now() - t, deadlines: sum("/api/deadlines"), me: sum("/api/me"), schedule: sum("/api/schedule") };
  log(`все открыли разом (из памяти): ${Date.now() - t} мс; /api/deadlines ${JSON.stringify(sum("/api/deadlines"))}`);
  resetLat();

  // 3а. --restart: копия сервера убивается (как на живом ПК: обработчики exit не срабатывают) и запускается из той же
  // папки; копии дедлайнов на диске остались. Сразу после старта все разом открывают приложение.
  if (RESTART) {
    t = Date.now();
    const old = child;
    const gone = new Promise((r) => (old.exitCode !== null || old.signalCode !== null ? r() : old.once("exit", r)));
    old.kill();
    await gone;
    restoredLine = null;
    await startServer();
    const upMs = Date.now() - t;
    log(`перезапуск копии сервера: ${upMs} мс; ${restoredLine || "строки о восстановлении копий нет"}`);
    sampleProc();
    t = Date.now();
    const answers = await Promise.all(ids.map((id) => Promise.all([api(id, "/api/me"), api(id, "/api/deadlines"), api(id, "/api/schedule"), api(id, "/api/labs")]).then((x) => x[1])));
    const stale = answers.filter((a) => a.j?.stale === true);
    const bySource = {};
    for (const a of stale) bySource[a.j.source || "нет"] = (bySource[a.j.source || "нет"] || 0) + 1;
    result.phases.restartOpen = { restartMs: upMs, restored: restoredLine, ms: Date.now() - t, deadlines: sum("/api/deadlines"), me: sum("/api/me"), schedule: sum("/api/schedule"),
      stale: stale.length, staleBySource: bySource, down: answers.filter((a) => a.j?.moodle?.down).length, ok: answers.filter((a) => a.s === 200).length };
    log(`после перезапуска все открыли разом: ${Date.now() - t} мс; /api/deadlines ${JSON.stringify(sum("/api/deadlines"))}; stale ${stale.length} из ${answers.length} ${JSON.stringify(bySource)}, с плашкой сбоя ${result.phases.restartOpen.down}`);
    resetLat();
  }

  // 4. Все разом открывают «Сессию» (дважды: первый раз — с чтением баллов Moodle, второй — из памяти).
  for (const k of ["sessionCold", "sessionWarm"]) {
    t = Date.now();
    await Promise.all(ids.map((id) => api(id, "/api/session")));
    result.phases[k] = { ms: Date.now() - t, session: sum("/api/session") };
    log(`«Сессия» у всех разом (${k === "sessionCold" ? "первый раз" : "повторно"}): ${Date.now() - t} мс; ${JSON.stringify(sum("/api/session"))}`);
    resetLat();
  }
  sampleProc();
  result.memAfterOpen = proc.at(-1);

  // 5. Фон. Лёгкие заходы людей: каждый открывает приложение в среднем раз в 3 минуты.
  const steadyAt = Date.now(), httpAt = stats.http;
  let steady = true;
  const visits = (async () => {
    while (steady) {
      const id = ids[Math.floor(Math.random() * ids.length)];
      void Promise.all([api(id, "/api/me", undefined, "visit:me"), api(id, "/api/deadlines", undefined, "visit:deadlines"), api(id, "/api/labs", undefined, "visit:labs")]);
      await sleep(180e3 / N);
    }
  })();
  // 5а. Первый быстрый опрос тестов и первая проверка материалов у каждого (они только запоминают, что есть).
  const quickedAll = () => ids.every((id) => (stats.quick.get(nOf(id)) || []).some((x) => x >= steadyAt - 600e3));
  const contentsAll = (n) => coursesOf(n).every((c) => stats.contentsFirst.has(`${n}:${c}`));
  let firstQuick = null, firstMaterials = null;
  while (Date.now() - steadyAt < WAIT_MS && (!firstQuick || !firstMaterials)) {
    if (!firstQuick && quickedAll()) { firstQuick = Date.now() - steadyAt; log(`быстрый опрос тестов дошёл до всех: ${Math.round(firstQuick / 1000)} с от начала фона`); }
    if (!firstMaterials && ids.every((id) => contentsAll(nOf(id)))) { firstMaterials = Date.now() - steadyAt; log(`первая проверка материалов дошла до всех курсов всех: ${Math.round(firstMaterials / 1000)} с`); }
    await sleep(2000);
  }
  // Интервал между опросами тестов одного человека (медиана по людям) — обещано «раз в 45 с».
  const gaps = (t1) => { const g = []; for (const a of stats.quick.values()) for (let i = 1; i < a.length; i++) if (a[i] >= t1) g.push(a[i] - a[i - 1]); return g; };
  // 5б. Новый тест в первом курсе группы 1 и новый материал во втором курсе последней группы — через сколько придут сообщения.
  const quizCourse = coursesOf(1)[0], modCourse = coursesOf(N)[1];
  const quizUsers = ids.filter((id) => groupOf(nOf(id)) === 0), modUsers = ids.filter((id) => groupOf(nOf(id)) === groupOf(N));
  const injectAt = Date.now();
  extraQuiz.set(quizCourse, { id: quizCourse * 10 + 7, course: quizCourse, coursemodule: quizCourse * 100 + 7, name: `Внезапный тест ${quizCourse}`, timeopen: nowS() - 60, timeclose: nowS() + 86400, grade: 10, sumgrades: 10, visible: 1, timelimit: 600, attempts: 1, addedAt: nowS() });
  extraMods.set(modCourse, [{ id: modCourse * 100 + 77, name: `Новая лекция ${modCourse}`, at: nowS() }]);
  log(`добавлен тест в курс ${quizCourse} (${quizUsers.length} чел.) и материал в курс ${modCourse} (${modUsers.length} чел.)`);
  const got = (list, re) => list.map((id) => tgSent.find((m) => m.chat === id && m.at >= injectAt && re.test(m.text))).filter(Boolean).map((m) => m.at - injectAt);
  while (Date.now() - injectAt < WAIT_MS) {
    if (got(quizUsers, /Новый тест/).length === quizUsers.length && got(modUsers, /Новый материал/).length === modUsers.length) break;
    await sleep(2000);
  }
  if (!STEADY_MS) { steady = false; await visits; }
  const dq = got(quizUsers, /Новый тест/), dm = got(modUsers, /Новый материал/);
  const steadyMin = (Date.now() - steadyAt) / 60e3;
  result.background = {
    firstQuickPassS: firstQuick == null ? `не дошёл за ${WAIT_MS / 60e3} мин` : Math.round(firstQuick / 1000),
    firstMaterialsPassS: firstMaterials == null ? `не дошла за ${WAIT_MS / 60e3} мин` : Math.round(firstMaterials / 1000),
    quickGapS: { p50: Math.round(q(gaps(steadyAt), 0.5) / 1000) || null, p95: Math.round(q(gaps(steadyAt), 0.95) / 1000) || null },
    newTestS: { delivered: `${dq.length} из ${quizUsers.length}`, p50: dq.length ? Math.round(q(dq, 0.5) / 1000) : null, max: dq.length ? Math.round(Math.max(...dq) / 1000) : null },
    newMaterialS: { delivered: `${dm.length} из ${modUsers.length}`, p50: dm.length ? Math.round(q(dm, 0.5) / 1000) : null, max: dm.length ? Math.round(Math.max(...dm) / 1000) : null },
    moodleHttpPerMin: Math.round((stats.http - httpAt) / steadyMin),
    passes: Object.fromEntries(Object.entries(passLog).map(([k, v]) => [k, { n: v.length, lastS: v.length ? Math.round(v.at(-1).ms / 1000) : null, maxS: v.length ? Math.round(Math.max(...v.map((x) => x.ms)) / 1000) : null }])),
    visits: { deadlines: sum("visit:deadlines"), me: sum("visit:me") },
  };
  log(`фон: ${JSON.stringify(result.background)}`);

  // 6. Установившаяся работа: первые обходы позади, люди заходят как обычно.
  if (STEADY_MS) {
    const w0 = Date.now(), h0 = stats.http, f0 = { ...stats.byFn };
    const quizCalls = () => [...stats.quick.values()].reduce((a, x) => a + x.length, 0), qc0 = quizCalls();
    log(`установившаяся работа: ${STEADY_MS / 60e3} мин`);
    await sleep(STEADY_MS);
    const min = (Date.now() - w0) / 60e3, qcN = quizCalls(), hN = stats.http, fN = { ...stats.byFn };
    const perMin = (fn) => Math.round(((fN[fn] || 0) - (f0[fn] || 0)) / min);
    // Второй новый тест — в курсе другой группы, второй материал — в четвёртом курсе первой группы.
    const course2 = coursesOf(N > GROUP_SIZE ? GROUP_SIZE + 1 : 1)[2], mod2 = coursesOf(1)[3];
    const users2 = ids.filter((id) => coursesOf(nOf(id)).includes(course2)), musers2 = ids.filter((id) => coursesOf(nOf(id)).includes(mod2));
    const at2 = Date.now();
    extraQuiz.set(course2, { id: course2 * 10 + 6, course: course2, coursemodule: course2 * 100 + 6, name: `Ещё тест ${course2}`, timeopen: nowS() - 60, timeclose: nowS() + 86400, grade: 10, sumgrades: 10, visible: 1, timelimit: 600, attempts: 1, addedAt: nowS() });
    extraMods.set(mod2, [{ id: mod2 * 100 + 78, name: `Ещё лекция ${mod2}`, at: nowS() }]);
    log(`установившаяся работа: добавлен тест в курс ${course2} (${users2.length} чел.) и материал в курс ${mod2} (${musers2.length} чел.)`);
    const got2 = (list, re) => list.map((id) => tgSent.find((m) => m.chat === id && m.at >= at2 && re.test(m.text))).filter(Boolean).map((m) => m.at - at2);
    while (Date.now() - at2 < WAIT_MS) {
      if (got2(users2, /Новый тест/).length === users2.length && got2(musers2, /Новый материал/).length === musers2.length) break;
      await sleep(2000);
    }
    const d2q = got2(users2, /Новый тест/), d2m = got2(musers2, /Новый материал/);
    const quizPerMin = (qcN - qc0) / min;
    result.steadyState = {
      minutes: Math.round(min), moodleHttpPerMin: Math.round((hN - h0) / min),
      quizRequestsPerMin: Math.round(quizPerMin), quizRequestsPerUserPerHour: Math.round((quizPerMin * 60 / N) * 10) / 10,
      callsPerMin: { updatesSince: perMin("core_course_get_updates_since"), contents: perMin("core_course_get_contents"), assignments: perMin("mod_assign_get_assignments"), statuses: perMin("mod_assign_get_submission_status") },
      newTestS: { delivered: `${d2q.length} из ${users2.length}`, p50: d2q.length ? Math.round(q(d2q, 0.5) / 1000) : null, max: d2q.length ? Math.round(Math.max(...d2q) / 1000) : null },
      newMaterialS: { delivered: `${d2m.length} из ${musers2.length}`, p50: d2m.length ? Math.round(q(d2m, 0.5) / 1000) : null, max: d2m.length ? Math.round(Math.max(...d2m) / 1000) : null },
    };
    log(`установившаяся работа: ${JSON.stringify(result.steadyState)}`);
    steady = false; await visits;
  }
} catch (e) {
  console.error("ОШИБКА ПРОВЕРКИ:", e);
  result.error = String(e?.stack || e);
} finally {
  clearInterval(procTimer); clearInterval(healthTimer);
  sampleProc();
  // Процессорное время — по соседним замерам одного процесса (после --restart у нового процесса счёт с нуля).
  let cpuMs = 0;
  for (let i = 1; i < proc.length; i++) if (proc[i].pid === proc[i - 1].pid) cpuMs += proc[i].cpu - proc[i - 1].cpu;
  const cpu = proc.length > 1 ? cpuMs / (proc.at(-1).at - proc[0].at) * 100 : null;
  result.process = { maxWorkingSetMB: Math.round(Math.max(...proc.map((x) => x.ws)) / 1048576), lastPrivateMB: Math.round((proc.at(-1)?.priv || 0) / 1048576), avgCpuPercentOfOneCore: cpu == null ? null : Math.round(cpu) };
  result.health = { p50: q(health, 0.5), p95: q(health, 0.95), max: health.length ? Math.max(...health) : null };
  result.moodle = { http: stats.http, innerCalls: stats.inner, peakConcurrent: stats.peak, byFn: Object.fromEntries(Object.entries(stats.byFn).sort((a, b) => b[1] - a[1]).slice(0, 14)) };
  result.telegramSent = tgSent.length;
  try { const pl = JSON.parse(readFileSync(join(SIM, "usage", "moodle-load.json"), "utf8")); const d = Object.values(pl.days).at(-1); result.paceByName = d?.byName; result.paceQueue = { total: d?.total, fail: d?.fail }; } catch { /* нет файла */ }
  const errors = readFileSync(serverLog, "utf8").split(/\r?\n/).filter((l) => /QueueError|ждут в очереди|Moodle не отвечает|ошибка|Error/i.test(l));
  result.serverErrorLines = errors.length;
  result.serverErrorSample = [...new Set(errors.map((l) => l.replace(/^\S+ \d+ /, "").replace(/\d{4,}/g, "N").slice(0, 160)))].slice(0, 8);
  const resultFile = join(ROOT, `result-${N}${PACE ? "" : "-nopace"}${RESTART ? "-restart" : ""}${TAG ? `-${TAG}` : ""}.json`);
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ process: result.process, health: result.health, moodle: result.moodle, telegramSent: result.telegramSent, paceByName: result.paceByName, paceQueue: result.paceQueue, serverErrorLines: result.serverErrorLines, serverErrorSample: result.serverErrorSample }, null, 1));
  log(`итог: ${resultFile}`);
  stop();
  setTimeout(() => process.exit(0), 500);
}
