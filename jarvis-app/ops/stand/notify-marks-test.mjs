// Проверка «отметка „отправлено“ — только после отправки» (15 окт 2026). Раньше напоминание, «Новый тест», оценка,
// «Тест открыт», экзамен, объявление и материал отмечались до отправки, и не ушедшее из-за сбоя Telegram (сеть, 5xx,
// 429) сообщение терялось навсегда. Теперь: временный сбой — повтор на следующей проверке ровно один раз; «не дойдёт
// никогда» (403, 400) и /stop — отметка ставится, повторов нет; после 6 неудач И 30 минут отметка ставится всё равно.
// Плюс файл состояния, занятый другим процессом: проверка отказывает и ничего не пишет, а разовое сообщение (deliver)
// уходит. С 15 окт 2026 ещё: обрыв (unknown) — один повтор; предохранитель прохода (обрыв, 429, 401 — остальное не
// пробуем); 401 — повтор, а не «не дойдёт никогда»; досылка дат экзаменов — только будущие и только по новейшему файлу;
// session.files() не ждёт рассылку.
// Копия модулей во временной папке, поддельные Bot API и Moodle на 127.0.0.1:9981 — настоящие Telegram, Moodle, misis.ru
// и данные пользователей не затрагиваются. Запуск: node ops\stand\notify-marks-test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", ".."), PORT = 9981, FAKE = `http://127.0.0.1:${PORT}`;
const root = join(tmpdir(), `notify-marks-test-${process.pid}`), SIM = join(root, "app");
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").split("https://api.telegram.org").join(`${FAKE}/tg`).split("https://newlms.misis.ru").join(FAKE)
    .split("https://ej.misis.ru").join(`${FAKE}/ej`).split("https://misis.ru").join(`${FAKE}/misis`));
}
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(root, "home");
Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"), BOT_UPDATES: "1", MOODLE_DIRECT: "0",
  MOODLE_PACE: "0", MOODLE_PACE_DIR: join(root, "usage"), BOT_STATS_DIR: join(root, "usage"), SESSION_WATCH: "0", SESSION_CACHE: join(root, "session"),
  CURRICULUM_CACHE: join(root, "curriculum"), MISIS_SCHEDULE_INDEX: `${FAKE}/misis/schedule/`, MISIS_EDUOP_URL: `${FAKE}/misis/eduop/`, MISIS_SESSION_URL: `${FAKE}/misis/session/`,
  NEWS_EVERY_MS: "1", MATERIALS_EVERY_MS: "1" });
// «Сессия»: уже разобранный файл расписания экзаменов (как после session.check) и владелец стенда в группе из файла —
// для повторной рассылки дат из admission.tick. Токен владельца — фальшивый, во временной «домашней» папке.
const SESS = join(root, "session"), XLSX = "itkn-sessiya.xlsx", GROUP = "БИСТ-24-ПО-2", OWNER = 945210206;
// Второй файл с той же группой — исправленная выкладка (появилась позже): досылка из tick — только по нему (15 окт 2026).
const XLSX2 = "itkn-sessiya-ispr.xlsx";
mkdirSync(SESS, { recursive: true });
writeFileSync(join(SESS, "state.json"), JSON.stringify({ at: Date.now(), files: {
  [XLSX]: { url: `${FAKE}/misis/f.xlsx`, title: "Институт компьютерных наук", seenAt: Date.now() - 2 * 86400e3, parsed: true, groups: 1, skipped: [], error: null, ext: "xlsx" },
  [XLSX2]: { url: `${FAKE}/misis/f2.xlsx`, title: "ИКН, исправлено", seenAt: Date.now() - 86400e3, parsed: true, groups: 1, skipped: [], error: null, ext: "xlsx" } } }));
for (const x of [XLSX, XLSX2]) writeFileSync(join(SESS, `${x}.json`), JSON.stringify({ version: 1, groups: { [GROUP]: [{ date: "2027-01-12", time: "10:00", name: "Цифровая электроника", kind: "exam", place: "Б-302", teacher: "Петров П.П." }] } }));
mkdirSync(join(SIM, "users"), { recursive: true });
writeFileSync(join(SIM, "users", `${OWNER}.json`), JSON.stringify({ tgId: OWNER, group: GROUP, fullName: "Владелец Стенда" }));
mkdirSync(join(HOME, ".openclaw"), { recursive: true });
writeFileSync(join(HOME, ".openclaw", "moodle-token.txt"), "tok-owner");

