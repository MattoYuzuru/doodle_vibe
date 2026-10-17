// Проверка вопроса «Это ваша дисциплина?» о дисциплине электронного журнала без курса в Moodle (16 окт 2026, владелец:
// «при расхождении лучше уточнять информацию у самого студента, существует ли у него такой курс или нет»):
// attendance.checkJournal спрашивает один раз с кнопками, отметка — только после доставки (временный сбой — спросить
// снова, /stop — не отмечать, «не дойдёт никогда» — отметить), ночью, без курсов и с выключенными уведомлениями журнала
// не спрашивает; нажатие (bot-commands.callback ejq:<y|n>:<id>) правит сообщение, «не моя» убирает дисциплину из
// уведомлений журнала, новый ответ уходит владельцу (свой ответ владельца — нет).
// Копия модулей во временной папке, журнал ej — заглушка (ej.journal), поддельный Bot API на 127.0.0.1:9987: настоящие
// Telegram, Moodle, журнал и данные пользователей не затрагиваются. Запуск: node ops\stand\journal-ask-test.mjs
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", ".."), PORT = 9987, FAKE = `http://127.0.0.1:${PORT}`;
const root = join(tmpdir(), `journal-ask-test-${process.pid}`), SIM = join(root, "app");
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").split("https://api.telegram.org").join(`${FAKE}/tg`).split("https://newlms.misis.ru").join(FAKE)
    .split("https://ej.misis.ru").join(`${FAKE}/ej`).split("https://misis.ru").join(`${FAKE}/misis`));
}
// Журнал — заглушка: всё из настоящего ej.mjs, кроме journal() (его данные задаёт проверка) и lastGood() (последний
// удачный ответ, как кэш настоящего; __ejLast.delete(id) — «после перезапуска сервера»).
renameSync(join(SIM, "ej.mjs"), join(SIM, "ej-real.mjs"));
writeFileSync(join(SIM, "ej.mjs"), `export * from "./ej-real.mjs";
export async function journal(tgId) { const d = globalThis.__ej?.get(Number(tgId)); if (!d) throw new Error("журнал не ответил"); globalThis.__ejLast.set(Number(tgId), structuredClone(d)); return structuredClone(d); }
export function lastGood(tgId) { return globalThis.__ejLast?.get(Number(tgId)) ?? null; }
`);
globalThis.__ejLast = new Map();
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
const HOME = join(root, "home");
Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"), BOT_UPDATES: "1", MOODLE_DIRECT: "0",
  MOODLE_PACE: "0", MOODLE_PACE_DIR: join(root, "usage"), BOT_STATS_DIR: join(root, "usage"), SESSION_WATCH: "0", SESSION_CACHE: join(root, "session"),
  CURRICULUM_CACHE: join(root, "curriculum"), MISIS_SCHEDULE_INDEX: `${FAKE}/misis/schedule/`, MISIS_EDUOP_URL: `${FAKE}/misis/eduop/`, MISIS_SESSION_URL: `${FAKE}/misis/session/`,
  JOURNAL_EVERY_MS: "1", JOURNAL_ASK_TELL_MS: "300" });
const OWNER = 945210206, S = 7101;
mkdirSync(join(SIM, "users"), { recursive: true });
const seed = (id, o = {}) => writeFileSync(join(SIM, "users", `${id}.json`), JSON.stringify({ tgId: id, ej: "заглушка", group: "БИСТ-24-ПО-2", ...o }));
seed(OWNER, { fullName: "Владелец Стенда" });
seed(S, { fullName: "Студент Стенда", tgName: "Студент", tgUsername: "student_stand" });
for (const id of [7102, 7103, 7104, 7105, 7106, 7107, 7108, 7109, 7110, 7111, 7112, 7113, 7114, 7115, 7116, 7117, 7118, 7119, 7120, 7121]) seed(id, { fullName: `Студент ${id}` });

