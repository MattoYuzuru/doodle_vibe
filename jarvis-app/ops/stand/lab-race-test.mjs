// Проверка гонки «отчёт готов, а лаба ещё занята» (15 окт 2026): ход агента ставил статус «report» и затем ждал отправки
// PDF в Telegram, а busy снимал только после неё — «Всё хорошо» в это окно получало «Агент ещё работает». Теперь
// уведомления хода уходят после его конца. Здесь Telegram отдаёт PDF 3 с, а «Всё хорошо» нажимается сразу, как только
// приложение видит готовый отчёт.
// Копия модулей во временной папке, заглушка агента (sim-openclaw-stub.mjs), поддельный Bot API — настоящие агент,
// Telegram, Moodle и данные пользователей не затрагиваются. --old — проверить на прежнем поведении (должно упасть).
// Запуск: node ops\stand\lab-race-test.mjs [--old]
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname, APP = join(HERE, "..", "..");
const OLD = process.argv.includes("--old");
const root = join(tmpdir(), `lab-race-test-${process.pid}`), SIM = join(root, "app");
const PORT = 9955, FAKE = `http://127.0.0.1:${PORT}`;
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  let src = readFileSync(join(APP, f), "utf8").split("https://api.telegram.org").join(`${FAKE}/tg`).split("https://newlms.misis.ru").join(FAKE);
  if (OLD && f === "lab.mjs") {
    const was = "if (outbox) outbox.push(send); else await send();";
    if (!src.includes(was)) throw new Error("--old: не нашёл место правки в lab.mjs");
    src = src.replace(was, "await send();");
  }
  writeFileSync(join(SIM, f), src);
}
for (const f of readdirSync(APP).filter((x) => x.endsWith(".md") && /instruction|lab-report/.test(x))) cpSync(join(APP, f), join(SIM, f));
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(root, "home"), APPDATA = join(root, "appdata"), LOG = join(root, "agent.log");
mkdirSync(join(APPDATA, "npm", "node_modules", "openclaw"), { recursive: true });
cpSync(join(HERE, "sim-openclaw-stub.mjs"), join(APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs"));
writeFileSync(LOG, "");
Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA, LOCALAPPDATA: join(root, "local"), SIM_AGENT_LOG: LOG, BOT_UPDATES: "1", LAB_RETRY_MS: "300", LAB_REACHED_MS: "4000",
  MOODLE_PACE: "0", BOT_STATS_DIR: join(root, "usage"), USAGE_TRANSCRIPTS_DIR: join(root, "transcripts"), USAGE_CHAT_TRANSCRIPTS_DIR: join(root, "transcripts") });

// Поддельный Bot API: документ (PDF отчёта) принимает 3 с — как медленная загрузка из дома.
const docs = [];
const fake = createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    if (req.url.endsWith("/sendDocument")) { await new Promise((r) => setTimeout(r, 3000)); docs.push(Date.now()); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));

// Лаба студента 5001 по работе 780, уже начатая (условие скачано): ждёт сообщения. Заглушка агента на «продолжай» по 780
// собирает «Отчёт 780.pdf» и пишет JOB.json со статусом report.
const TG = 5001, ID = "780", KEY = `${TG}-${ID}`, DIR = join(HOME, "moodle-work", "users", String(TG), ID);
mkdirSync(join(DIR, "tmp"), { recursive: true });
mkdirSync(join(SIM, "jobs"), { recursive: true });
writeFileSync(join(SIM, "jobs", `${KEY}.json`), JSON.stringify({ id: ID, tgId: TG, key: KEY, dir: DIR, title: "ЛР 780", course: "Курс", due: null, student: { fullName: "Студент Т.", group: "БИСТ-24-ПО-2", variant: "04" },
  status: "waiting", messages: [{ role: "user", text: "начни", at: Date.now() - 60e3 }, { role: "assistant", text: "прочитал условие", at: Date.now() - 50e3 }], report: null, moodle: null, agent: null,
  token: "a1b2c3d4e5f6a1b2c3d4e5f6", createdAt: Date.now() - 60e3, updatedAt: Date.now() - 50e3 }));

const lab = await import(pathToFileURL(join(SIM, "lab.mjs")).href);
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

await lab.message(TG, ID, "продолжай");
let seen = null, approved = null, err = null;
for (let i = 0; i < 400 && !seen; i++) {
  const j = await lab.get(TG, ID);
  if (j?.status === "report" && j.review === "pending") seen = Date.now();
  else await new Promise((r) => setTimeout(r, 25));
}
check("приложение увидело готовый отчёт", !!seen);
if (seen) {
  try { approved = await lab.approve(TG, ID); } catch (e) { err = String(e.message || e); }
  check("«Всё хорошо» сразу после появления отчёта принято (PDF в Telegram ещё уходит)", approved?.review === "approved" && !err, err || "");
  for (let i = 0; i < 200 && !docs.length; i++) await new Promise((r) => setTimeout(r, 50));
  check("отчёт всё равно ушёл в Telegram документом", docs.length === 1, `документов: ${docs.length}`);
}

// 17 окт 2026 (ревью, п. 2): отчёт подтверждён, студент пишет правку — пока агент работает, «Прикрепить» и «Отправить»
// отклоняются (раньше в Moodle уходил старый или недописанный файл).
const idle = async () => { for (let i = 0; i < 600; i++) { const j = await lab.get(TG, ID); if (j && j.status !== "running") return j; await new Promise((r) => setTimeout(r, 50)); } return null; };
await idle();
await lab.message(TG, ID, "переделай вывод, добавь сравнение с вариантом 03");
let attachErr = null, submitErr = null;
try { await lab.attach(TG, ID, "tok"); } catch (e) { attachErr = String(e.message || e); }
try { await lab.submit(TG, ID, "tok"); } catch (e) { submitErr = String(e.message || e); }
check("во время хода агента «Прикрепить» и «Отправить» отклоняются", /Агент ещё работает/.test(attachErr || "") && /Агент ещё работает/.test(submitErr || ""), `${attachErr} | ${submitErr}`);
await idle();

// 17 окт 2026 (ревью, п. 1): запись задания не удалась (на месте файла — папка: rename падает, как при ENOSPC/EPERM) —
// процесс жив (отказ промиса не необработанный), лаба не остаётся «занятой», студенту — понятное сообщение.
const jobFile = join(SIM, "jobs", `${KEY}.json`);
rmSync(jobFile, { force: true });
mkdirSync(join(jobFile, "x"), { recursive: true });
let unhandled = null;
process.once("unhandledRejection", (e) => { unhandled = e; });
await lab.message(TG, ID, "продолжай");
let after = null;
for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 50)); after = await lab.get(TG, ID); if (after && after.status !== "running") break; }
const last = after?.messages?.at(-1)?.text || "";
check("сбой записи задания: процесс жив, лаба не «занята», студенту — сообщение о сбое", !unhandled && ["waiting", "report"].includes(after?.status) && /Сбой на сервере/.test(last), // готовый отчёт не теряет кнопок
  `${unhandled ? `unhandled: ${unhandled.message}` : "ок"} | ${after?.status} | ${last.slice(0, 80)}`);
let again = null;
try { again = await lab.message(TG, ID, "ещё раз"); } catch (e) { again = String(e.message || e); }
check("после сбоя записи лаба принимает новое сообщение (busy снят)", typeof again === "object" || !/Агент ещё работает/.test(String(again)), String(again?.status ?? again));
rmSync(jobFile, { recursive: true, force: true });
await idle();

fake.closeAllConnections();
await new Promise((r) => fake.close(r));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