// Поддельный Bot API: fail(chat, n, code, description) — следующие n отправок этому человеку получат отказ (code
// "reset" — оборвать соединение, запрос уже получен: исход «unknown»); tg — все попытки { chat, text, ok }. Поддельный
// Moodle — форумы «Объявления» и модули курсов (mods, topics). Поддельная страница сессии misis.ru — sessionPage, файл
// с неё отдаётся через PDF_DELAY_MS (проверка session.files()).
const tg = [], fails = new Map();
let sessionPage = "";
const PDF_DELAY_MS = 5000;
const fail = (chat, n, code, description = "Internal Server Error") => fails.set(chat, [...(fails.get(chat) || []), ...Array(n).fill({ code, description })]);
const mods = new Map([[21, []]]), topics = new Map([[31, []]]);
const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") flat(v, key, out); else out[key] = v; } return out; };
function ws(fn, p) {
  if (fn === "tool_mobile_call_external_functions") {
    const responses = [];
    for (let i = 0; p[`requests[${i}][function]`]; i++) responses.push({ error: false, data: JSON.stringify(ws(p[`requests[${i}][function]`], flat(JSON.parse(p[`requests[${i}][arguments]`] || "{}")))) });
    return { responses };
  }
  if (fn === "core_course_get_updates_since") return { instances: (mods.get(Number(p.courseid)) || []).filter((m) => m.at >= Number(p.since)).map((m) => ({ contextlevel: "module", id: m.id, updates: [{ name: "configuration" }] })) };
  if (fn === "core_course_get_contents") return [{ name: "Раздел", modules: (mods.get(Number(p.courseid)) || []).map((m) => ({ id: m.id, name: m.name, modname: "resource", visible: 1, uservisible: true, url: `${FAKE}/m${m.id}` })) }];
  if (fn === "mod_forum_get_forums_by_courses") return [...topics.keys()].map((id) => ({ id, course: 21, type: "news", numdiscussions: topics.get(id).length }));
  if (fn === "mod_forum_get_forum_discussions") return { discussions: [...(topics.get(Number(p.forumid)) || [])].reverse() };
  return { exception: "x", errorcode: "unknownfn", message: fn };
}
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url.startsWith("/tg/")) {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch { /* форма */ }
      const chat = Number(j.chat_id), f = (fails.get(chat) || []).shift();
      tg.push({ chat, text: String(j.text || ""), ok: !f });
      if (f?.code === "reset") return req.socket.destroy();
      res.writeHead(f?.code || 200, { "content-type": "application/json" });
      return res.end(JSON.stringify(f ? { ok: false, error_code: f.code, description: f.description } : { ok: true, result: { message_id: tg.length } }));
    }
    if (req.url.startsWith("/webservice/")) { res.writeHead(200, { "content-type": "application/json" }); const p = Object.fromEntries(new URLSearchParams(body)); return res.end(JSON.stringify(ws(p.wsfunction, p))); }
    if (req.url === "/misis/session/" && sessionPage) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(sessionPage); }
    if (req.url.startsWith("/misis/files/")) return setTimeout(() => { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4 расписание сессии"); }, PDF_DELAY_MS);
    res.writeHead(404); res.end("нет");
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
const notify = await import(pathToFileURL(join(SIM, "notify.mjs")).href);

let fails_ = 0;
const check = (name, cond, extra = "") => { if (!cond) fails_++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;
const tries = (chat, re = /./) => tg.filter((m) => m.chat === chat && re.test(m.text)).length;
const got = (chat, re = /./) => tg.filter((m) => m.chat === chat && m.ok && re.test(m.text)).length;
const courses = [{ id: 1, short: "БД" }];
const work = (o = {}) => ({ id: "moodle:assign:1", title: "ЛР 1", due: Date.now() + 20 * HOUR, status: "open", kind: "assign", courseId: 1, grade: null, ...o });
const stateOf = (id) => notify.peekState(id);
const nfile = (id) => join(SIM, "notify", `${id}.json`);
// Держать файл открытым без общего доступа ms миллисекунд (как антивирус) — как в state-file-test.mjs.
function lock(path, ms) {
  const ps = spawn("powershell", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${path}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds ${ms}; $f.Close(); 'free'`], { windowsHide: true });
  let out = "";
  const done = new Promise((r) => ps.on("close", r));
  return new Promise((resolve) => ps.stdout.on("data", (d) => { out += d; if (out.includes("locked")) resolve({ done }); }));
}

// 1. «⏰» не ушло (500) — приходит на следующей проверке ровно один раз.
const A = 7001;
fail(A, 1, 500);
let n1 = await notify.check(A, [work()], courses), n2 = await notify.check(A, [work()], courses), n3 = await notify.check(A, [work()], courses);
check("⏰ при 500 не отмечено: следующая проверка присылает его, третья — уже нет (дошло ровно одно)", n1 === 0 && n2 === 1 && n3 === 0 && tries(A, /^⏰/) === 2 && got(A, /^⏰/) === 1, `${n1}/${n2}/${n3}, попыток ${tries(A)}`);
check("после доставки счётчика попыток не осталось", !(await stateOf(A)).retry);

// 2. 403 (бот заблокирован) и 400 (слишком длинное): отметка ставится, повторов нет.
const B = 7002, C = 7003;
fail(B, 1, 403, "Forbidden: bot was blocked by the user");
fail(C, 1, 400, "Bad Request: message is too long");
for (let i = 0; i < 2; i++) { await notify.check(B, [work()], courses); await notify.check(C, [work()], courses); }
check("403 → отмечено, второй попытки нет", tries(B) === 1 && !!(await stateOf(B)).sent["moodle:assign:1:day"], `попыток ${tries(B)}`);
check("400 «слишком длинное» → отмечено, второй попытки нет", tries(C) === 1 && !!(await stateOf(C)).sent["moodle:assign:1:day"], `попыток ${tries(C)}`);

// 3. /stop: ничего не уходит, отметка ставится — после включения пачка старых напоминаний не придёт.
const D = 7004;
await notify.setMuted(D, true);
await notify.check(D, [work()], courses);
await notify.setMuted(D, false);
await notify.check(D, [work()], courses);
check("выключены сообщения (/stop) → в Telegram ничего, напоминание отмечено", tries(D) === 0 && !!(await stateOf(D)).sent["moodle:assign:1:day"], `попыток ${tries(D)}`);

// 4. «Новый тест» не ушёл — быстрый опрос пришлёт его снова; суточное «⏰» его не дублирует.
const E = 7005, t1 = work({ id: "moodle:quiz:1", kind: "test", title: "Тест 1", due: Date.now() + 5 * 24 * HOUR }), t2 = work({ id: "moodle:quiz:2", kind: "test", title: "Тест 2", due: Date.now() + 10 * HOUR });
await notify.checkNew(E, [t1], courses); // первый опрос только запоминает
fail(E, 1, 500);
n1 = await notify.checkNew(E, [t1, t2], courses);
const seen1 = (await stateOf(E)).seen || [];
n2 = await notify.checkNew(E, [t1, t2], courses);
n3 = await notify.checkNew(E, [t1, t2], courses);
check("«Новый тест» при 500: в виденные не попал, следующий опрос прислал, третий — нет", n1 === 0 && !seen1.includes(t2.id) && seen1.includes(t1.id) && n2 === 1 && n3 === 0 && got(E, /^🆕 Новый тест: Тест 2/) === 1, `${n1}/${n2}/${n3}`);
check("вместе с «Новый тест» (срок меньше суток) отмечено и суточное напоминание", !!(await stateOf(E)).sent[`${t2.id}:day`]);
const E2 = 7015;
await notify.check(E2, [t1], courses);
fail(E2, 1, 500);
await notify.check(E2, [t1, t2], courses);
await notify.check(E2, [t1, t2], courses);
check("полная проверка: пока «Новый тест» не ушёл, «⏰ Завтра» по нему не шлётся; потом приходит одно «Новый тест»", tries(E2, /^⏰/) === 0 && got(E2, /^🆕 Новый тест: Тест 2/) === 1 && tries(E2) === 2, tg.filter((m) => m.chat === E2).map((m) => m.text.split("\n")[0]).join(" | "));

// 5. Оценка: сообщение не ушло — новое значение не запомнено, следующая проверка повторит. Устаревшие данные — без оценок.
const F = 7006, g = (grade) => work({ id: "moodle:assign:6", title: "ЛР 6", due: Date.now() + 10 * 24 * HOUR, grade, gradeMax: 10 });
await notify.check(F, [g(null)], courses);
await notify.check(F, [g(5)], courses); // первая синхронизация: только запоминает
fail(F, 1, 502, "Bad Gateway");
n1 = await notify.check(F, [g(7)], courses);
const gradeAfterFail = (await stateOf(F)).grades["moodle:assign:6"];
n2 = await notify.check(F, [g(7)], courses);
n3 = await notify.check(F, [g(7)], courses);
check("оценка при 502: прежнее значение осталось, следующая проверка прислала «📝 Оценка», дальше тихо", n1 === 0 && gradeAfterFail === 5 && n2 === 1 && n3 === 0 && got(F, /^📝 Оценка: ЛР 6/) === 1, `${n1}/${n2}/${n3}, было ${gradeAfterFail}`);
n1 = await notify.check(F, [g(9)], courses, Date.now() - HOUR);
check("данные старше обработанных (копия с диска): об оценке не пишем и значение не трогаем", n1 === 0 && (await stateOf(F)).grades["moodle:assign:6"] === 7);
n2 = await notify.check(F, [g(9)], courses);
check("свежие данные — сообщение об оценке 9", n2 === 1 && got(F, /· 9 из 10/) === 1);

// 6. «Тест открыт» не ушёл — запись ожидания остаётся, повтор по waitingOf, сообщение одно.
const G = 7007, q = work({ id: "moodle:quiz:7", kind: "test", title: "Тест 7", opensAt: Date.now() + 300, due: Date.now() + 5 * HOUR });
const avail = async (ids) => new Map(ids.map((id) => [id, { ok: true }]));
await notify.checkOpen(G, [q], courses, avail);
await sleep(400);
fail(G, 1, 500);
const r1 = await notify.checkOpen(G, [q], courses, avail);
const waitAfterFail = (await notify.quizWaiting(G)).map((w) => w.id);
const r2 = await notify.checkOpen(G, [q], courses, avail);
const r3 = await notify.checkOpen(G, [q], courses, avail);
check("«Тест открыт» при 500: запись ожидания осталась и стоит повтор; следующая проверка прислала одно сообщение",
  r1.sent === 0 && r1.waiting.some((w) => w.id === q.id && w.at > Date.now()) && waitAfterFail.includes(q.id) && r2.sent === 1 && r3.sent === 0 && got(G, /^🟢 Тест открыт: Тест 7/) === 1 && !(await notify.quizWaiting(G)).length,
  `${r1.sent}/${r2.sent}/${r3.sent}, ждём: ${waitAfterFail.join()}`);

// 7. Предел попыток (15 окт 2026): 6 неудач И 30 минут с первой — отметка ставится всё равно. Шесть неудач за минуту —
// ещё не предел: на быстрых путях («Тест открыт» раз в 2 мин, материалы раз в ~50 с) они набирались за минуты.
const N = 7008, RK = "remind:moodle:assign:1:day";
fail(N, 7, 500);
for (let i = 0; i < 6; i++) await notify.check(N, [work()], courses);
const sN6 = await stateOf(N);
check("6 неудач за минуту → отметки нет, счётчик 6 (30 минут с первой неудачи ещё не прошли)", tries(N) === 6 && !sN6.sent["moodle:assign:1:day"] && sN6.retry?.[RK]?.n === 6, `попыток ${tries(N)}, ${JSON.stringify(sN6.retry?.[RK])}`);
await notify.withState(N, (s) => { s.retry[RK].first -= 31 * 60e3; }); // первая неудача — 31 минуту назад
await notify.check(N, [work()], courses);
await notify.check(N, [work()], courses);
const sN = await stateOf(N);
check("7-я неудача через 31 мин после первой → отметка поставлена принудительно, повторов больше нет, счётчик убран", tries(N) === 7 && got(N) === 0 && !!sN.sent["moodle:assign:1:day"] && !sN.retry, `попыток ${tries(N)}`);
// Остаток счётчика от прошлого эпизода (сутки назад, 5 неудач) не исчерпывает попытки нового сообщения с тем же ключом.
const N2 = 7018;
await notify.withState(N2, (s) => { s.retry = { [RK]: { n: 5, first: Date.now() - 25 * HOUR } }; });
fail(N2, 1, 500);
n1 = await notify.check(N2, [work()], courses);
n2 = await notify.check(N2, [work()], courses);
check("остаток счётчика суточной давности: новая неудача не ставит отметку сразу — следующая проверка присылает «⏰»", n1 === 0 && n2 === 1 && got(N2, /^⏰/) === 1 && tries(N2) === 2, `${n1}/${n2}`);

// 7б. Обрыв соединения после отправки (unknown: Telegram мог принять) — повтор один раз, после второго — отметка.
const U = 7019;
fail(U, 2, "reset");
n1 = await notify.check(U, [work()], courses);
n2 = await notify.check(U, [work()], courses);
n3 = await notify.check(U, [work()], courses);
const sU = await stateOf(U);
check("обрыв (unknown) дважды → один повтор, затем отметка; третьей попытки нет (не больше одного дубля)", n1 === 0 && n2 === 0 && n3 === 0 && tries(U) === 2 && !!sU.sent["moodle:assign:1:day"] && !sU.retry, `попыток ${tries(U)}`);

// 7в. Предохранитель прохода: обрыв (или 429) на первом сообщении — остальные в этом проходе не пробуются и попыткой не
// считаются; 500 (Telegram ответил) — не повод останавливать проход.
const three = [1, 2, 3].map((i) => work({ id: `moodle:assign:3${i}`, title: `ЛР 3${i}` }));
const V = 7020, V2 = 7021, V3 = 7022;
fail(V, 1, "reset"); fail(V2, 1, 429, "Too Many Requests"); fail(V3, 1, 500);
const pass1 = [await notify.check(V, three, courses), await notify.check(V2, three, courses), await notify.check(V3, three, courses)];
const tries1 = [tries(V), tries(V2), tries(V3)];
const retryKeys = Object.keys((await stateOf(V)).retry || {});
const pass2 = [await notify.check(V, three, courses), await notify.check(V2, three, courses), await notify.check(V3, three, courses)];
check("обрыв или 429 на первом из трёх «⏰»: два других в этом проходе не пробовались и без счётчика; следующий проход прислал все три",
  pass1[0] === 0 && pass1[1] === 0 && tries1[0] === 1 && tries1[1] === 1 && retryKeys.join() === "remind:moodle:assign:31:day" && pass2[0] === 3 && pass2[1] === 3 && got(V, /^⏰/) === 3 && got(V2, /^⏰/) === 3,
  `проход 1: ${pass1.join("/")} (попыток ${tries1.join("/")}), счётчики: ${retryKeys.join()}; проход 2: ${pass2.join("/")}`);
check("500 на первом из трёх: остальные два ушли в том же проходе, первое — в следующем", pass1[2] === 2 && tries1[2] === 3 && pass2[2] === 1 && got(V3, /^⏰/) === 3);

// 7г. Токен бота отклонён (401): это не «не дойдёт никогда» — отметки нет, после починки сообщение уходит.
const Y = 7023;
fail(Y, 1, 401, "Unauthorized");
n1 = await notify.check(Y, [work()], courses);
const sY = await stateOf(Y);
n2 = await notify.check(Y, [work()], courses);
check("401 Unauthorized → отметки нет, следующая проверка присылает «⏰»", n1 === 0 && !sY.sent["moodle:assign:1:day"] && n2 === 1 && got(Y, /^⏰/) === 1, `${n1}/${n2}`);

// 8. Файл состояния занят другим процессом: проверка отказывает и не пишет. Разовое сообщение (deliver/send: отчёт
// лабы, тревога владельцу) при непрочитанном /stop с 15 окт 2026 уходит всё равно — потерять его хуже.
const H = 7010;
await notify.check(H, [work()], courses);
const bytes = readFileSync(nfile(H));
const before = tries(H);
const l = await lock(nfile(H), 7000);
const e1 = await notify.check(H, [work({ id: "moodle:assign:8", title: "ЛР 8" })], courses).then(() => null, (e) => e);
const d1 = await notify.deliver(H, "проверка во время блокировки");
const s1 = await notify.send(H, "и ещё одна");
await l.done;
check("занятый notify/<id>.json: check отказывает (StateReadError), файл побайтно тот же", e1?.name === "StateReadError" && Buffer.compare(bytes, readFileSync(nfile(H))) === 0, `${e1?.name} ${e1?.cause?.code || ""}`);
check("не прочитано, выключены ли сообщения → deliver и send всё равно отправляют (sent, true), оба дошли", d1.status === "sent" && s1 === true && tries(H) === before + 2 && got(H, /^проверка во время блокировки$|^и ещё одна$/) === 2, `${d1.status}, попыток ${tries(H) - before}`);
n1 = await notify.check(H, [work({ id: "moodle:assign:8", title: "ЛР 8" })], courses);
check("после освобождения файла: проверка прошла, прежние отметки на месте", n1 === 1 && got(H, /ЛР 8/) === 1 && !!(await stateOf(H)).sent["moodle:assign:1:day"]);

// 9. «Сессия»: напоминание об экзамене — отметка до отправки, снимается при сбое; одновременные вызовы — одно сообщение.
const admission = await import(pathToFileURL(join(SIM, "admission.mjs")).href);
const eve = Date.UTC(2027, 0, 11, 16, 0); // 19:00 по Москве накануне экзамена
const o = { today: "2027-01-11", subjects: [{ name: "Цифровая электроника", index: "Б1.О.10", examDates: [{ date: "2027-01-12", time: "10:00", kind: "exam", place: "Б-302", teacher: "Петров П.П." }] }], hidden: [], optional: [] };
const I = 7011;
fail(I, 1, 500);
n1 = await admission.examReminders({ tgId: I }, o, eve);
const markAfterFail = Object.keys((await stateOf(I)).sessionSent || {});
n2 = await admission.examReminders({ tgId: I }, o, eve);
n3 = await admission.examReminders({ tgId: I }, o, eve);
check("экзамен: при 500 отметка снята, следующий обход прислал «⏰ Завтра экзамен», третий — нет", n1 === 0 && !markAfterFail.length && n2 === 1 && n3 === 0 && got(I, /^⏰ Завтра экзамен: Цифровая электроника/) === 1, `${n1}/${n2}/${n3}, отметки: ${markAfterFail.join()}`);
const J = 7012;
const par = await Promise.all([1, 2, 3].map(() => admission.examReminders({ tgId: J }, o, eve)));
check("три одновременных обхода — одно напоминание об экзамене", par.reduce((a, b) => a + b, 0) === 1 && tries(J) === 1, par.join());
const file = { name: "itkn-sessiya.xlsx", title: "Институт компьютерных наук", url: `${FAKE}/misis/f.xlsx`, parsed: true, groups: ["БИСТ-24-ПО-2"] }, prof = { group: "БИСТ-24-ПО-2" };
const K = 7013;
const pa = await Promise.all([admission.announceOne({ tgId: K }, prof, file, async () => o), admission.announceOne({ tgId: K }, prof, file, async () => o)]);
check("рассылка при публикации и повтор из tick одновременно — одно «📅 Расписание экзаменов опубликовано»", pa[0] + pa[1] === 1 && got(K, /^📅 Расписание экзаменов опубликовано/) === 1 && tries(K) === 1, pa.join());
const L = 7014;
fail(L, 1, 500);
n1 = await admission.announceOne({ tgId: L }, prof, file, async () => o);
const lMark = (await stateOf(L)).sessionSent?.[`exams:${file.name}`];
const e2 = await admission.announceOne({ tgId: L }, prof, file, async () => { throw new Error("журнал не ответил"); }).then(() => null, (e) => e);
n2 = await admission.announceOne({ tgId: L }, prof, file, async () => o);
n3 = await admission.announceOne({ tgId: L }, prof, file, async () => o);
check("даты экзаменов: при 500 и при исключении в сборке отметка снимается; потом приходит одно сообщение с датой, второго нет",
  n1 === 0 && !lMark && e2?.message === "журнал не ответил" && n2 === 1 && n3 === 0 && got(L, /^📅 Расписание экзаменов опубликовано/) === 1 && got(L, /12 янв, 10:00, Б-302/) === 1, `${n1}/${n2}/${n3}`);
// Повтор из tick: файл уже разобран (рассылка при публикации владельцу не дошла) — обход досылает даты, один раз.
// Группа есть в двух файлах (первая выкладка и исправленная): досылается только новейший, старый отмечается без
// сообщения (15 окт 2026; раньше в одном обходе приходили два почти одинаковых «📅»).
fail(OWNER, 1, 500);
n1 = await admission.tick();
n2 = await admission.tick();
n3 = await admission.tick();
const ownerMarks = (await stateOf(OWNER)).sessionSent || {};
check("tick: даты из разобранного файла тому, кому рассылка не дошла: при 500 — повтор следующим обходом, дальше не повторяется",
  n1 === 0 && n2 === 1 && n3 === 0 && tries(OWNER, /^📅 Расписание экзаменов опубликовано/) === 2 && got(OWNER, /^📅 Расписание экзаменов опубликовано[^]*Цифровая электроника — 12 янв/) === 1, `${n1}/${n2}/${n3}`);
check("tick: из двух файлов группы — одно «📅» по новейшему («исправлено»), старый файл отмечен superseded без сообщения",
  got(OWNER, /^📅 Расписание экзаменов опубликовано \(«ИКН, исправлено»\)/) === 1 && tries(OWNER, /^📅 Расписание экзаменов опубликовано \(«Институт компьютерных наук»\)/) === 0
  && ownerMarks[`exams:${XLSX}`] === "superseded" && typeof ownerMarks[`exams:${XLSX2}`] === "number", JSON.stringify(ownerMarks));
const fl = [{ name: "a.xlsx", seenAt: 1, groups: [GROUP], until: "2027-01-20" }, { name: "b.xlsx", seenAt: 2, groups: ["бист-24-по-2"], until: "2027-01-20" },
  { name: "c.xlsx", seenAt: 3, groups: ["БПМ-24-1"], until: "2027-01-20" }, { name: "d.xlsx", seenAt: 4, groups: [GROUP], until: "2026-01-01" }];
const la = (marks) => { const r = admission.lateAnnounce(fl, GROUP, "2026-10-15", marks); return `${r.file?.name ?? "-"}|${r.superseded.join(",")}`; };
check("lateAnnounce: досылается только новейший файл группы, старые без отметки — superseded; чужая группа и прошедший файл не в счёт",
  la({}) === "b.xlsx|a.xlsx" && la({ "exams:b.xlsx": 1 }) === "-|a.xlsx" && la({ "exams:a.xlsx": 1 }) === "b.xlsx|" && la({ "exams:a.xlsx": 1, "exams:b.xlsx": 1 }) === "-|",
  [la({}), la({ "exams:b.xlsx": 1 }), la({ "exams:a.xlsx": 1 })].join("  "));

// Досылка (late) — только экзамены с сегодняшнего дня; не осталось ни одного — отметка без сообщения (15 окт 2026).
const lateView = (today, subjects) => async () => ({ today, subjects, hidden: [], optional: [] });
const bd = { name: "Базы данных", index: "Б1.О.11", examDates: [{ date: "2027-01-10", time: "09:00", kind: "exam", place: "А-101" }] };
const M = 7026, M2 = 7027, M3 = 7028;
n1 = await admission.announceOne({ tgId: M }, prof, file, lateView("2027-01-13", o.subjects), { late: true });
check("досылка, когда все экзамены группы прошли: сообщения нет, отметка поставлена (больше не досылаем)", n1 === 0 && tries(M) === 0 && !!(await stateOf(M)).sessionSent?.[`exams:${file.name}`]);
n1 = await admission.announceOne({ tgId: M2 }, prof, file, lateView("2027-01-11", [...o.subjects, bd]), { late: true });
const txtM2 = tg.filter((m) => m.chat === M2).at(-1)?.text || "";
check("досылка: прошедший экзамен («Базы данных», 10 янв) не показан, будущий есть, «Напомню накануне» есть", n1 === 1 && /Цифровая электроника — 12 янв/.test(txtM2) && !/Базы данных/.test(txtM2) && /Напомню накануне/.test(txtM2), txtM2.replace(/\n/g, " ⏎ "));
n1 = await admission.announceOne({ tgId: M3 }, prof, file, lateView("2027-01-12", o.subjects), { late: true });
const txtM3 = tg.filter((m) => m.chat === M3).at(-1)?.text || "";
check("досылка в день последнего экзамена: экзамен показан, «Напомню накануне» — нет (накануне уже прошло)", n1 === 1 && /12 янв/.test(txtM3) && !/Напомню/.test(txtM3), txtM3.replace(/\n/g, " ⏎ "));

// Напоминание об экзамене: обрыв (unknown) дважды — один повтор, после второго отметка остаётся (раньше — до конца окна).
const I2 = 7024;
fail(I2, 2, "reset");
n1 = await admission.examReminders({ tgId: I2 }, o, eve);
n2 = await admission.examReminders({ tgId: I2 }, o, eve);
n3 = await admission.examReminders({ tgId: I2 }, o, eve);
check("экзамен: обрыв дважды → один повтор, затем отметка остаётся, третьей попытки нет", n1 === 0 && n2 === 0 && n3 === 0 && tries(I2) === 2 && Object.keys((await stateOf(I2)).sessionSent || {}).length === 1, `попыток ${tries(I2)}`);
// Предохранитель обхода «Сессии»: два экзамена завтра, обрыв на первом — второй в этом обходе не пробуется.
const o2 = { ...o, subjects: [...o.subjects, { ...bd, examDates: [{ date: "2027-01-12", time: "14:00", kind: "exam", place: "А-101" }] }] };
const I3 = 7025, passI3 = { down: false };
fail(I3, 1, "reset");
n1 = await admission.examReminders({ tgId: I3 }, o2, eve, passI3);
const sI3 = await stateOf(I3);
n2 = await admission.examReminders({ tgId: I3 }, o2, eve);
check("два экзамена завтра, обрыв на первом: второй не пробовался (ни отметки, ни счётчика); следующий обход прислал оба",
  n1 === 0 && passI3.down && tries(I3) === 3 && !Object.keys(sI3.sessionSent || {}).length && Object.keys(sI3.retry || {}).length === 1 && n2 === 2 && got(I3, /^⏰ Завтра экзамен/) === 2,
  `${n1}/${n2}, попыток ${tries(I3)}, счётчики: ${Object.keys(sI3.retry || {}).join()}`);

// session.files() (15 окт 2026): идущее чтение страницы ждёт не дольше 3 с, рассылку подписчикам — никогда; tick на
// рассылке не стоит. Страница отдаёт новый PDF через 5 с, подписчик держит рассылку, пока его не отпустят.
const session = await import(pathToFileURL(join(SIM, "session.mjs")).href);
let release, inBroadcast;
const held = new Promise((r) => (release = r)), broadcasting = new Promise((r) => (inBroadcast = r));
session.onNew(async () => { inBroadcast(); await held; });
sessionPage = `<html><body><a href="/misis/files/raspisanie-sessii.pdf">Расписание экзаменационной сессии</a></body></html>`;
const ck = session.check();
await sleep(200);
let t = Date.now();
const f1 = await session.files();
const waited1 = Date.now() - t;
await broadcasting;
t = Date.now();
const f2 = await session.files();
const waited2 = Date.now() - t;
t = Date.now();
await admission.tick();
const waited3 = Date.now() - t;
release();
const freshFiles = await ck;
check("session.files(): чтение страницы ждёт ~3 с (не дольше), рассылку не ждёт; новый файл виден сразу после разбора; tick не стоит",
  waited1 >= 2500 && waited1 < 4500 && !f1.some((f) => f.name === "raspisanie-sessii.pdf") && waited2 < 1000 && f2.some((f) => f.name === "raspisanie-sessii.pdf") && waited3 < 3000 && freshFiles.length === 1,
  `ждали ${waited1} / ${waited2} мс, tick ${waited3} мс, новых ${freshFiles.length}`);

// 10. Объявления и материалы: не ушло — виденное снимается, следующая проверка пришлёт снова.
const news = await import(pathToFileURL(join(SIM, "news.mjs")).href);
const P = 7016, mc = [{ id: 21, short: "К21", name: "Курс 21" }];
const mat = async (id) => { await sleep(5); return news.checkMaterials(id, "tok-p", mc); }, nws = async (id) => { await sleep(5); return news.checkNews(id, "tok-q", mc); };
await mat(P); // первая проверка — только запоминает
mods.get(21).push({ id: 2101, name: "Методичка к ЛР 3", at: Math.floor(Date.now() / 1000) });
fail(P, 1, 500);
n1 = await mat(P);
n2 = await mat(P);
n3 = await mat(P);
check("новый материал при 500: прежний снимок курса вернулся, следующая проверка прислала, третья — нет", n1 === 0 && n2 === 1 && n3 === 0 && got(P, /^📎 Новый материал · К21/) === 1 && tries(P) === 2, `${n1}/${n2}/${n3}`);
const Q = 7017;
topics.get(31).push({ discussion: 3101, name: "Старая тема", message: "давно", created: Math.floor(Date.now() / 1000) - 3600, userfullname: "Иванов Иван Иванович" });
await nws(Q); // первая проверка — только запоминает
topics.get(31).push({ discussion: 3102, name: "Занятие переносится", message: "Пара 20.10 переносится на 22.10", created: Math.floor(Date.now() / 1000), userfullname: "Иванов Иван Иванович" });
fail(Q, 1, 500);
n1 = await nws(Q);
const seenQ = (await stateOf(Q)).news?.forums?.["31"]?.seen || [];
n2 = await nws(Q);
n3 = await nws(Q);
check("объявление при 500: тема снята из виденных, следующая проверка прислала, третья — нет", n1 === 0 && !seenQ.includes(3102) && seenQ.includes(3101) && n2 === 1 && n3 === 0 && got(Q, /^📣 Объявление · К21\nЗанятие переносится/) === 1, `${n1}/${n2}/${n3}, виденные: ${seenQ.join()}`);
const mt = statSync(nfile(Q)).mtimeMs;
await sleep(30);
await notify.peekState(Q);
await notify.withState(Q, (s) => s.news?.at);
check("peekState и withState без изменений файл не переписывают", statSync(nfile(Q)).mtimeMs === mt);

fake.closeAllConnections();
await new Promise((r) => fake.close(r));
rmSync(root, { recursive: true, force: true });
console.log(fails_ ? `ИТОГ: провалено ${fails_}` : "ИТОГ: всё прошло");
process.exit(fails_ ? 1 : 0);
