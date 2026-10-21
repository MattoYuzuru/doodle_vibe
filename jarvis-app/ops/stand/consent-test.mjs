// Согласие на обработку персональных данных (consent.mjs, users.mjs, welcome.mjs, server.mjs; 21 окт 2026) — от кнопки в
// боте до запрета в приложении. Настоящий server.mjs на копии кода во временной папке: поддельный Moodle и Telegram на
// 127.0.0.1, сообщения боту приходят через поддельный getUpdates, запросы приложения подписаны тестовым токеном бота.
// Настоящие Moodle, журнал, Telegram, данные и ключи не затрагиваются; домашняя папка и APPDATA сервера — временные.
// Запуск: node ops/stand/consent-test.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `consent-test-${process.pid}`), SIM = join(root, "app");
const FPORT = 9971, PORT = 18900 + Math.floor(Math.random() * 90);
const FAKE = `http://127.0.0.1:${FPORT}`, B = `http://127.0.0.1:${PORT}`;
const BOT = "123456:CONSENT-TEST", OWNER = 945210206;
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
const tg = []; // все вызовы Bot API: { method, body }
const queue = []; // обновления для getUpdates
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

const users = await import(pathToFileURL(join(SIM, "users.mjs")).href);
// Вошедшие ДО обновления правил (записи без согласия) — их создаёт прежний вход, до запуска сервера.
await users.login(5002, "u2", "p"); await users.login(5003, "u3", "p");

