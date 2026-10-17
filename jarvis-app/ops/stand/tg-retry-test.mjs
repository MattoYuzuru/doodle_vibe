// Проверка: отказ Telegram «слишком часто» (429, retry_after) — короткую паузу сервер выжидает и повторяет сообщение
// один раз, долгую не ждёт; «бот заблокирован» не повторяется. И статусы notify.deliver (15 окт 2026): по ним места,
// которые запоминают «отправлено», решают — ставить отметку или повторить позже. Копия notify.mjs и bots.mjs во
// временной папке с поддельным Bot API — настоящий Telegram и бот не затрагиваются.
// С 15 окт 2026 ещё: отказ в соединении — «failed», а не «unknown»; 401/404 (токен) — «failed», а не «rejected»;
// признак down (предохранитель обходов); предел повторов retryExhausted — 6 попыток И 30 минут или сутки, эпизоды,
// unknown не больше одного повтора.
// Запуск: node ops\stand\tg-retry-test.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `tg-retry-test-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const PORT = 9982;
// Таймаут запроса к Bot API в копии — 1,5 с вместо 20: проверка «таймаут сети» не ждёт по 20 секунд.
const copyTo = (dir, base) => {
  mkdirSync(dir, { recursive: true });
  for (const f of ["notify.mjs", "bots.mjs", "bot-stats.mjs", "state-file.mjs"]) writeFileSync(join(dir, f), readFileSync(join(APP, f), "utf8").split("https://api.telegram.org").join(base).replace("timeout = 20000", "timeout = 1500"));
  writeFileSync(join(dir, "bot-token.txt"), "1:TEST");
};
copyTo(root, `http://127.0.0.1:${PORT}`);
// Ещё две копии — с адресом Bot API на закрытом порту 9985 (там никто не слушает; 15 окт 2026): соединение не
// устанавливается, запрос точно не ушёл. «localhost» — два адреса (::1 и 127.0.0.1), у Node ошибка — AggregateError.
const CLOSED = 9985;
copyTo(join(root, "closed"), `http://127.0.0.1:${CLOSED}`);
copyTo(join(root, "closed-lh"), `http://localhost:${CLOSED}`);
process.env.BOT_UPDATES = "1"; // свой бот: запасного пути через OpenClaw нет
process.env.BOT_STATS_DIR = join(root, "usage");

