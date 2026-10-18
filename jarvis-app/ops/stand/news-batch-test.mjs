// Проверка новых материалов пакетами и «тихих» курсов для опроса тестов (news.mjs, 15 окт 2026). Копия модулей во
// временной папке, поддельный Moodle и Bot API на 127.0.0.1 — настоящие Moodle, Telegram и данные не затрагиваются.
// Запуск: node ops\stand\news-batch-test.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", ".."), PORT = 9966, FAKE = `http://127.0.0.1:${PORT}`;
const root = join(tmpdir(), `news-batch-test-${process.pid}`), SIM = join(root, "app");
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").split("https://newlms.misis.ru").join(FAKE).split("https://api.telegram.org").join(`${FAKE}/tg`));
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
Object.assign(process.env, { MOODLE_PACE: "0", MOODLE_PACE_DIR: join(root, "usage"), BOT_STATS_DIR: join(root, "usage"), BOT_UPDATES: "1", MATERIALS_EVERY_MS: "1", SIGNAL_OVERLAP_S: "0", USERPROFILE: join(root, "home"), HOME: join(root, "home"),
  // Расписания и учебные планы misis.ru — тоже на поддельный адрес: импорт модулей не должен ходить на настоящий сайт.
  MISIS_SCHEDULE_INDEX: FAKE + "/schedule/", MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/" });

// Поддельный Moodle: http — запросы по сети, calls — все вызовы функций (в том числе внутри пакета).
const mods = new Map([[11, []], [12, []], [13, []]]); // курс → [{ id, name, at }]
const http = [], calls = [], sent = [];
const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") flat(v, key, out); else out[key] = v; } return out; };
function ws(fn, p) {
  calls.push(fn);
  if (fn === "tool_mobile_call_external_functions") {
    const responses = [];
    for (let i = 0; p[`requests[${i}][function]`]; i++) responses.push({ error: false, data: JSON.stringify(ws(p[`requests[${i}][function]`], flat(JSON.parse(p[`requests[${i}][arguments]`] || "{}")))) });
    return { responses };
  }
  if (fn === "core_course_get_updates_since") return { instances: (mods.get(Number(p.courseid)) || []).filter((m) => m.at >= Number(p.since)).map((m) => ({ contextlevel: "module", id: m.id, updates: [{ name: "configuration" }] })) };
  if (fn === "core_course_get_contents") return [{ name: "Раздел", modules: [{ id: Number(p.courseid) * 100, name: "Методичка", modname: "resource", visible: 1, uservisible: true, url: `${FAKE}/r` }, ...(mods.get(Number(p.courseid)) || []).map((m) => ({ id: m.id, name: m.name, modname: m.modname || "resource", visible: 1, uservisible: true, url: `${FAKE}/m${m.id}` }))] }];
  return { exception: "x", errorcode: "unknownfn", message: fn };
}
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/tg/")) { try { sent.push(JSON.parse(body).text); } catch { /* */ } return res.end(JSON.stringify({ ok: true, result: {} })); }
    const p = Object.fromEntries(new URLSearchParams(body));
    http.push(p.wsfunction);
    res.end(JSON.stringify(ws(p.wsfunction, p)));
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
const news = await import(pathToFileURL(join(SIM, "news.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const courses = [11, 12, 13].map((id) => ({ id, short: `К${id}`, name: `Курс ${id}` }));
const nowS = () => Math.floor(Date.now() / 1000);
const step = async (tgId) => { const h = http.length, c = calls.length, s = sent.length; await new Promise((r) => setTimeout(r, 5)); const n = await news.checkMaterials(tgId, "tok-a", courses); return { n, http: http.slice(h), calls: calls.slice(c), sent: sent.slice(s) }; };

const t0 = nowS();
let r = await step(501);
check("первая проверка трёх курсов — один запрос (списки модулей пакетом), сообщений нет", r.http.length === 1 && r.http[0] === "tool_mobile_call_external_functions" && r.calls.filter((f) => f === "core_course_get_contents").length === 3 && r.n === 0, JSON.stringify(r.http));
check("до проверки «что изменилось» курсы тихими не считаются", !news.quietSince([11, 12, 13], t0));
await new Promise((r2) => setTimeout(r2, 1100));
r = await step(501);
check("повторная проверка без изменений — один запрос «что изменилось» на все курсы, списки модулей не нужны", r.http.length === 1 && r.calls.filter((f) => f === "core_course_get_updates_since").length === 3 && !r.calls.includes("core_course_get_contents") && r.n === 0, JSON.stringify(r.calls));
check("после неё курсы тихие (тесты можно не спрашивать)", news.quietSince([11, 12, 13], t0 - 30), "");
check("тихим не считается время раньше проверки и курс, о котором ничего не известно", !news.quietSince([11, 12, 13], t0 - 3600) && !news.quietSince([11, 99], t0));
mods.get(12).push({ id: 1277, name: "Лекция 5", at: nowS() });
await new Promise((r2) => setTimeout(r2, 1100));
r = await step(501);
check("новый материал в одном курсе — два запроса: «что изменилось» и список модулей только этого курса", r.http.length === 2 && r.calls.filter((f) => f === "core_course_get_contents").length === 1, JSON.stringify(r.calls));
check("сообщение о новом материале ушло", r.n === 1 && r.sent.length === 1 && /Новый материал · К12/.test(r.sent[0]) && /Лекция 5/.test(r.sent[0]), r.sent[0] || "");
// 18 окт 2026: «тихий» — без изменений работ. Новый файл — не тест: опрос тестов по-прежнему можно не делать.
check("новый материал (не тест и не задание) тишину для тестов не стирает, сигнала «перечитать сроки» нет", news.quietSince([11, 12, 13], t0 - 30) && !news.workChangedSince([12], t0 * 1000));
// Курс изменился — сначала его студенты (17 окт 2026): обход материалов берёт первыми тех, кто изменение ещё не видел.
check("изменение в курсе 12: одногруппник в очереди первым, нашедший — нет, по другим курсам — нет", news.needsCheck(502, [11, 12]) && !news.needsCheck(501, [12]) && !news.needsCheck(502, [11, 13]));
// Одногруппник с теми же курсами сразу после: общая проверка «изменений нет» годится и ему (11, 13), курс 12 он смотрит сам.
r = await step(502);
check("одногруппник: первая проверка — тоже одним запросом", r.http.length === 1, JSON.stringify(r.http));
check("после своей проверки одногруппник из первых в очереди выходит", !news.needsCheck(502, [12]));
// Новый тест в курсе 13 — тишина курса кончается (опрос тестов пойдёт сразу), и сроки студентов курса — перечитать.
const tq = Date.now();
mods.get(13).push({ id: 1399, name: "Тест 1", modname: "quiz", at: nowS() });
await new Promise((r2) => setTimeout(r2, 1100));
r = await step(501);
check("новый тест: курс 13 больше не тихий, остальные — тихие", !news.quietSince([13], t0) && news.quietSince([11, 12], t0 - 30));
check("новый тест: сигнал «перечитать сроки» по курсу 13, по другим курсам — нет", news.workChangedSince([11, 13], tq - 1000) && !news.workChangedSince([11, 12], tq - 1000));
// Сигнал по курсу (news.probeSignal): один пакет на все курсы; тишина без изменений, тест — конец тишины и очередь курса.
{
  // Первый сигнал смотрит на 10 минут назад и видит изменения этого теста выше (Лекция 5, Тест 1) — это разогрев.
  const nw = await news.probeSignal("tok-a", [11, 12, 13]);
  check("первый сигнал видит изменения последних 10 минут (Лекция 5 и Тест 1)", nw === 2, `изменений ${nw}`);
  await new Promise((r2) => setTimeout(r2, 1100));
  let h = http.length, c = calls.length;
  const n0 = await news.probeSignal("tok-a", [11, 12, 13]);
  check("сигнал без изменений работ: один запрос на три курса, курсы тихие", n0 === 0 && http.length - h === 1 && calls.slice(c).filter((f) => f === "core_course_get_updates_since").length === 3 && news.quietSince([11, 12], t0 - 30), JSON.stringify(calls.slice(c)));
  const ts = Date.now();
  mods.get(11).push({ id: 1199, name: "Тест 2", modname: "quiz", at: nowS() });
  await new Promise((r2) => setTimeout(r2, 1100));
  h = http.length;
  const n1 = await news.probeSignal("tok-a", [11, 12, 13]);
  check("сигнал: новый тест в курсе 11 — список модулей только его, тишина кончилась, сроки перечитать, студенты курса — в очередь", n1 >= 1 && http.length - h === 2 && !news.quietSince([11], t0) && news.workChangedSince([11], ts - 1000) && news.needsCheck(502, [11]), `изменений ${n1}, запросов ${http.length - h}`);
  // Шум: правка уже известного модуля без замены файла (как сообщение в форуме) — студентам курса читать нечего.
  await news.checkMaterials(503, "tok-a", courses); // 503 видел курс 12 до правки
  await new Promise((r2) => setTimeout(r2, 1100));
  mods.get(12).find((m) => m.id === 1277).at = nowS();
  await new Promise((r2) => setTimeout(r2, 1100));
  const n2 = await news.probeSignal("tok-a", [12]);
  check("сигнал: правка известного модуля без файлов — курс тихий для тестов, студентам курса перечитывать нечего", n2 === 1 && news.quietSince([12], t0 - 30) && !news.needsCheck(503, [12]), `изменений ${n2}`);
  // Баг стенда 18 окт: новый материал первым нашла проверка одного студента — сигнал всё равно должен отправить
  // одногруппников проверить курс (иначе они возьмут общий ответ «изменений нет» и материал потеряют).
  await new Promise((r2) => setTimeout(r2, 1100));
  mods.get(12).push({ id: 1288, name: "Лекция 6", at: nowS() });
  await new Promise((r2) => setTimeout(r2, 1100));
  r = await step(501);
  check("новый материал первым нашёл 501 — ему сообщение", r.n === 1 && /Лекция 6/.test(r.sent[0] || ""), r.sent[0] || "");
  await news.probeSignal("tok-a", [12]);
  check("…и сигнал после этого всё равно отправляет 503 проверить курс", news.needsCheck(503, [12]));
  r = await step(503);
  check("503 получает «Лекция 6»", r.n === 1 && /Лекция 6/.test(r.sent[0] || ""), r.sent[0] || "");
}

fake.closeAllConnections();
await new Promise((r2) => fake.close(r2));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