// Поддельный Bot API: tg — все попытки { chat, text, buttons (ряды «текст=данные»), ok }; fail(chat, n, code) — следующие n
// отправок этому человеку получат отказ.
const tg = [], fails = new Map(), slow = new Map(); // slow: chat → задержка ответа Bot API, мс (нажатие успевает раньше)
const fail = (chat, n, code, description = "Internal Server Error") => fails.set(chat, [...(fails.get(chat) || []), ...Array(n).fill({ code, description })]);
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url.startsWith("/tg/")) {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch { /* форма */ }
      const chat = Number(j.chat_id), f = (fails.get(chat) || []).shift();
      const buttons = (j.reply_markup?.inline_keyboard || []).map((row) => row.map((b) => `${b.text}=${b.callback_data ?? b.web_app?.url ?? b.url ?? ""}`).join(" | "));
      tg.push({ chat, text: String(j.text || ""), buttons, ok: !f });
      if (f?.code === "reset") return req.socket.destroy(); // обрыв после приёма: исход «unknown»
      if (slow.has(chat)) return setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: { message_id: tg.length } })); }, slow.get(chat));
      res.writeHead(f?.code || 200, { "content-type": "application/json" });
      return res.end(JSON.stringify(f ? { ok: false, error_code: f.code, description: f.description } : { ok: true, result: { message_id: tg.length } }));
    }
    res.writeHead(404); res.end("нет");
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
const attendance = await import(pathToFileURL(join(SIM, "attendance.mjs")).href);
const botCommands = await import(pathToFileURL(join(SIM, "bot-commands.mjs")).href);
const notify = await import(pathToFileURL(join(SIM, "notify.mjs")).href);
const admission = await import(pathToFileURL(join(SIM, "admission.mjs")).href);
const users = await import(pathToFileURL(join(SIM, "users.mjs")).href);

let fails_ = 0;
const check = (name, cond, extra = "") => { if (!cond) fails_++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (fn()) return true; return !!fn(); };
const msgs = (chat, re = /./) => tg.filter((m) => m.chat === chat && re.test(m.text));
const ASK = /^❓ Электронный журнал МИСИС/, ALERT = /^🎓 Электронный журнал МИСИС/, TOOWNER = /^🎓 Ответ о дисциплине журнала/;
const asked = async (id) => (await notify.peekState(id)).journalAsk || {};

// Курсы Moodle семестра — как на снимке владельца (часть); в журнале ещё «Теория информационных процессов и систем».
const D = { courses: [{ id: 1, name: "Методы оптимизации" }, { id: 2, name: "Моделирование информационных процессов и систем" }], pendingCourses: [] };
const TIPIS = "Теория информационных процессов и систем";
const subj = (id, name, works = []) => ({ id, name, attendance: 100, rating: null, thresholds: null, lessons: { past: 4, present: 4, absent: 0, unmarked: 0, missedHours: 0 }, absences: [], works, error: null });
const zero = (name) => ({ name, mark: 0, max: 5, failed: true });
const journalOf = ({ tipis = [], mo = [] } = {}) => ({ semester: "Осенний семестр 26–27 г.", subjects: [subj(101, TIPIS, tipis), subj(102, "Моделирование информационных процессов и систем"), subj(103, "Методы оптимизации", mo)] });
globalThis.__ej = new Map();
const setJournal = (id, o) => globalThis.__ej.set(id, journalOf(o));
const run = async (id, opts = {}) => { await sleep(5); return attendance.checkJournal(id, { app: "", deadlines: D, ...opts }); };

// 1. Первая проверка: о дисциплине без курса — вопрос с двумя кнопками; о дисциплинах с курсом — ничего.
setJournal(S, { tipis: [zero("ЛР 2")] });
await run(S);
const q1 = msgs(S, ASK);
check("первая проверка: один вопрос — о «Теории информационных процессов и систем», с кнопками «Да, моя» / «Нет, не моя»",
  q1.length === 1 && q1[0].text.includes(`«${TIPIS}»`) && q1[0].buttons.join() === "Да, моя=ejq:y:101 | Нет, не моя=ejq:n:101" && msgs(S, ALERT).length === 0, JSON.stringify(q1));
check("вопрос отмечен после доставки: ответа пока нет", (await asked(S))[101]?.answer === null && (await asked(S))[101]?.name === TIPIS && !(await asked(S))[102]);
await run(S);
check("вторая проверка — вопрос не повторяется", msgs(S, ASK).length === 1);

