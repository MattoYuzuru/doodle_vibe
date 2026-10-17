// Репетиция переезда на нового бота (ops\bot-move.mjs) на копии во временной папке с поддельным Telegram:
// настоящим ботам ничего не уходит, настоящие токены не читаются. Запуск: node bot-move-test.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, "..", "..");
const SIM = mkdtempSync(join(tmpdir(), "bot-move-")), PORT = 9922, FAKE = `http://127.0.0.1:${PORT}/tg`;
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const text = (f) => readFileSync(join(SIM, f), "utf8").trim();

// Копия нужных файлов с подменой адреса Telegram.
mkdirSync(join(SIM, "ops")); mkdirSync(join(SIM, "users"));
for (const f of ["bots.mjs", "notify.mjs", "welcome.mjs"]) writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").replaceAll("https://api.telegram.org", FAKE));
writeFileSync(join(SIM, "ops", "bot-move.mjs"), readFileSync(join(APP, "ops", "bot-move.mjs"), "utf8"));
writeFileSync(join(SIM, "bot-token.txt"), "111:OLD");
writeFileSync(join(SIM, "current-url.txt"), "https://sim.example.test\n");
for (const id of [5001, 5002, 5003, 5004]) writeFileSync(join(SIM, "users", `${id}.json`), "{}");
writeFileSync(join(SIM, "users", "readme.txt"), "не пользователь");

