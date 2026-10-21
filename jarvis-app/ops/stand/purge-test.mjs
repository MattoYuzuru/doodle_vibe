// Очистка данных при «Выйти» и отзыве согласия (purge-user.mjs; 21 окт 2026). Настоящий server.mjs на копии кода во
// временной папке: поддельный Moodle и Telegram на 127.0.0.1, запросы приложения подписаны тестовым токеном бота,
// кнопки бота приходят через поддельный getUpdates. Настоящие данные, ключи и домашняя папка не затрагиваются.
// Два человека (5001 и 5002): у обоих есть файлы во всех хранилищах; чистится только первый, второй остаётся нетронутым.
// Запуск: node ops/stand/purge-test.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `purge-test-${process.pid}`), SIM = join(root, "app");
const FPORT = 9972, PORT = 18900 + Math.floor(Math.random() * 90);
const FAKE = `http://127.0.0.1:${FPORT}`, B = `http://127.0.0.1:${PORT}`;
const BOT = "123456:PURGE-TEST";
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => /\.(mjs|py|md)$/.test(x))) {
  writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").split("https://newlms.misis.ru").join(FAKE).split("https://api.telegram.org").join(`${FAKE}/tg`)
    .split("https://ej.misis.ru").join(`${FAKE}/ej`).split("https://misis.ru").join(`${FAKE}/misis`));
}
writeFileSync(join(SIM, "bot-token.txt"), BOT);
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(root, "home");
mkdirSync(HOME, { recursive: true });
Object.assign(process.env, { HOME, USERPROFILE: HOME, APPDATA: HOME, LOCALAPPDATA: HOME, MOODLE_PACE: "0", MOODLE_PACE_DIR: join(root, "usage"), BOT_STATS_DIR: join(root, "usage") });

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tg = [], queue = [];
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    const url = new URL(req.url, FAKE);
    if (url.pathname.startsWith("/tg/")) {
      const method = url.pathname.split("/").pop(); let b = {}; try { b = JSON.parse(body || "{}"); } catch { /* форма */ }
      if (method === "getUpdates") return res.end(JSON.stringify({ ok: true, result: queue.splice(0) }));
      tg.push({ method, body: b });
      return res.end(JSON.stringify({ ok: true, result: { message_id: 500 + tg.length } }));
    }
    if (url.pathname === "/login/token.php") return res.end(JSON.stringify({ token: "tok-" + (new URLSearchParams(body).get("username") || "x") }));
    if (url.pathname.endsWith("/server.php")) {
      const p = new URLSearchParams(body), fn = p.get("wsfunction"), n = Number(String(p.get("wstoken")).replace(/\D/g, "")) || 1;
      if (fn === "core_webservice_get_site_info") return res.end(JSON.stringify({ userid: 1000 + n, fullname: `Тест ${n}`, username: `u${n}` }));
      if (fn === "tool_mobile_call_external_functions") return res.end(JSON.stringify({ responses: [] }));
      return res.end(JSON.stringify([]));
    }
    res.end("{}");
  });
});
await new Promise((r) => fake.listen(FPORT, "127.0.0.1", r));

const p = (...a) => join(SIM, ...a);
const put = (path, data) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 1)); };
const readJ = (path) => JSON.parse(readFileSync(path, "utf8"));
const labDir = (id, sub) => join(HOME, "moodle-work", "users", String(id), sub);