// 2. «Нет, не моя»: сообщение правится, владелец получает ответ; повтор нажатия владельцу второй раз не пишет.
const v1 = await botCommands.callback(S, "ejq:n:101");
check("«Нет, не моя» → правка: ответ внизу и одна кнопка «Всё-таки моя»", v1?.text?.includes("🚫 Ответ: не моя — уведомлений журнала по ней больше не будет.") && v1.buttons.flat().map((b) => b.callback_data).join() === "ejq:y:101", JSON.stringify(v1));
check("ответ записан", (await asked(S))[101]?.answer === "no" && !!(await asked(S))[101]?.answeredAt);
check("владельцу: кто (имя, @, ФИО, группа, id) и что ответил", await waitFor(() => msgs(OWNER, TOOWNER).length === 1)
  && /Студент · @student_stand · Студент Стенда · БИСТ-24-ПО-2 · id 7101/.test(msgs(OWNER, TOOWNER)[0]?.text) && msgs(OWNER, TOOWNER)[0].text.includes(`«${TIPIS}» — не моя`), JSON.stringify(msgs(OWNER)));
await botCommands.callback(S, "ejq:n:101");
await sleep(800);
check("повторное нажатие той же кнопки владельцу второй раз не пишет", msgs(OWNER, TOOWNER).length === 1);

// 3. «Не моя» — уведомлений журнала по ней нет; по остальным дисциплинам — как раньше.
setJournal(S, { tipis: [zero("ЛР 2"), zero("ЛР 3")], mo: [zero("КМ 1")] });
await run(S);
const a1 = msgs(S, ALERT);
check("ноль по «не моей» дисциплине не сообщается, ноль по «Методам оптимизации» — сообщается", a1.length === 1 && a1[0].text.includes("Методы оптимизации: «КМ 1» — 0 из 5") && !a1[0].text.includes(TIPIS), JSON.stringify(a1.map((m) => m.text)));

// 4. Передумал: «Всё-таки моя» — владельцу новый ответ; старое по дисциплине разом не приходит, новое — приходит.
const v2 = await botCommands.callback(S, "ejq:y:101");
check("«Всё-таки моя» → правка: «моя», где смотреть пропущенное, и кнопка «Всё-таки не моя»", v2?.text?.includes("✅ Ответ: моя") && v2.text.includes("вкладке «Журнал»") && v2.buttons.flat().map((b) => `${b.text}=${b.callback_data}`).join() === "Всё-таки не моя=ejq:n:101", JSON.stringify(v2));
check("владельцу — новый ответ «моя»", await waitFor(() => msgs(OWNER, TOOWNER).length === 2) && msgs(OWNER, TOOWNER)[1].text.includes(`«${TIPIS}» — моя`));
await run(S);
check("после «моя» прежние нули по ней разом не приходят (дисциплина снова только запомнена)", msgs(S, ALERT).length === 1);
setJournal(S, { tipis: [zero("ЛР 2"), zero("ЛР 3"), zero("ЛР 4")], mo: [zero("КМ 1")] });
await run(S);
check("новый ноль по ней — сообщается", msgs(S, ALERT).length === 2 && msgs(S, ALERT)[1].text.includes(`${TIPIS}: «ЛР 4» — 0 из 5`), JSON.stringify(msgs(S, ALERT).map((m) => m.text)));
const v999 = await botCommands.callback(S, "ejq:n:999");
await sleep(800);
check("кнопка с id, которого нет в журнале (прошлый семестр, поддельная), — «уже нет в журнале», без записи и без сообщения владельцу",
  v999?.text?.includes("уже нет в вашем электронном журнале") && v999.buttons.length === 0 && !(await asked(S))[999] && !msgs(OWNER).some((m) => m.text.includes("999")), JSON.stringify(v999));
check("чужие данные кнопки (не число, лишнее) — не наш вопрос", (await botCommands.callback(S, "ejq:y:10x")) === null && (await botCommands.callback(S, "ejq:maybe:101")) === null);

// 5. Временный сбой Telegram (500) — вопрос не отмечен и приходит в следующую проверку; 403 — отмечен, без повторов.
const T = 7102, X = 7105;
setJournal(T, {}); setJournal(X, {});
fail(T, 1, 500); fail(X, 1, 403, "Forbidden: bot was blocked by the user");
await run(T); await run(X);
check("500: вопрос не отмечен", !(await asked(T))[101]);
await run(T); await run(X);
check("500: следующая проверка присылает вопрос, дошёл ровно один", msgs(T, ASK).length === 2 && msgs(T, ASK).filter((m) => m.ok).length === 1 && (await asked(T))[101]?.answer === null);
check("403 (бот заблокирован): отмечен, второй попытки нет", msgs(X, ASK).length === 1 && !!(await asked(X))[101]);