const initData = (id) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q" + id, user: JSON.stringify({ id, first_name: "Т" + id }) });
  const dc = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  params.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(dc).digest("hex"));
  return params.toString();
};
const api = async (id, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "x-telegram-init-data": initData(id), "content-type": "application/json", "cf-connecting-ip": `10.9.0.${id % 250}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
};
const cbq = (id, data, mid = 10) => ({ update_id: Date.now() + Math.random(), callback_query: { id: "cb" + Math.random(), from: { id }, data, message: { message_id: mid, chat: { id, type: "private" } } } });
const msg = (id, text) => ({ update_id: Date.now() + Math.random(), message: { message_id: 1, from: { id, is_bot: false, first_name: "Т" }, chat: { id, type: "private" }, text } });
const sentTo = (id, re) => tg.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === id && re.test(String(c.body.text || "")));
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };

let srv = null, log = "";
try {
  srv = spawn(process.execPath, ["server.mjs"], { cwd: SIM, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", APP_URL: "", BOT_UPDATES: "1", CONSENT_ASK_FIRST_MS: "1500",
    CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0", MOODLE_DIRECT: "0", MOODLE_NIGHT: "off", LABS_OFF: "1", GATEWAY_URL: FAKE + "/campus",
    MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/", MISIS_SCHEDULE_INDEX: FAKE + "/schedule/" } });
  srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* стартует */ } await sleep(250); }

  // --- Вошедшие до обновления: запрос согласия, пока его нет — ничего не читается ---
  check("вошедшим без согласия бот сам присылает запрос с кнопками", await waitFor(() => sentTo(5002, /Согласие на обработку/.test("") || /Doodle обновил правила/).length === 1 && sentTo(5003, /Doodle обновил правила/).length === 1), `${sentTo(5002, /./).length} / ${sentTo(5003, /./).length}`);
  const ask2 = sentTo(5002, /Doodle обновил правила/)[0]?.body;
  check("в запросе — текст согласия (трансграничная передача, срок, отзыв) и кнопка «Согласен(на)»", /трансграничную передачу/.test(ask2?.text || "") && /\/revoke/.test(ask2?.text || "") && JSON.stringify(ask2?.reply_markup || {}).includes("consent:yes"));
  check("без согласия токен Moodle не отдаётся, в обходы такой пользователь не попадает", (await users.moodleToken(5002)) === null && !(await users.allLoggedIn()).some((u) => u.tgId === 5002));
  const me2 = await api(5002, "GET", "/api/me");
  check("приложение: профиль есть, но loggedIn = false и consent = false", me2.status === 200 && me2.json.consent === false && me2.json.loggedIn === false, JSON.stringify(me2.json).slice(0, 120));
  const dl = await api(5002, "GET", "/api/deadlines");
  check("приложение: остальные запросы → 403 consent_required со строкой для пользователя", dl.status === 403 && dl.json.code === "consent_required" && /согласие/i.test(dl.json.error || ""), JSON.stringify(dl.json).slice(0, 140));
  const lg = await api(5002, "POST", "/api/login", { username: "u2", password: "p" });
  check("вход без согласия закрыт: форма получит ту же строку", lg.status === 403 && lg.json.code === "consent_required");
  queue.push(msg(5002, "/deadlines"));
  check("команда бота без согласия не отвечает данными — вместо них запрос согласия", await waitFor(() => sentTo(5002, /Doodle обновил правила/).length === 2) && sentTo(5002, /./).every((c) => /Согласие на обработку/.test(c.body.text)));
  const before = sentTo(5002, /Doodle обновил правила/).length;
  await sleep(2500);
  check("повторный запрос в течение суток не уходит", sentTo(5002, /Doodle обновил правила/).length === before);

  // --- Новый пользователь: /start → запрос вместо приветствия → «Согласен(на)» → приветствие ---
  queue.push(msg(5001, "/start"));
  check("/start без согласия: приходит запрос согласия, а не приветствие", await waitFor(() => sentTo(5001, /Согласие на обработку/).length === 1) && sentTo(5001, /Привет! Это Doodle/).length === 0);
  const ask1 = sentTo(5001, /Согласие на обработку/)[0].body;
  check("запрос новому пользователю — с вводной «нужно ваше отдельное согласие» и двумя кнопками", /отдельное согласие/.test(ask1.text) && JSON.stringify(ask1.reply_markup).includes("consent:yes") && JSON.stringify(ask1.reply_markup).includes("consent:no"));
  queue.push(cbq(5001, "consent:no"));
  check("«Не согласен(на)»: согласия нет, приложение закрыто", await waitFor(() => tg.some((c) => c.method === "editMessageText" && /Без согласия Doodle/.test(c.body.text || ""))) && (await api(5001, "GET", "/api/me")).json.consent === false);
  queue.push(cbq(5001, "consent:yes"));
  check("«Согласен(на)»: сообщение заменено подтверждением, после него — приветствие", await waitFor(() => tg.some((c) => c.method === "editMessageText" && /Согласие записано/.test(c.body.text || "")) && sentTo(5001, /Привет! Это Doodle/).length === 1));
  const rec = JSON.parse(readFileSync(join(SIM, "users", "5001.json"), "utf8"));
  check("в записи пользователя — редакция и время согласия", rec.consent?.v === "2026-10-21" && rec.consent.at > Date.now() - 60e3, JSON.stringify(rec.consent));
  const login1 = await api(5001, "POST", "/api/login", { username: "u1", password: "p" });
  check("с согласием вход работает", login1.status === 200 && login1.json.loggedIn === true && login1.json.consent === true, `${login1.status} ${JSON.stringify(login1.json).slice(0, 100)}`);
  const dl1 = await api(5001, "GET", "/api/deadlines");
  check("с согласием приложение больше не отвечает consent_required", dl1.json.code !== "consent_required", `${dl1.status}`);

  // --- Существующий пользователь нажимает «Согласен(на)» — обходы и приложение работают ---
  queue.push(cbq(5002, "consent:yes"));
  check("вошедший ранее: после «Согласен(на)» приложение открыто, а запись хранит редакцию", await waitFor(async () => (await api(5002, "GET", "/api/me")).json.loggedIn === true) && (await api(5002, "GET", "/api/deadlines")).json.code !== "consent_required" && JSON.parse(readFileSync(join(SIM, "users", "5002.json"), "utf8")).consent?.v === "2026-10-21");

  // --- /consent и /revoke ---
  queue.push(msg(5001, "/consent"));
  check("/consent у согласившегося: текст и дата, как отозвать", await waitFor(() => sentTo(5001, /Согласие дано/).length === 1));
  queue.push(msg(5001, "/revoke"));
  check("/revoke просит подтверждение", await waitFor(() => sentTo(5001, /Отозвать согласие\?/).length === 1));
  queue.push(cbq(5001, "revoke:no"));
  check("«Отмена»: согласие остаётся", await waitFor(() => tg.some((c) => c.method === "editMessageText" && /согласие остаётся/.test(c.body.text || ""))) && (await api(5001, "GET", "/api/me")).json.consent === true);
  queue.push(cbq(5001, "revoke:yes"));
  check("«Да, отозвать»: согласие стёрто, доступ к Moodle удалён с сервера", await waitFor(() => tg.some((c) => c.method === "editMessageText" && /Согласие отозвано/.test(c.body.text || ""))));
  const rec2 = JSON.parse(readFileSync(join(SIM, "users", "5001.json"), "utf8"));
  check("запись после отзыва: нет токена и пароля журнала, нет согласия, есть дата отзыва", !rec2.token && !rec2.ejCred && !rec2.consent && rec2.consentRevokedAt > 0 && rec2.loggedOut === true);
  const me1 = await api(5001, "GET", "/api/me");
  check("после отзыва приложение снова закрыто", me1.json.consent === false && me1.json.loggedIn === false && (await api(5001, "GET", "/api/deadlines")).json.code === "consent_required");
  queue.push(cbq(5001, "settings:x"));
  check("кнопки настроек без согласия не работают — всплывает подсказка", await waitFor(() => tg.some((c) => c.method === "answerCallbackQuery" && /\/consent/.test(c.body.text || ""))));

  // --- Владелец (автор сервиса) — оператор: его согласие не требуется ---
  const own = await api(OWNER, "GET", "/api/me");
  check("владельцу согласие не нужно: consent = true, запросы не закрыты", own.status === 200 && own.json.consent === true && (await api(OWNER, "GET", "/api/deadlines")).json.code !== "consent_required");
} catch (e) {
  fails++; console.log("FAIL  необработанная ошибка: " + (e.stack || e));
} finally {
  try { srv?.kill(); } catch { /* */ }
  fake.closeAllConnections(); await new Promise((r) => fake.close(r));
  if (fails) console.log("--- журнал сервера ---\n" + log.slice(-1500));
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
  console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
  process.exit(fails ? 1 : 0);
}