/** Файлы человека во всех хранилищах (кроме записи пользователя и бесед — они создаются отдельно). */
function seedFiles(id) {
  put(p("notify", `${id}.json`), { grades: { a: "5" }, journal: { subjects: { x: { abs: ["12.10"] } } }, schedule: { g: 1 } });
  put(p("notify", `${id}.json.bad-20261020-1200`), "{ испорчено");
  put(p("cloud", `${id}.json`), { at: 1, data: { notes: [{ t: "секрет" }] } });
  put(p("cloud", `${id}.prev.json`), { at: 1, data: { notes: [{ t: "секрет" }] } });
  put(p("cal-cache", `${id}.ics`), "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
  put(p("diag", `${id}.json`), { at: "x", body: "y" });
  put(p("ej-debug", `${id}.json`), { at: "x" });
  put(p("jobs", `${id}-7.json`), { id: "7", tgId: id, key: `${id}-7`, student: { fullName: `Тест ${id}` }, messages: [{ from: "user", text: "привет" }] });
  put(p("jobs", `${id}-8.json.bad-20261020-1200`), "{");
  put(p("checks", `${id}-7.json`), { id: "7", key: `${id}-7`, status: "done" });
  put(labDir(id, "7/title.json"), { fullName: `Тест ${id}` });
  put(labDir(id, "check-7/отчёт.pdf"), "%PDF-");
}
const filesOf = (id) => [p("notify", `${id}.json`), p("notify", `${id}.json.bad-20261020-1200`), p("cloud", `${id}.json`), p("cloud", `${id}.prev.json`), p("cal-cache", `${id}.ics`),
  p("diag", `${id}.json`), p("ej-debug", `${id}.json`), p("jobs", `${id}-7.json`), p("jobs", `${id}-8.json.bad-20261020-1200`), p("checks", `${id}-7.json`), labDir(id, "7/title.json"), labDir(id, "check-7/отчёт.pdf")];
const alive = (list) => list.filter((f) => existsSync(f));

const users = await import(pathToFileURL(p("users.mjs")).href);
for (const [id, name] of [[5001, "u1"], [5002, "u2"]]) { await users.login(id, name, "p"); await users.giveConsent(id); await users.calToken(id); seedFiles(id); }
put(p("users", "5001.json.bad-20261020-1200"), "{ копия с токеном");
put(p("lab-allowlist.txt"), "# разрешено\n5001\n5002\n");
put(p("lab-trials.json"), { v: 1, seededAt: 1, trials: { 5001: { id: "7", at: 1, mu: 1001, title: "Лаба 1", model: null }, 5002: { id: "9", at: 1, mu: 1002, title: "Лаба 2", model: null } }, used: { tg: { 5001: "trial", 5002: "trial" }, mu: { 1001: "5001", 1002: "5002" } } });
put(p("course-styles", "12.json"), { courseId: 12, course: "Курс", entries: [{ src: "s1", tgId: 5001, text: "образец 1" }, { src: "s2", tgId: 5002, text: "образец 2" }] });
put(p("course-styles", "13.json"), { courseId: 13, course: "Курс 2", entries: [{ src: "s1", tgId: 5001, text: "только его" }] });
put(p("chats.json"), { "-100": { title: "Беседа", group: "БПИ-25-1", by: 5001, source: 5001, at: 1, relay: { sent: { a: 1 }, queue: [] } }, "-200": { title: "Чужая", group: "БПИ-25-2", by: 5002, source: 5002, at: 1, relay: { sent: {}, queue: [] } } });
put(join(root, "usage", "bot-stats.json"), { days: { "2026-10-20": { sent: 3 } }, started: { 5001: 111, 5002: 222 }, invitedBy: { 5001: 5002, 5002: 5001 } });
const userRecord5002 = readFileSync(p("users", "5002.json"), "utf8");

const initData = (id) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q" + id, user: JSON.stringify({ id, first_name: "Т" + id }) });
  const dc = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  params.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(dc).digest("hex"));
  return params.toString();
};
const api = async (id, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "x-telegram-init-data": initData(id), "content-type": "application/json", "cf-connecting-ip": `10.9.0.${id % 250}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const cbq = (id, data, mid = 10) => ({ update_id: Date.now() + Math.random(), callback_query: { id: "cb" + Math.random(), from: { id }, data, message: { message_id: mid, chat: { id, type: "private" } } } });
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };

let srv = null, log = "";
try {
  srv = spawn(process.execPath, ["server.mjs"], { cwd: SIM, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", APP_URL: "", BOT_UPDATES: "1",
    CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0", MOODLE_DIRECT: "0", MOODLE_NIGHT: "off", LABS_OFF: "1", GATEWAY_URL: FAKE + "/campus",
    MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/", MISIS_SCHEDULE_INDEX: FAKE + "/schedule/" } });
  srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* стартует */ } await sleep(250); }

  // --- «Выйти»: секреты и кэши уходят, остальное остаётся ---
  const me = await api(5001, "GET", "/api/me");
  check("до выхода человек вошёл", me.status === 200 && me.json.loggedIn === true, JSON.stringify(me.json).slice(0, 100));
  const before = readJ(p("users", "5001.json"));
  check("в записи есть токен и секретная ссылка календаря", !!before.token && !!before.cal?.token && !!before.fullName);
  const out = await api(5001, "POST", "/api/logout", {});
  check("«Выйти» отвечает 200", out.status === 200, JSON.stringify(out.json).slice(0, 100));
  const after = readJ(p("users", "5001.json"));
  check("запись: токена, пароля журнала и ссылки календаря нет", !after.token && !after.ej && !after.ejCred && !after.cal, Object.keys(after).join(","));
  check("запись: ФИО, группа и согласие остались — вернётся и найдёт настройки", after.fullName === before.fullName && !!after.consent);
  check("лента календаря, диагностика, дамп журнала и копия записи удалены", !existsSync(p("cal-cache", "5001.ics")) && !existsSync(p("diag", "5001.json")) && !existsSync(p("ej-debug", "5001.json")) && !existsSync(p("users", "5001.json.bad-20261020-1200")));
  check("уведомления, копия данных приложения и лабы после «Выйти» на месте", existsSync(p("notify", "5001.json")) && existsSync(p("cloud", "5001.json")) && existsSync(p("jobs", "5001-7.json")) && existsSync(labDir(5001, "7/title.json")));
  check("у второго человека ничего не тронуто", alive(filesOf(5002)).length === filesOf(5002).length && readFileSync(p("users", "5002.json"), "utf8") === userRecord5002);

  // --- Отзыв согласия: всё стирается ---
  const login = await api(5001, "POST", "/api/login", { username: "u1", password: "p" });
  check("после «Выйти» входит снова (согласие осталось)", login.status === 200 && login.json.loggedIn === true, `${login.status}`);
  put(p("cal-cache", "5001.ics"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n"); put(p("diag", "5001.json"), { a: 1 });
  queue.push(cbq(5001, "revoke:yes"));
  check("«Да, отозвать»: бот отвечает, что данные удалены", await waitFor(() => tg.some((c) => c.method === "editMessageText" && /Согласие отозвано/.test(c.body.text || "") && /удалены с сервера/.test(c.body.text || ""))), tg.filter((c) => c.method === "editMessageText").map((c) => c.body.text).join(" | ").slice(0, 200));
  await sleep(800);
  const rec = readJ(p("users", "5001.json"));
  check("запись: остались только номер Telegram, отметка отзыва и «вышел»", Object.keys(rec).every((k) => ["tgId", "createdAt", "updatedAt", "consentRevokedAt", "loggedOut"].includes(k)) && rec.loggedOut === true && rec.consentRevokedAt > 0, Object.keys(rec).join(","));
  check("файлы человека во всех хранилищах удалены", alive(filesOf(5001)).length === 0, alive(filesOf(5001)).join(" ; "));
  check("рабочая папка лаб удалена целиком", !existsSync(join(HOME, "moodle-work", "users", "5001")));
  check("файлы второго человека на месте", alive(filesOf(5002)).length === filesOf(5002).length && readFileSync(p("users", "5002.json"), "utf8") === userRecord5002);
  check("белый список: убран первый, второй и комментарий на месте", /5002/.test(readFileSync(p("lab-allowlist.txt"), "utf8")) && !/5001/.test(readFileSync(p("lab-allowlist.txt"), "utf8")) && /# разрешено/.test(readFileSync(p("lab-allowlist.txt"), "utf8")));
  const ledger = readJ(p("lab-trials.json"));
  const hKeys = [...Object.keys(ledger.used.tg), ...Object.keys(ledger.used.mu), ...Object.keys(ledger.trials)];
  check("пробный отчёт: учёт остался, но без номера Telegram, номера учётки Moodle и названия работы",
    !("5001" in ledger.used.tg) && !("1001" in ledger.used.mu) && !("5001" in ledger.trials) && hKeys.filter((k) => k.startsWith("h:")).length === 3 && !JSON.stringify(ledger).includes("Лаба 1") && !Object.values(ledger.trials).some((t) => t.mu === 1001), JSON.stringify(ledger).slice(0, 300));
  check("пробный отчёт второго человека не тронут", ledger.used.tg["5002"] === "trial" && ledger.used.mu["1002"] === "5002" && ledger.trials["5002"]?.title === "Лаба 2");
  const st12 = readJ(p("course-styles", "12.json"));
  check("образцы оформления: его запись убрана, чужая осталась; пустой файл удалён", st12.entries.length === 1 && st12.entries[0].tgId === 5002 && !existsSync(p("course-styles", "13.json")));
  const chats = readJ(p("chats.json"));
  check("беседы: он больше не источник и не «привязавший»; чужая беседа не тронута", chats["-100"] && !("source" in chats["-100"]) && chats["-100"].by === null && chats["-200"].source === 5002 && chats["-200"].by === 5002, JSON.stringify(chats["-100"]));
  const stats = readJ(join(root, "usage", "bot-stats.json"));
  check("статистика бота: даты Start и приглашения убраны, счётчики и чужие записи остались", !("5001" in stats.started) && !("5001" in stats.invitedBy) && stats.started["5002"] === 222 && !Object.values(stats.invitedBy).includes(5001) && stats.days["2026-10-20"]?.sent === 3, JSON.stringify(stats).slice(0, 200));
  const me1 = await api(5001, "GET", "/api/me");
  check("приложение после отзыва закрыто", me1.json.consent === false && me1.json.loggedIn === false);
  check("в журнале сервера нет сбоев очистки", !/purge 5001/.test(log), (log.match(/purge 5001.*/g) || []).join(" | ").slice(0, 300));
  queue.push(cbq(5002, "revoke:no"));
} catch (e) {
  fails++; console.log("FAIL  необработанная ошибка: " + (e.stack || e));
} finally {
  try { srv?.kill(); } catch { /* */ }
  fake.closeAllConnections(); await new Promise((r) => fake.close(r));
  if (fails) console.log("--- журнал сервера ---\n" + log.slice(-2000));
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
  console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
  process.exit(fails ? 1 : 0);
}