// 6. /stop — вопрос не отправлен и не отмечен; включил сообщения — спросим.
const U = 7103;
setJournal(U, {});
await notify.setMuted(U, true);
await run(U);
check("/stop: ничего не ушло, вопрос не отмечен", msgs(U).length === 0 && !(await asked(U))[101]);
await notify.setMuted(U, false);
await run(U);
check("включил сообщения — вопрос пришёл", msgs(U, ASK).length === 1 && (await asked(U))[101]?.answer === null);

// 7. Уведомления журнала выключены в профиле, ночь, курсов ещё нет — не спрашиваем и не отмечаем.
const W = 7104;
setJournal(W, {});
await run(W, { mute: true });
await run(W, { night: true });
await run(W, { deadlines: null });
check("уведомления журнала выключены / ночь / курсов ещё нет — вопроса нет, отметки нет", msgs(W).length === 0 && !(await asked(W))[101]);
await run(W);
check("днём с курсами — вопрос пришёл", msgs(W, ASK).length === 1);

// 8. Уведомление не дошло (500) — вопросы в этом проходе не задаются, а приходят с повтором через ~15 минут.
const Y = 7106;
setJournal(Y, {});
await run(Y, { deadlines: null }); // первая проверка — только запомнить, без вопроса
setJournal(Y, { mo: [zero("КМ 1")] });
fail(Y, 1, 500);
await run(Y);
check("уведомление журнала при 500 не дошло — вопрос в этом проходе не задан", msgs(Y, ALERT).length === 1 && msgs(Y, ASK).length === 0);
await run(Y);
check("повтор: уведомление дошло, следом — вопрос", msgs(Y, ALERT).filter((m) => m.ok).length === 1 && msgs(Y, ASK).length === 1 && tg.filter((m) => m.chat === Y).at(-1).text.startsWith("❓"));

// 9. Журнал другого семестра — не спрашиваем (сравнивать осенние курсы с весенним журналом нельзя).
const Z = 7107;
globalThis.__ej.set(Z, { ...journalOf(), semester: "Весенний семестр 25–26 г." });
await run(Z);
check("весенний журнал с осенними курсами — вопроса нет", msgs(Z, ASK).length === 0);

// 10. Владелец сам отвечает о своей дисциплине — себе же сообщение «ответ студента» не шлём.
setJournal(OWNER, {});
await run(OWNER);
const before = msgs(OWNER, TOOWNER).length;
check("владельцу тоже задаётся вопрос о его дисциплине без курса", msgs(OWNER, ASK).length === 1);
await botCommands.callback(OWNER, "ejq:y:101");
await sleep(800);
check("ответ владельца себе не пересылается", msgs(OWNER, TOOWNER).length === before && (await asked(OWNER))[101]?.answer === "yes");

// 11. Нажатие раньше ответа Telegram: вопрос записан до отправки — ответ не теряется и не затирается.
const R = 7108;
setJournal(R, {});
slow.set(R, 600);
const pending = run(R);
await waitFor(() => msgs(R, ASK).length === 1, 2000);
const vr = await botCommands.callback(R, "ejq:n:101");
await pending;
slow.delete(R);
check("нажатие пришло раньше ответа Telegram на вопрос — ответ «не моя» записан и остался", vr?.text?.includes("🚫 Ответ: не моя") && (await asked(R))[101]?.answer === "no", JSON.stringify(vr));

// 12. Обрыв после приёма (неизвестно, дошло ли): вопрос считается заданным — без дублей, кнопки работают.
const Q = 7109;
setJournal(Q, {});
fail(Q, 1, "reset");
await run(Q);
await run(Q);
check("обрыв: вопрос записан, повторной отправки нет", msgs(Q, ASK).length === 1 && (await asked(Q))[101]?.answer === null);
check("обрыв: нажатие под (дошедшим) вопросом записывается", (await botCommands.callback(Q, "ejq:y:101"))?.text?.includes("✅ Ответ: моя") && (await asked(Q))[101]?.answer === "yes");