// Поддельный Bot API: ответы по очереди из plan (для каждого chat_id свой план), дальше — успех. Шаг плана: { code, body }
// — ответ; { raw } — тело не JSON; { reset: true } — оборвать соединение; { hang: мс } — ответить позже таймаута клиента.
const plan = new Map(), calls = [];
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(body || "{}"); } catch { j = { chat_id: /name="chat_id"\r\n\r\n(\d+)/.exec(body)?.[1] }; } // форма (документ)
    const chat = Number(j.chat_id);
    calls.push({ chat, at: Date.now(), method: req.url.split("/").pop() });
    const next = (plan.get(chat) || []).shift();
    if (next?.reset) return req.socket.destroy();
    const answer = () => {
      res.writeHead(next?.code || 200, { "content-type": next?.raw ? "text/html" : "application/json" });
      res.end(next?.raw ?? JSON.stringify(next?.body || { ok: true, result: { message_id: calls.length } }));
    };
    if (next?.hang) setTimeout(() => { try { answer(); } catch { /* клиент уже ушёл */ } }, next.hang);
    else answer();
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
const notify = await import(pathToFileURL(join(root, "notify.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const tooMany = (s) => ({ code: 429, body: { ok: false, error_code: 429, description: `Too Many Requests: retry after ${s}`, parameters: { retry_after: s } } });
const run = async (chat, steps) => { plan.set(chat, steps); const from = calls.length, t = Date.now(); const r = await notify.send(chat, "проверка"); return { r, n: calls.slice(from).filter((c) => c.chat === chat).length, ms: Date.now() - t }; };

let x = await run(101, [tooMany(1)]);
check("429 с паузой 1 с: сервер ждёт и повторяет, сообщение доходит", x.r === true && x.n === 2 && x.ms >= 1000, JSON.stringify(x));
x = await run(102, [tooMany(1), tooMany(1)]);
check("429 два раза подряд: повтор один, дальше «не ушло» (без бесконечного цикла)", x.r === false && x.n === 2, JSON.stringify(x));
x = await run(103, [tooMany(120)]);
check("429 с долгой паузой (2 мин): не ждём — «не ушло» сразу", x.r === false && x.n === 1 && x.ms < 2000, JSON.stringify(x));
x = await run(104, [{ code: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }]);
check("бот заблокирован (403): без повтора", x.r === false && x.n === 1, JSON.stringify(x));
x = await run(105, []);
check("обычная отправка — один запрос", x.r === true && x.n === 1, JSON.stringify(x));

// Статусы deliver: что сообщение дошло, не дойдёт никогда, временно не ушло или неизвестно (могло и уйти).
const runD = async (chat, steps, text = "проверка", media) => { plan.set(chat, steps); const from = calls.length; const r = await notify.deliver(chat, text, media); return { ...r, n: calls.slice(from).filter((c) => c.chat === chat).length }; };
const brief = (r) => `${r.status} ok=${r.ok} retryable=${r.retryable} maybe=${r.maybe} n=${r.n}${r.retryAfter ? ` retryAfter=${r.retryAfter}` : ""}`;
x = await runD(111, []);
check("deliver: дошло → sent (ok, не повторять)", x.status === "sent" && x.ok && !x.retryable && x.n === 1, brief(x));
x = await runD(112, [{ code: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }]);
check("deliver: 403 → unreachable (не ok, не повторять, без второго запроса)", x.status === "unreachable" && !x.ok && !x.retryable && !x.maybe && x.n === 1, brief(x));
x = await runD(113, [tooMany(1), tooMany(1)]);
check("deliver: 429 два раза подряд → limited (повторить позже), retryAfter из ответа", x.status === "limited" && x.retryable && !x.maybe && x.n === 2 && x.retryAfter === 1, brief(x));
x = await runD(114, [tooMany(120)]);
check("deliver: 429 с долгой паузой → limited сразу, без ожидания", x.status === "limited" && x.retryable && x.n === 1 && x.retryAfter === 120, brief(x));
x = await runD(115, [{ reset: true }]);
check("deliver: оборванное соединение → unknown (могло дойти: retryable и maybe)", x.status === "unknown" && x.retryable && x.maybe && !x.ok, brief(x));
let t0 = Date.now();
x = await runD(116, [{ hang: 3000 }]);
check("deliver: таймаут ответа → unknown", x.status === "unknown" && x.retryable && x.maybe && Date.now() - t0 < 2900, `${brief(x)}, ${Date.now() - t0} мс`);
x = await runD(117, [{ code: 500, body: { ok: false, error_code: 500, description: "Internal Server Error" } }]);
check("deliver: 500 → failed (точно не дошло — повторить)", x.status === "failed" && x.retryable && !x.maybe && x.n === 1, brief(x));
x = await runD(118, [{ code: 502, raw: "<html>Bad Gateway</html>" }]);
check("deliver: ответ не JSON (502) → failed", x.status === "failed" && x.retryable && !x.maybe, brief(x));
x = await runD(119, [{ code: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too long" } }]);
check("deliver: 400 «слишком длинное» → rejected (не повторять)", x.status === "rejected" && !x.retryable && !x.ok && x.n === 1, brief(x));
x = await runD(120, [{ code: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }]);
check("deliver: 400 «chat not found» → unreachable", x.status === "unreachable" && !x.retryable, brief(x));
const pdf = join(root, "отчёт.pdf");
writeFileSync(pdf, "%PDF-1.4 проверка");
x = await runD(121, [{}, { code: 500, body: { ok: false, error_code: 500, description: "Internal Server Error" } }], "т".repeat(1100), pdf);
check("deliver: длинный текст ушёл, документ нет → partial (не повторять: дубль текста), maybe", x.status === "partial" && !x.retryable && x.maybe && x.n === 2, brief(x));
x = await runD(122, [], "короткий", join(root, "нет-такого.pdf"));
check("deliver: файл вложения не прочитался → failed, в Telegram ничего не ушло", x.status === "failed" && x.retryable && x.n === 0, brief(x));
x = await runD(123, [], "короткий", pdf);
check("deliver: документ с подписью → sent одним запросом", x.status === "sent" && x.n === 1 && calls.at(-1).method === "sendDocument", brief(x));
check("settled: дошло, недоступен, отказ 4xx, частично — отметку ставить; временный сбой и неизвестно — нет",
  notify.settled({ status: "sent", retryable: false }) && notify.settled({ status: "unreachable", retryable: false }) && notify.settled({ status: "rejected", retryable: false })
  && notify.settled({ status: "partial", retryable: false, maybe: true }) && !notify.settled({ status: "failed", retryable: true }) && !notify.settled({ status: "unknown", retryable: true, maybe: true }));
check("settled с dupOk: false — неизвестный исход считается отправленным (дубль хуже потери), точный сбой — нет",
  notify.settled({ status: "unknown", retryable: true, maybe: true }, { dupOk: false }) && !notify.settled({ status: "limited", retryable: true, maybe: false }, { dupOk: false }));

// 15 окт 2026. Токен отклонён (401) или битый (404) — беда бота, а не сообщения: «failed» (повторить), не «rejected».
x = await runD(124, [{ code: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }]);
check("deliver: 401 Unauthorized → failed (повторить после починки токена), не rejected; down — остальное в проходе не пробовать", x.status === "failed" && x.retryable && !x.maybe && x.down && x.n === 1, brief(x));
x = await runD(125, [{ code: 404, body: { ok: false, error_code: 404, description: "Not Found" } }]);
check("deliver: 404 Not Found (битый токен) → failed, не rejected", x.status === "failed" && x.retryable && x.down, brief(x));
// Признак down («связь с Telegram или бот, а не это сообщение»): у обрыва, таймаута и 429 — да; у 500, 400, 403 — нет.
const downOf = async (chat, steps) => (await runD(chat, steps)).down;
check("down: обрыв и 429 — да; 500, 400 «слишком длинное», 403 и удачная отправка — нет",
  (await downOf(126, [{ reset: true }])) && (await downOf(127, [tooMany(120)])) && !(await downOf(128, [{ code: 500, body: { ok: false, error_code: 500, description: "Internal Server Error" } }]))
  && !(await downOf(129, [{ code: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too long" } }])) && !(await downOf(130, [{ code: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }]))
  && !(await downOf(131, [])));

// Соединение не установилось (закрытый порт): запрос точно не ушёл — «failed» (повторить), а не «unknown» (могло дойти).
const closed = await import(pathToFileURL(join(root, "closed", "notify.mjs")).href), closedLh = await import(pathToFileURL(join(root, "closed-lh", "notify.mjs")).href);
t0 = Date.now();
x = await closed.deliver(201, "проверка");
check("deliver: отказ в соединении (ECONNREFUSED, 127.0.0.1) → failed, не maybe, down; код ошибки в описании", x.status === "failed" && x.retryable && !x.maybe && x.down && /ECONNREFUSED/.test(x.description) && Date.now() - t0 < 1400, `${brief({ ...x, n: 0 })}, «${x.description}», ${Date.now() - t0} мс`);
x = await closedLh.deliver(202, "проверка");
check("deliver: отказ в соединении по «localhost» (AggregateError) → тоже failed", x.status === "failed" && !x.maybe && /ECONNREFUSED/.test(x.description), `${x.status}, «${x.description}»`);
check("settled с dupOk: false (утренняя сводка): отказ в соединении — НЕ отправлено, отметку снять", !closed.settled(x, { dupOk: false }));

// Предел повторов (retryExhausted) — чистая функция, время подаётся явно.
const MIN = 60e3, H = 60 * MIN, T = Date.UTC(2026, 9, 15, 12, 0);
const failed = { status: "failed", retryable: true, maybe: false }, unknown = { status: "unknown", retryable: true, maybe: true };
const ex = (st, r, now, opts = {}) => notify.retryExhausted(st, "k", r, { ...opts, now });
let st = {}, res = [];
for (let i = 0; i < 8; i++) res.push(ex(st, failed, T + i * MIN)); // 8 неудач за 7 минут (быстрый путь: «Тест открыт», материалы)
check("6+ неудач за 7 минут — ещё не предел (нужно и 6 попыток, и 30 минут с первой)", res.every((v) => v === false) && st.retry.k.n === 8, JSON.stringify(st.retry.k));
check("та же серия через 30 минут после первой неудачи — предел, запись убрана", ex(st, failed, T + 30 * MIN) === true && !st.retry);
st = {}; res = [];
for (const m of [0, 10, 20, 31]) res.push(ex(st, failed, T + m * MIN));
check("4 неудачи за 31 минуту — не предел (попыток меньше 6)", res.every((v) => v === false) && st.retry.k.n === 4);
st = { retry: { k: { n: 5, first: T - 25 * H } } }; // остаток прошлого эпизода (без last — запись прежнего формата)
check("остаток эпизода старше суток: новая неудача начинает счёт заново, а не исчерпывает попытки сразу", ex(st, failed, T) === false && st.retry.k.n === 1 && st.retry.k.first === T, JSON.stringify(st.retry.k));
st = { retry: { k: { n: 5, first: T - 3 * H, last: T - 3 * H } } };
check("остаток моложе суток, но 3 ч без неудач — тоже новый эпизод", ex(st, failed, T) === false && st.retry.k.n === 1, JSON.stringify(st.retry.k));
st = { retry: { k: { n: 3, first: T - 25 * H, last: T - 40 * MIN } } };
check("затянувшийся эпизод (неудачи шли, первая — сутки назад) — предел «сутки»", ex(st, failed, T) === true && !st.retry);
st = {};
check("unknown: первый раз — повтор; второй — отметка (не больше одного дубля)", ex(st, unknown, T) === false && st.retry.k.unknown === 1 && ex(st, unknown, T + MIN) === true && !st.retry);
st = {};
check("unknown после точных сбоев: один повтор, второй unknown — отметка", ex(st, failed, T) === false && ex(st, unknown, T + MIN) === false && ex(st, failed, T + 2 * MIN) === false && ex(st, unknown, T + 3 * MIN) === true);
st = {}; res = [];
for (let i = 0; i < 20; i++) res.push(ex(st, failed, T + i * 10 * MIN, { max: Infinity, min: Infinity, ms: Infinity })); // «Сессия»: повторы ограничивает окно
check("без пределов по числу и времени (напоминания «Сессии»): точный сбой повторяется, unknown — один раз", res.every((v) => v === false)
  && ex(st, unknown, T + 201 * MIN, { max: Infinity, min: Infinity, ms: Infinity }) === false && ex(st, unknown, T + 202 * MIN, { max: Infinity, min: Infinity, ms: Infinity }) === true);
st = { retry: { k: null, j: { n: 1, first: T } } };
notify.retryClear(st, "k");
check("retryClear убирает и испорченную запись (null)", !("k" in st.retry) && !!st.retry.j);

fake.closeAllConnections();
await new Promise((r) => fake.close(r));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