// Поддельный Telegram: отвечает по токену из адреса, запоминает вызовы. 5003 заблокировал прежнего бота; на первое
// сообщение для 5004 связь рвётся (сбой сети); 5002 не нажал Start у нового бота.
const calls = [];
let dropOnce = true;
const server = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const m = /^\/tg\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
    let j = {}; try { j = JSON.parse(body || "{}"); } catch { /* */ }
    const bot = m?.[1] === "111:OLD" ? "old" : m?.[1] === "222:NEW" ? "new" : "?";
    calls.push({ bot, method: m?.[2], body: j });
    const out = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (bot === "?") return out({ ok: false, error_code: 401, description: "Unauthorized" });
    if (m[2] === "getMe") return out({ ok: true, result: bot === "old" ? { id: 111, username: "OldJarvisBot", first_name: "Jarvis" } : { id: 222, username: "DoodleNewBot", first_name: "Doodle" } });
    if (m[2] === "sendMessage" && j.chat_id === 5003) return out({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    if (m[2] === "sendMessage" && j.chat_id === 5004 && dropOnce) { dropOnce = false; return req.socket.destroy(); }
    if (m[2] === "sendChatAction" && bot === "new" && j.chat_id === 5002) return out({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    out({ ok: true, result: true });
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
// Запуск скрипта без блокировки этого процесса: поддельный Telegram живёт здесь же и должен отвечать.
const run = (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(SIM, "ops", "bot-move.mjs"), ...args], { cwd: SIM, env: { ...process.env, BOT_UPDATES: "" } });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
});
const by = (bot, method) => calls.filter((c) => c.bot === bot && c.method === method);
const messages = () => calls.filter((c) => c.method === "sendMessage");

{ // Без файла с новым токеном — отказ, ничего не тронуто.
  const r = await run("go");
  check("нет bot-token-new.txt → переезд не начинается, Telegram не тронут", r.code === 1 && /Нет файла bot-token-new\.txt/.test(r.out) && calls.length === 0, r.out.trim().slice(0, 100));
  const f = await run("farewell");
  check("прощание до переключения — отказ: сообщений нет", f.code === 1 && !messages().length, f.out.trim().slice(0, 100));
}
{ // В файле токен того же бота — отказ.
  writeFileSync(join(SIM, "bot-token-new.txt"), "111:OLD");
  const r = await run("go");
  check("в bot-token-new.txt токен прежнего бота → отказ, файлы на месте", r.code === 1 && /того же бота/.test(r.out) && text("bot-token.txt") === "111:OLD" && !existsSync(join(SIM, "bot-token-prev.txt")), r.out.trim().slice(-90));
}
{ // Проверка: показывает ботов и число людей, ничего не меняет и не шлёт; токены не печатает.
  writeFileSync(join(SIM, "bot-token-new.txt"), "222:NEW\n");
  calls.length = 0;
  const r = await run("check");
  check("check: называет обоих ботов и число людей, ничего не отправляет и не меняет", r.code === 0 && /@OldJarvisBot/.test(r.out) && /@DoodleNewBot/.test(r.out) && /сообщение: 4\b/.test(r.out)
    && calls.every((c) => c.method === "getMe") && text("bot-token.txt") === "111:OLD", r.out.trim().split("\n").slice(0, 2).join(" ⏎ ").slice(0, 160));
  check("check: токены в вывод не попадают", !/111:OLD|222:NEW/.test(r.out));
}
{ // Переключение: новый бот настроен, токены поменялись, людям — ни одного сообщения.
  calls.length = 0;
  const r = await run("go");
  check("go: новому боту поставлены описание, короткое описание, команды и кнопка приложения",
    r.code === 0 && by("new", "setMyDescription").length === 1 && by("new", "setMyShortDescription").length === 1 && by("new", "setMyCommands")[0]?.body.commands.some((c) => c.command === "start")
    && by("new", "setChatMenuButton")[0]?.body.menu_button.web_app.url === "https://sim.example.test", r.out.trim().split("\n").slice(2, 6).join(" ⏎ ").slice(0, 200));
  check("go: токены поменялись местами, прежний — в bot-token-prev.txt, включён приём сообщений; людям ничего не отправлено, прежний бот не тронут",
    text("bot-token.txt") === "222:NEW" && text("bot-token-prev.txt") === "111:OLD" && !existsSync(join(SIM, "bot-token-new.txt")) && existsSync(join(SIM, "bot-updates.on"))
    && !messages().length && calls.filter((c) => c.bot === "old").every((c) => c.method === "getMe"));
  check("go: токены в вывод не попадают", !/111:OLD|222:NEW/.test(r.out));
}
{ // Откат до прощания возвращает всё как было; повторное переключение снова проходит.
  const b = await run("back");
  const rolled = b.code === 0 && text("bot-token.txt") === "111:OLD" && text("bot-token-new.txt") === "222:NEW" && !existsSync(join(SIM, "bot-token-prev.txt")) && !existsSync(join(SIM, "bot-updates.on"));
  const again = await run("go");
  check("back: до прощания переключение откатывается полностью; затем go проходит снова", rolled && again.code === 0 && text("bot-token.txt") === "222:NEW" && text("bot-token-prev.txt") === "111:OLD" && existsSync(join(SIM, "bot-updates.on")) && !messages().length, `${b.code} ${again.code}`);
}
{ // Прощание: прежним ботом, каждому один раз; сбой сети — досылка только тому, кому не дошло.
  calls.length = 0;
  const r1 = await run("farewell");
  const first = by("old", "sendMessage");
  check("farewell: сообщение уходит прежним ботом со ссылкой на нового; заблокировавший назван; при сбое сети прежний бот ещё не отключается",
    r1.code === 2 && first.length === 4 && /переехал в нового бота: @DoodleNewBot/.test(first[0].body.text) && first[0].body.reply_markup.inline_keyboard[0][0].url === "https://t.me/DoodleNewBot?start=move"
    && /доставлено 2 из 4/.test(r1.out) && /5003/.test(r1.out) && /Не ушло из-за сети: 1/.test(r1.out) && !by("new", "sendMessage").length && !by("old", "setChatMenuButton").length, r1.out.trim().replace(/\n/g, " ⏎ ").slice(0, 260));
  calls.length = 0;
  const r2 = await run("farewell");
  const second = by("old", "sendMessage"), oldMenu = by("old", "setChatMenuButton");
  check("farewell повторно: досылается только тому, кому не дошло; остальным второй раз не уходит",
    r2.code === 0 && second.length === 1 && second[0].body.chat_id === 5004 && /доставлено 3 из 4/.test(r2.out), `${second.map((c) => c.body.chat_id).join(",")} | ${r2.out.trim().split("\n")[0]}`);
  check("farewell: у прежнего бота снята кнопка приложения (общая и у каждого чата), описание заменено ссылкой",
    oldMenu.length === 5 && oldMenu.every((c) => c.body.menu_button.type === "commands") && /переехал: @DoodleNewBot/.test(by("old", "setMyDescription")[0]?.body.description || "") && by("old", "setMyShortDescription").length === 1);
  calls.length = 0;
  const r3 = await run("farewell");
  check("farewell в третий раз: никому ничего не уходит", r3.code === 0 && !messages().length);
  const b = await run("back");
  check("back после прощания — отказ: файлы не меняются", b.code === 1 && text("bot-token.txt") === "222:NEW" && /уже уходило/.test(b.out));
  check("farewell: токены в вывод не попадают", !/111:OLD|222:NEW/.test(r1.out + r2.out + r3.out));
}
{ // Повторное переключение после переезда ничего не делает.
  calls.length = 0;
  const r = await run("go");
  check("повторный go после переезда: отказ, никому ничего не уходит", r.code === 1 && !messages().length && text("bot-token.txt") === "222:NEW", r.out.trim().slice(0, 90));
}
{ // Кто ещё не перешёл.
  calls.length = 0;
  const r = await run("who");
  check("who: новый бот проверяет, кому может писать, и называет не перешедших; сообщений не шлёт",
    r.code === 0 && /может писать: 3/.test(r.out) && /5002/.test(r.out) && calls.every((c) => c.bot === "new" && c.method === "sendChatAction"), r.out.trim().replace(/\n/g, " ⏎ "));
}
server.close();
rmSync(SIM, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