// 13. «Не моя» в /settings: строка «вернуть»; нажатие — уведомления по ней снова, владельцу — новый ответ.
const P = 7110;
setJournal(P, { tipis: [zero("ЛР 2")] });
await run(P);
await botCommands.callback(P, "ejq:n:101");
const sv = await botCommands.callback(P, "set:news:1");
const rows = (sv?.buttons || []).flat();
check("/settings: «не моя» дисциплина — строкой «↩️ …» с кнопкой ejs:<id> и пояснением", rows.some((b) => b.callback_data === "ejs:101" && b.text.startsWith("↩️ Теория информационных")) && /отмеченные как не ваши/.test(sv.text), JSON.stringify(rows));
const sv2 = await botCommands.callback(P, "ejs:101");
check("«↩️» в /settings → ответ «моя», строка исчезла, вид настроек обновлён", (await asked(P))[101]?.answer === "yes" && !(sv2?.buttons || []).flat().some((b) => b.callback_data === "ejs:101") && /Уведомления бота/.test(sv2?.text || ""));
check("…владельцу — итог «моя» одним сообщением (нет → да подряд)", await waitFor(() => msgs(OWNER, TOOWNER).some((m) => m.text.includes("id 7110"))) && (await sleep(800), msgs(OWNER, TOOWNER).filter((m) => m.text.includes("id 7110")).length === 1 && msgs(OWNER, TOOWNER).find((m) => m.text.includes("id 7110")).text.includes("— моя")));

// 14. Курс появился в Moodle после «не моя» — «не моя» снимается, студенту одна строка; старое разом не приходит.
// Курс прошлого семестра, о котором студента ещё спрашивают (pendingCourses), «не моя» не снимает: он временный.
await botCommands.callback(P, "ejq:n:101");
const NOTE = /теперь есть курс — снова присылаю/;
await run(P, { deadlines: { courses: D.courses, pendingCourses: [{ id: 77, name: TIPIS }] } });
check("курс ТИПиС только среди курсов прошлых семестров (ждут ответа) — «не моя» не снимается", (await asked(P))[101]?.answer === "no" && msgs(P, NOTE).length === 0);
await run(P, { deadlines: { courses: [...D.courses, { id: 3, name: TIPIS }], pendingCourses: [] }, mute: true });
check("уведомления журнала выключены — «не моя» не снимается (сказать «снова присылаю» нельзя)", (await asked(P))[101]?.answer === "no" && msgs(P, NOTE).length === 0);
const D2 = { courses: [...D.courses, { id: 3, name: TIPIS }], pendingCourses: [] };
await run(P, { deadlines: D2 });
check("курс появился среди курсов семестра: «не моя» снята, студенту — «…теперь есть курс — снова присылаю…»", !(await asked(P))[101] && msgs(P, NOTE).length === 1 && msgs(P, NOTE)[0].text.includes(`«${TIPIS}»`) && !msgs(P, ALERT).some((m) => m.text.includes("Оценка ниже порога")), JSON.stringify(msgs(P).map((m) => m.text.slice(0, 60))));
await run(P, { deadlines: D2 });
check("…и больше вопрос о ней не задаётся (курс есть)", msgs(P, ASK).length === 1);

// 15. Начало семестра: в Moodle только «ESP 2026» — вопросов нет (иначе о каждой дисциплине).
const O = 7111;
setJournal(O, {});
await run(O, { deadlines: { courses: [{ id: 9, name: "ESP 2026" }], pendingCourses: [] } });
check("Moodle ещё не заполнен (без курса больше половины) — ни одного вопроса", msgs(O).length === 0 && !Object.keys(await asked(O)).length);

// 16. Сообщение владельцу не дошло (500) — повтор со следующей проверкой журнала.
const N = 7112;
setJournal(N, {});
await run(N);
fail(OWNER, 1, 500);
await botCommands.callback(N, "ejq:n:101");
await waitFor(() => tg.some((m) => m.chat === OWNER && !m.ok && m.text.includes("id 7112")));
await sleep(200);
check("владельцу при 500 не дошло — отметки «сообщено» нет", (await asked(N))[101]?.told === undefined);
await run(N);
check("следующая проверка журнала досылает ответ владельцу", await waitFor(() => msgs(OWNER, TOOWNER).some((m) => m.ok && m.text.includes("id 7112"))) && (await sleep(300), (await asked(N))[101]?.told === "no"));

// 17. Быстро «нет → да → нет» — владельцу одно сообщение с итогом.
const M = 7113;
setJournal(M, {});
await run(M);
for (const a of ["n", "y", "n"]) await botCommands.callback(M, `ejq:${a}:101`);
await waitFor(() => msgs(OWNER, TOOWNER).some((m) => m.text.includes("id 7113")));
await sleep(800);
check("«нет → да → нет» подряд — владельцу одно сообщение, с итогом «не моя»", msgs(OWNER, TOOWNER).filter((m) => m.text.includes("id 7113")).length === 1 && msgs(OWNER, TOOWNER).find((m) => m.text.includes("id 7113")).text.includes("— не моя"));

// 18. Строка «курс появился» не дошла (500) — «не моя» возвращается, следующая проверка снимает и пишет снова.
const L = 7114;
setJournal(L, {});
await run(L);
await botCommands.callback(L, "ejq:n:101");
fail(L, 1, 500);
await run(L, { deadlines: D2 });
check("строка «курс появился» не дошла — «не моя» вернулась", (await asked(L))[101]?.answer === "no" && msgs(L, NOTE).filter((m) => m.ok).length === 0);
await run(L, { deadlines: D2 });
check("…следующая проверка: строка дошла, «не моя» снята", msgs(L, NOTE).filter((m) => m.ok).length === 1 && !(await asked(L))[101]);

// 19. Состояние восстановлено из копии (записи о вопросе нет), дисциплина в журнале есть — ответ записан с названием.
const K = 7115;
setJournal(K, {});
await run(K);
await notify.withState(K, (s) => { delete s.journalAsk[101]; });
const vk = await botCommands.callback(K, "ejq:n:101");
check("записи нет, дисциплина в журнале есть — ответ записан, название из журнала, правка с ответом", vk?.text?.includes(`«${TIPIS}»`) && vk.text.includes("🚫 Ответ: не моя") && (await asked(K))[101]?.name === TIPIS, JSON.stringify(vk));
check("…владельцу — ответ с названием", await waitFor(() => msgs(OWNER, TOOWNER).some((m) => m.text.includes("id 7115") && m.text.includes(`«${TIPIS}» — не моя`))));

// 20. После перезапуска (последнего журнала в памяти нет) кнопка с чужим id: запись без названия, владельцу ничего;
// проверка журнала такую запись убирает (дисциплины в журнале нет).
const J2 = 7116;
setJournal(J2, {});
const vj = await botCommands.callback(J2, "ejq:n:998");
await sleep(800);
check("без журнала в памяти — ответ записан без названия, владельцу не сообщается", vj?.text?.includes("🚫 Ответ: не моя") && (await asked(J2))[998]?.name === null && !msgs(OWNER).some((m) => m.text.includes("id 7116")));
await run(J2);
await sleep(800);
check("…проверка журнала её убирает, владельцу так ничего и не пришло", !(await asked(J2))[998] && !msgs(OWNER).some((m) => m.text.includes("id 7116")));

// 21. Новый семестр (у журналов новые id): старые записи убираются, в /settings их нет, старая кнопка ничего не меняет.
const I = 7117;
setJournal(I, {});
await run(I);
await botCommands.callback(I, "ejq:n:101");
await waitFor(() => msgs(OWNER, TOOWNER).some((m) => m.text.includes("id 7117")));
await sleep(300);
globalThis.__ej.set(I, { semester: "Осенний семестр 26–27 г.", subjects: [subj(201, TIPIS), subj(202, "Моделирование информационных процессов и систем"), subj(203, "Методы оптимизации")] });
await run(I);
const svI = await botCommands.callback(I, "set:news:1");
check("новый семестр: запись о прошлом id убрана (владельцу ответ уже ушёл), в /settings строки нет, о новом id — новый вопрос",
  !(await asked(I))[101] && !(svI?.buttons || []).flat().some((b) => String(b.callback_data).startsWith("ejs:")) && msgs(I, ASK).length === 2 && (await asked(I))[201]?.answer === null, JSON.stringify(await asked(I)));
const vOld = await botCommands.callback(I, "ejq:y:101");
await sleep(800);
check("старая кнопка прошлого семестра — «уже нет в журнале», владельцу ничего", vOld?.text?.includes("уже нет") && msgs(OWNER, TOOWNER).filter((m) => m.text.includes("id 7117")).length === 1);

// ---------- «не моя» в боте и «Не моё» в «Сессии» — одно (16 окт 2026, позже) ----------
// Плана группы у стенда нет (поддельный misis.ru) — «Сессия» строится по журналу, ключи — «s::<название>»; пару ключа и
// дисциплины журнала берём так же, как сервер (admission.journalPairs).
const keyOf = async (id, ejId = 101) => (await admission.journalPairs(id, globalThis.__ej.get(id))).find((p) => p.ejId === ejId)?.key;
const hiddenOf = async (id) => (await users.sessionChoices(id)).hidden;
const ownerAbout = (id) => msgs(OWNER, TOOWNER).filter((m) => m.text.includes(`id ${id}`));

// 22. Скрыта в «Сессии» до вопроса: бот не спрашивает, уведомлений по ней нет; «Журнал» и /journal — отдельно, средние
// без неё; «Вернуть» в /journal снимает отметку «Сессии», в боте записи не появляется, владельцу — ничего.
const H = 7118;
globalThis.__ej.set(H, { semester: "Осенний семестр 26–27 г.", subjects: [
  { ...subj(101, TIPIS, [zero("ЛР 2")]), attendance: 50, lessons: { past: 4, present: 2, absent: 2, unmarked: 0, missedHours: 4 }, absences: [{ date: "2026-10-01", kind: "Лекция", n: 1 }, { date: "2026-10-08", kind: "Лекция", n: 2 }] },
  subj(102, "Моделирование информационных процессов и систем"), subj(103, "Методы оптимизации")] });
const kH = await keyOf(H);
await users.setSessionChoice(H, "hidden", kH, true);
await run(H);
check("скрытую в «Сессии» дисциплину бот не спрашивает", !!kH && msgs(H, ASK).length === 0 && !(await asked(H))[101], `${kH} ${JSON.stringify(await asked(H))}`);
globalThis.__ej.get(H).subjects[0].works.push(zero("ЛР 3"));
globalThis.__ej.get(H).subjects[2].works.push(zero("КМ 1"));
await run(H);
check("…и не сообщает о ней (ноль по ней — молча), по остальным — как раньше", msgs(H, ALERT).length === 1 && msgs(H, ALERT)[0].text.includes("Методы оптимизации") && !msgs(H, ALERT)[0].text.includes(TIPIS), JSON.stringify(msgs(H, ALERT).map((m) => m.text)));
const vH = await admission.journalView(H, globalThis.__ejLast.get(H));
check("вкладка «Журнал» (journalView): не своя — отдельно (from session), средние и пропуски без неё; кэш журнала не тронут",
  vH.data.subjects.map((s) => s.id).join() === "102,103" && vH.data.notMine.map((s) => `${s.id}:${s.from}`).join() === "101:session" && vH.data.summary.attendance === 100 && vH.data.summary.absences === 0
  && globalThis.__ejLast.get(H).subjects.length === 3 && vH.off.get("101") === "session", JSON.stringify({ s: vH.data.summary, n: vH.data.notMine?.map((s) => s.id) }));
const jH = await botCommands.answer(H, "journal");
check("/journal: не своя — не в списке, строкой «Вы отметили как не ваши» с кнопкой «↩️» (ejj:<id>)",
  /🚫 Вы отметили как не ваши/.test(jH?.text || "") && (jH?.buttons || []).flat().map((b) => b.callback_data).join() === "ejj:101" && !/🔴|🟡/.test(jH.text) && /посещаемость 100 %/.test(jH.text), (jH?.text || "").replace(/\n/g, " ⏎ "));
// Короткий /journal для беседы (эфемерный ответ, 16 окт 2026): HTML-заголовок со средними, строки «🟢 Название — %»,
// не своя — одной строкой «🚫 Не ваши: 1», без кнопок-нажатий.
const cH = await botCommands.compact(H, "journal");
check("/journal коротко (для беседы): заголовок со средними, дисциплины одной строкой, не своя — «🚫 Не ваши: 1 … в личке»",
  /^<b>🔒 Ваш журнал<\/b> · посещаемость 100 %, рейтинг /.test(cH?.text || "") && /\n🟢 Моделирование информацион[^\n]*… — 100 % · /.test(cH.text)
  && /🚫 Не ваши: 1 — вернуть можно в личке \(\/journal\)$/.test(cH.text) && !cH.text.includes(TIPIS) && !cH.buttons && cH.more === "Весь журнал — в личке", (cH?.text || "").replace(/\n/g, " ⏎ "));
const sH = await botCommands.callback(H, "set:news:1");
check("/settings: скрытая в «Сессии» — тоже строкой «↩️» (ejs:<id>)", (sH?.buttons || []).flat().some((b) => b.callback_data === "ejs:101"), JSON.stringify(sH?.buttons));
const bH = await botCommands.callback(H, "ejj:101");
await sleep(800);
check("«↩️» в /journal: отметка «Сессии» снята, в боте записи нет, владельцу ничего; сообщение правится — кнопок не осталось",
  !Object.keys(await hiddenOf(H)).length && !(await asked(H))[101] && !ownerAbout(H).length && (bH?.buttons || []).length === 0 && /📊 Журнал/.test(bH?.text || "") && !/Вы отметили/.test(bH?.text || ""), JSON.stringify(bH));

// 23. «Не моя» в боте — в «Сессии» скрыта (from bot); «Вернуть» там (admission.choose) снимает и ответ бота.
const G = 7119;
setJournal(G, {});
await run(G);
await botCommands.callback(G, "ejq:n:101");
const oG = await admission.overview(G);
check("«Сессия»: «не моя» в боте — дисциплина в скрытых (from bot), не в списке", oG.hidden?.some((h) => h.name === TIPIS && h.from === "bot") && !oG.subjects.some((s) => s.name === TIPIS), JSON.stringify({ h: oG.hidden, g: oG.needGroup, p: oG.planError }));
await admission.choose(G, "hidden", oG.hidden.find((h) => h.name === TIPIS)?.key, null);
const oG2 = await admission.overview(G);
check("«Вернуть» в «Сессии»: в боте — «моя», дисциплина снова в списке; владельцу — итог «моя»",
  (await asked(G))[101]?.answer === "yes" && oG2.subjects.some((s) => s.name === TIPIS) && !oG2.hidden.length
  && await waitFor(() => ownerAbout(G).length === 1 && ownerAbout(G)[0].text.includes("— моя")), JSON.stringify({ a: await asked(G), o: ownerAbout(G).map((m) => m.text) }));

// 24. Последнее слово: «Не моё» в «Сессии» после «моя» в боте — не своя; «Всё-таки моя» в боте после — снова своя.
const F = 7120;
setJournal(F, {});
await run(F);
await botCommands.callback(F, "ejq:y:101");
await sleep(5);
await users.setSessionChoice(F, "hidden", await keyOf(F), true);
const off1 = (await admission.journalView(F, globalThis.__ejLast.get(F))).off;
await sleep(5);
await botCommands.callback(F, "ejq:y:101");
const off2 = (await admission.journalView(F, globalThis.__ejLast.get(F))).off;
check("«Не моё» в «Сессии» после «моя» в боте — не своя; повторное «моя» в боте после — снова своя", off1.get("101") === "session" && !off2.size, JSON.stringify({ off1: [...off1], off2: [...off2] }));
// Обе отметки сразу («не моя» в боте и «Не моё» в «Сессии») — «↩️» в /settings снимает обе.
await users.setSessionChoice(F, "hidden", await keyOf(F), true);
await botCommands.callback(F, "ejq:n:101");
await botCommands.callback(F, "ejs:101");
check("обе отметки — «↩️» в /settings снимает обе: в боте «моя», в «Сессии» отметки нет", (await asked(F))[101]?.answer === "yes" && !Object.keys(await hiddenOf(F)).length && !(await admission.journalView(F, globalThis.__ejLast.get(F))).off.size);

// 25. Курс появился в Moodle, но в «Сессии» дисциплина скрыта самим студентом — «не моя» не снимается, строки нет.
const E = 7121;
setJournal(E, {});
await run(E);
await botCommands.callback(E, "ejq:n:101");
await users.setSessionChoice(E, "hidden", await keyOf(E), true);
await run(E, { deadlines: D2 });
check("курс появился, но в «Сессии» скрыта — «не моя» остаётся, «снова присылаю» не пишем", (await asked(E))[101]?.answer === "no" && msgs(E, NOTE).length === 0);

fake.close();
rmSync(root, { recursive: true, force: true });
console.log(fails_ ? `ИТОГ: провалено ${fails_}` : "ИТОГ: всё прошло");
process.exit(fails_ ? 1 : 0);
