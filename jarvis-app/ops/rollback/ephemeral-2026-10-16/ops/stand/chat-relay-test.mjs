// Проверка уведомлений по курсам в беседах (chats.mjs, этап 2, 16 окт 2026) без сети и без живых файлов: копия chats.mjs
// и state-file.mjs во временной папке, вместо остальных модулей — заглушки (notify, users, moodle, session, schedule,
// official, admission, bot-commands). Часы подменены (Date.now) — время задаётся явно, по Москве (UTC+3).
// Что проверяется:
//   a. бота добавил вошедший в Doodle — он источник, беседа привязана к группе из профиля, в беседе — справка и «включены»,
//      ему в личку — что сведения о курсах используются, а личные данные нет; кнопки в беседе — только ссылки (без web_app);
//   b. добавил не вошедший — источника нет, подсказка про /notify on;
//   c. пересылка (notify.relay): одно сообщение с кнопкой в Moodle и ссылкой на личку; тот же ключ — без повтора; ключ с ttl —
//      снова после ttl; несколько разом — каждое по разу;
//   d. напоминания за сутки: по сроку, даже если работа сдана; 30 ч — рано; без повтора; срок 23:59 — в 22:00 накануне,
//      срок 03:00 — в 8:00 накануне; «Новый тест … осталось N ч» (covers) заменяет напоминание; ночью — не будим;
//   e. сбои отправки: 500 — в очереди, повтор каждым обходом, после 6 попыток — всё; беседа стала супергруппой — запись
//      переехала, без повтора;
//   f. /notify и /group: выключить может админ или источник; включить — админ, вошедший в Doodle; /group off и /group <имя>
//      источник и отметки не теряют;
//   g. экзамены группы беседы: объявление с кнопкой «Файл на misis.ru», накануне в 18–22, в день — утром до начала;
//   i. только общее: курс не текущего семестра (включён вручную — долг) и «пересдача» — не в беседу; личное продление
//      срока источника — не в беседу, напоминание — по сроку большинства;
//   j. источник вышел из беседы, из Doodle, отключил кнопкой в личке — уведомления выключены, беседе сказано;
//   k. ночью очередь ждёт утра, срочное («тест открыт») уходит сразу; «неизвестно, дошло ли» — один повтор.
// Обновлено после независимой проверки 16 окт 2026 (повторы с паузой, общие курсы, общий срок, выход источника).
// Запуск (из jarvis-app): node ops\stand\chat-relay-test.mjs
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const APP = fileURLToPath(new URL("../../", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "chat-relay-test-"));
for (const f of ["chats.mjs", "state-file.mjs"]) copyFileSync(join(APP, f), join(TMP, f));

// --- заглушки ---
// Общее состояние заглушек — отдельным модулем: его видят и заглушки, и тест.
writeFileSync(join(TMP, "st.mjs"), `
export const st = {
  calls: [],            // вызовы Bot API: { method, body, at }
  dms: [],              // notify.deliver: { tgId, text, buttons, opts, at }
  sendHook: null,       // (body) => ответ Telegram вместо «ok» (сбой, migrate_to_chat_id) или null
  admins: new Set(),    // кто админ в любой беседе (getChatMember)
  tokens: new Map(),    // tgId → токен Moodle (вошёл в Doodle)
  profiles: new Map(),  // tgId → { group }
  deadlines: new Map(), // токен → { items, courses } (moodle.staleDeadlines)
  files: [], exams: new Map(), // session.files(), session.examsFor(группа)
  groups: ["БИСТ-24-ПО-2", "БИСТ-24-ПО-1", "ГР-24-ПО-1"],
  scheduleCalls: [],    // группы, для которых спрашивали расписание
  relay: null, isSource: null, // что chats.mjs передал в notify.setRelay
  unseen: new Set(),    // работы, о которых источнику ещё не сообщено «Новое …» (notify seen)
};
`);
writeFileSync(join(TMP, "notify.mjs"), `
import { st } from "./st.mjs";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MSK = 3 * 3600e3, pad = (n) => String(n).padStart(2, "0");
export async function tg(method, body = {}) {
  const rec = { method, body: JSON.parse(JSON.stringify(body)), at: Date.now() };
  st.calls.push(rec);
  if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true, username: "DoodleTestBot" } };
  if (method === "getChatMember") return { ok: true, result: { status: st.admins.has(body.user_id) ? "administrator" : "member" } };
  if (method === "sendMessage") {
    const r = st.sendHook?.(body) || { ok: true, result: { message_id: st.calls.length, chat: { id: body.chat_id } } };
    rec.ok = !!r.ok;
    return r;
  }
  return { ok: true, result: true };
}
export async function deliver(tgId, text, media, buttons, opts) { st.dms.push({ tgId, text, buttons, opts, at: Date.now() }); return { status: "sent", ok: true }; }
export function setRelay(fn, isSource) { st.relay = fn; st.isSource = isSource; }
// Как notify.resultOf: ok → sent; сеть без кода «точно не ушло» → unknown; 429 → limited; 403 → unreachable; 4xx → rejected; 5xx → failed.
export const resultOf = (r) => {
  const status = r.ok ? "sent" : r.network ? (r.code === "ECONNREFUSED" ? "failed" : "unknown") : r.error_code === 429 ? "limited" : r.error_code === 403 ? "unreachable" : r.error_code >= 400 && r.error_code < 500 ? "rejected" : "failed";
  return { status, ok: status === "sent", retryable: ["limited", "failed", "unknown"].includes(status), description: String(r.description || ""), retryAfter: Number(r.parameters?.retry_after) || 0 };
};
// Что источник уже видел (notify seen): по умолчанию — все работы его дедлайнов, кроме st.unseen.
export async function peekState(tgId) {
  const tok = st.tokens.get(Number(tgId));
  return { seen: (st.deadlines.get(tok)?.items || []).map((x) => x.id).filter((id) => !st.unseen.has(id)) };
}
export function scheduleDiff(prev, lessons, group, subgroup) { return { snapshot: { group, subgroup, days: {} }, count: 0, text: "" }; }
const p = (ms) => new Date(ms + MSK);
export const mskDay = (ms) => p(ms).toISOString().slice(0, 10);
export const effectiveDue = (ms) => (p(ms).getUTCHours() === 0 && p(ms).getUTCMinutes() === 0 ? ms - 60e3 : ms);
export const fmtTime = (ms) => { const d = p(ms); return \`\${d.getUTCDate()} \${MONTHS[d.getUTCMonth()]}, \${pad(d.getUTCHours())}:\${pad(d.getUTCMinutes())}\`; };
export const hashOf = (s) => { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); };
`);
writeFileSync(join(TMP, "users.mjs"), `
import { st } from "./st.mjs";
export async function moodleToken(tgId) { return st.tokens.get(Number(tgId)) ?? null; }
export async function profile(tgId) { return st.profiles.get(Number(tgId)) ?? { group: null }; }
export async function allLoggedIn() { return [...st.tokens].map(([tgId, token]) => ({ tgId, token })); }
`);
writeFileSync(join(TMP, "moodle.mjs"), `
import { st } from "./st.mjs";
export const staleDeadlines = (token) => st.deadlines.get(token) ?? null;
`);
writeFileSync(join(TMP, "session.mjs"), `
import { st } from "./st.mjs";
export async function files() { return st.files; }
export async function examsFor(group) { return st.exams.get(group) ?? null; }
`);
writeFileSync(join(TMP, "schedule.mjs"), `
import { st } from "./st.mjs";
export async function groupList() { return st.groups; }
export async function schedule(group) { st.scheduleCalls.push(group); return { group, lessons: [] }; }
`);
writeFileSync(join(TMP, "official.mjs"), `
const LAT = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
export const normGroup = (g) => String(g || "").toUpperCase().replace(/\\s+/g, "").replace(/[ABCEHKMOPTXY]/g, (ch) => LAT[ch]);
`);
writeFileSync(join(TMP, "bot-commands.mjs"), `
export const scheduleText = async (kind) => (kind === "week" ? "🗓 Неделя\\nпар нет" : "📅 Сегодня\\nпар нет");
`);
// admission: настоящие чистые функции dayText и lateAnnounce — вырезаны из admission.mjs (чтобы не расходились с ним).
{
  const src = readFileSync(join(APP, "admission.mjs"), "utf8");
  const grab = (re) => { const m = re.exec(src); if (!m) throw new Error(`admission.mjs: не нашёл ${re}`); return m[0]; };
  writeFileSync(join(TMP, "admission.mjs"), [
    'import { normGroup } from "./official.mjs";',
    grab(/^const MONTHS = .*$/m), grab(/^const MONTHS_G = .*$/m), grab(/^export const dayText = .*$/m),
    grab(/^export function lateAnnounce\([\s\S]*?\n}\n/m),
  ].join("\n"));
}

// --- часы ---
let clock = Date.parse("2026-11-02T12:00+03:00");
Date.now = () => clock;
/** Московское время «2026-11-02T12:00» → мс; заодно переводит часы. */
const at = (iso) => (clock = Date.parse(`${iso}+03:00`));
const HOUR = 3600e3, MIN = 60e3;

const chats = await import(pathToFileURL(join(TMP, "chats.mjs")).href);
const { st } = await import(pathToFileURL(join(TMP, "st.mjs")).href);

// --- помощники ---
const FILE = join(TMP, "chats.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = () => { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; } };
/** Дождаться, пока фоновые flush/prime закончат: вызовы и файл бесед перестали меняться. */
async function settle() {
  let last = "", same = 0;
  for (let i = 0; i < 300 && same < 4; i++) {
    await sleep(15);
    const s = existsSync(FILE) ? statSync(FILE) : null;
    const cur = `${st.calls.length}|${st.dms.length}|${s ? `${s.mtimeMs}:${s.size}` : "-"}`;
    if (cur === last) same++; else { same = 0; last = cur; }
  }
}
const sends = (chatId) => st.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
const okSends = (chatId) => sends(chatId).filter((c) => c.ok);
const btns = (c) => (c?.body.reply_markup?.inline_keyboard || []).flat();
const textOf = (c) => String(c?.body.text || "");
const oneLine = (s) => String(s || "").replace(/\n/g, " ⏎ ").slice(0, 220);
const tick = async (iso) => { const n = await chats.relayTick(at(iso)); await settle(); return n; };
let mid = 0;
async function say(chat, from, text, firstName = "Студент") {
  const before = sends(chat.id).length;
  await chats.onMessage({ message_id: ++mid, date: Math.floor(clock / 1000), chat, from: { id: from, is_bot: false, first_name: firstName }, text });
  await settle();
  return sends(chat.id).slice(before).at(-1) || null;
}

// Люди: SRC — вошёл в Doodle (обычный участник беседы), OUT — не вошёл, ADM — админ, вошёл; ADM2 — админ, не вошёл;
// MEM — участник, не вошёл; NOGRP — вошёл, группы в профиле нет.
const SRC = 1001, OUT = 2002, ADM = 3003, ADM2 = 4004, MEM = 5005, NOGRP = 6006;
st.tokens.set(SRC, "tok-1001").set(ADM, "tok-3003").set(NOGRP, "tok-6006");
st.profiles.set(SRC, { group: "БИСТ-24-ПО-2" }).set(ADM, { group: "ГР-24-ПО-1" }).set(NOGRP, { group: null });
st.admins.add(ADM).add(ADM2);
const A = -1001, A2 = -1001001, B = -1002, C = -1003, D = -1004;
const chatA = { id: A, type: "group", title: "Беседа А" }, chatB = { id: B, type: "supergroup", title: "Беседа Б" }, chatC = { id: C, type: "supergroup", title: "Беседа В" };
const added = (chat, from) => chats.onMember({ chat, from, date: Math.floor(clock / 1000), old_chat_member: { status: "left", user: { id: 1, is_bot: true } }, new_chat_member: { status: "member", user: { id: 1, is_bot: true } } });
const DM_USED = /Сведения о ваших курсах Moodle (текущего семестра )?используются для общих уведомлений/;
// Курсы источника: Матан — текущего семестра (auto), ОС — прошлый, включён вручную (долг), «Пересдачи» — по названию.
const COURSES = [{ id: 5, short: "Матан", name: "Математический анализ", auto: true }, { id: 6, short: "ОС", name: "Операционные системы", auto: false }, { id: 7, short: "Пересдачи ИЯ", name: "Пересдачи Иностранный язык", auto: true }];
const dl = (items) => ({ courses: COURSES, items });
st.deadlines.set("tok-1001", dl([]));
const DM_PERSONAL = /личные данные[^\n]*не используются/;

try {
  // ---------------- a. бота добавил вошедший в Doodle ----------------
  {
    at("2026-11-02T12:00");
    await added(chatA, { id: SRC, is_bot: false, first_name: "Аня" });
    await settle();
    const r = rec()[A];
    check("a: бота добавил вошедший в Doodle — он источник; беседа без группы привязана к группе из его профиля",
      r?.source === SRC && r.group === "БИСТ-24-ПО-2" && r.subgroup === null, JSON.stringify(r));
    const hello = sends(A);
    check("a: в беседе одно сообщение — справка, «Уведомления по курсам Moodle включены» и строка о привязке к группе",
      hello.length === 1 && /^Я бот Doodle/.test(textOf(hello[0])) && /🔔 Уведомления по курсам Moodle включены/.test(textOf(hello[0]))
      && /Аня/.test(textOf(hello[0])) && /Беседа привязана к группе БИСТ-24-ПО-2 \(из профиля в Doodle\)/.test(textOf(hello[0])), `${hello.length}: ${oneLine(textOf(hello[0]))}`);
    const dm = st.dms.filter((d) => d.tgId === SRC);
    check("a: источнику в личку одно сообщение: курсы используются для общих уведомлений, личные данные — нет",
      dm.length === 1 && st.dms.length === 1 && /«Беседа А»/.test(dm[0].text) && DM_USED.test(dm[0].text) && DM_PERSONAL.test(dm[0].text) && /оценки/.test(dm[0].text), oneLine(dm[0]?.text));
    check("a: сообщение источнику уходит и после /stop (force); под ним кнопка «Отключить мои курсы от беседы» (chatoff:<беседа>)",
      dm[0]?.opts?.force === true && dm[0]?.buttons?.[0]?.[0]?.callback_data === `chatoff:${A}`, JSON.stringify([dm[0]?.opts, dm[0]?.buttons]));
    const b = btns(hello[0]);
    check("a: кнопки в беседе — только ссылки (t.me), без web_app", b.length > 0 && b.every((x) => x.url && !x.web_app && /^https:\/\/t\.me\/DoodleTestBot$/.test(x.url)), JSON.stringify(b));
  }

  // ---------------- b. добавил не вошедший в Doodle ----------------
  {
    const dms0 = st.dms.length;
    await added(chatB, { id: OUT, is_bot: false, first_name: "Олег" });
    await settle();
    const m = sends(B);
    check("b: добавил не вошедший в Doodle — источника нет, в личку ничего, в беседе подсказка про /notify on",
      rec()[B]?.source == null && st.dms.length === dms0 && m.length === 1 && /админ беседы, вошедший в Doodle, пишет \/notify on/.test(textOf(m[0])) && !/Уведомления по курсам Moodle включены/.test(textOf(m[0])),
      `${JSON.stringify(rec()[B] || null)} | ${oneLine(textOf(m[0]))}`);
    const dms1 = st.dms.length;
    await added({ id: -1009, type: "group", title: "Ботоводы" }, { id: 9009, is_bot: true, first_name: "Другой бот" });
    await settle();
    check("b: добавил бот — источника нет", rec()[-1009]?.source == null && st.dms.length === dms1, JSON.stringify(rec()[-1009] || null));
  }

  // ---------------- c. пересылка общих сообщений источника ----------------
  {
    at("2026-11-02T12:00");
    check("c: chats.mjs передал notify обработчик пересылки и проверку «источник ли»", typeof st.relay === "function" && typeof st.isSource === "function");
    check("c: isSource — да у источника, нет у остальных", (await st.isSource(SRC)) === true && (await st.isSource(OUT)) === false && (await st.isSource(ADM)) === false);
    const n0 = sends(A).length, b0 = sends(B).length;
    const quiz = { key: "new:moodle:quiz:77", text: "🆕 Новый тест: Тест 1\nМатан · открыт с 2 ноя, 11:00, до 5 ноя, 23:59", x: { id: "moodle:quiz:77", kind: "test", courseId: 5, url: "https://m.test/mod/quiz/view.php?id=770" } };
    await st.relay(SRC, quiz);
    await settle();
    const m = sends(A).slice(n0), b = btns(m[0]);
    check("c: новый тест — одно сообщение в беседу тем же текстом; кнопки: «Открыть тест в Moodle» и «Открыть Doodle в личке» (t.me)",
      m.length === 1 && textOf(m[0]) === quiz.text && b.length === 2 && b[0].text === "Открыть тест в Moodle" && b[0].url === quiz.x.url
      && b[1].text === "Открыть Doodle в личке" && b[1].url === "https://t.me/DoodleTestBot" && b.every((x) => !x.web_app), `${m.length}: ${JSON.stringify(b)}`);
    check("c: беседа без источника ничего не получила", sends(B).length === b0);
    await st.relay(SRC, quiz);
    await settle();
    check("c: тот же ключ ещё раз (повтор у источника) — без второго сообщения", sends(A).length === n0 + 1, `${sends(A).length - n0}`);
    const mat = { key: "mat:5:abc", text: "📎 Новые материалы: Матан\n• Лекция 5", url: "https://m.test/course/view.php?id=5", ttl: 12 * HOUR, courseIds: [5] };
    await st.relay(SRC, mat); await settle();
    const k1 = sends(A).length;
    await st.relay(SRC, mat); await settle();
    const k2 = sends(A).length;
    at("2026-11-03T08:01"); // не ночью: ночью несрочное ждёт утра (k)
    await st.relay(SRC, mat); await settle();
    const k3 = sends(A).length;
    check("c: материал с ttl 12 ч — сразу второй раз нет, после 12 ч — снова; кнопка «Открыть в Moodle»",
      k1 === n0 + 2 && k2 === k1 && k3 === k1 + 1 && btns(sends(A)[k1 - 1])[0]?.text === "Открыть в Moodle", `${k1 - n0}/${k2 - n0}/${k3 - n0}`);
    const other = sends(A).length + sends(B).length;
    await st.relay(OUT, { key: "new:moodle:assign:5", text: "🆕 Новое задание: чужое", x: { id: "moodle:assign:5", kind: "assign", courseId: 5 } }); await settle();
    check("c: сообщение не источника никуда не пересылается", sends(A).length + sends(B).length === other);
    const k4 = sends(A).length;
    await Promise.all([1, 2, 3].map((i) => st.relay(SRC, { key: `new:moodle:assign:9${i}`, text: `🆕 Новое задание: Пачка ${i}`, x: { id: `moodle:assign:9${i}`, kind: "assign", courseId: 5, url: `https://m.test/a/${i}` } })));
    await settle();
    const pack = sends(A).slice(k4).map(textOf);
    check("c: три сообщения разом — каждое ровно по разу, по порядку", pack.length === 3 && pack.every((t, i) => t === `🆕 Новое задание: Пачка ${i + 1}`), pack.join(" | "));
  }

  // ---------------- d. напоминания за сутки ----------------
  {
    const T0 = at("2026-11-03T12:00");
    const url = (n) => `https://m.test/mod/assign/view.php?id=${n}`;
    st.deadlines.set("tok-1001", { courses: COURSES, items: [
      { id: "moodle:assign:11", kind: "assign", title: "ДЗ 1", courseId: 5, due: T0 + 20 * HOUR, status: "done", url: url(11) },
      { id: "moodle:assign:12", kind: "assign", title: "ДЗ 2", courseId: 5, due: T0 + 30 * HOUR, status: "open", url: url(12) },
      { id: "manual:1", kind: "assign", title: "Своё дело", courseId: null, due: T0 + 5 * HOUR, status: "open" },
    ] });
    const r0 = sends(A).length;
    await tick("2026-11-03T12:00");
    const rem = () => sends(A).slice(r0).filter((c) => /^⏰/.test(textOf(c)));
    const first = rem();
    check("d: сданная работа со сроком через 20 ч — одно «⏰ Завтра срок» с кнопкой в Moodle; срок через 30 ч и не из Moodle — нет",
      first.length === 1 && textOf(first[0]) === "⏰ Завтра срок: ДЗ 1\nМатан · до 4 ноя, 08:00" && btns(first[0])[0]?.url === url(11) && btns(first[0])[0]?.text === "Открыть в Moodle",
      first.map((c) => oneLine(textOf(c))).join(" | "));
    await tick("2026-11-03T12:01");
    check("d: следующий обход — без повтора", rem().length === 1, `${rem().length}`);
    await tick("2026-11-03T17:59");
    const before18 = rem().length;
    await tick("2026-11-03T18:00");
    check("d: срок через 30 ч — напоминание ровно за сутки (в 18:00), не раньше", before18 === 1 && rem().length === 2 && /^⏰ Завтра срок: ДЗ 2/.test(textOf(rem()[1])), `${before18} → ${rem().length}`);

    // Срок 23:59 → напоминание выпало бы на 23:59 накануне (ночь) → в 22:00 того же вечера.
    st.deadlines.set("tok-1001", { courses: COURSES, items: [
      { id: "moodle:assign:13", kind: "assign", title: "ДЗ 3", courseId: 5, due: Date.parse("2026-11-05T23:59+03:00"), status: "open", url: url(13) }] });
    const r3 = rem().length;
    await tick("2026-11-04T21:59");
    const at2159 = rem().length - r3;
    await tick("2026-11-04T22:00");
    const at2200 = rem().length - r3;
    check("d: срок 23:59 — напоминание в 22:00 накануне: в 21:59 нет, в 22:00 есть", at2159 === 0 && at2200 === 1 && /^⏰ Завтра срок: ДЗ 3\nМатан · до 5 ноя, 23:59$/.test(textOf(rem().at(-1))),
      `21:59 → ${at2159}, 22:00 → ${at2200}: ${oneLine(textOf(rem().at(-1)))}`);

    // Срок 03:00 → напоминание выпало бы на 03:00 накануне → в 8:00 того же утра.
    st.deadlines.set("tok-1001", { courses: COURSES, items: [
      { id: "moodle:quiz:14", kind: "test", title: "Тест 4", courseId: 5, due: Date.parse("2026-11-07T03:00+03:00"), status: "open", url: "https://m.test/mod/quiz/view.php?id=140" }] });
    const r4 = rem().length;
    await tick("2026-11-06T03:00");
    const at0300 = rem().length - r4;
    await tick("2026-11-06T07:59");
    const at0759 = rem().length - r4;
    await tick("2026-11-06T08:00");
    const at0800 = rem().length - r4;
    check("d: срок 03:00 — напоминание в 8:00 накануне: в 03:00 и 07:59 нет, в 8:00 есть (кнопка «Открыть тест в Moodle»)",
      at0300 === 0 && at0759 === 0 && at0800 === 1 && /^⏰ Завтра срок: Тест 4/.test(textOf(rem().at(-1))) && btns(rem().at(-1))[0]?.text === "Открыть тест в Moodle",
      `03:00 → ${at0300}, 07:59 → ${at0759}, 08:00 → ${at0800}`);

    // «Новый тест … осталось 10 ч» с covers (как его шлёт notify.noteNew: x — сама работа, covers — «<id>:day») —
    // суточное напоминание по этому тесту не нужно.
    const T5 = at("2026-11-08T12:00");
    const c0 = sends(A).length;
    const kr3 = { id: "moodle:quiz:31", kind: "test", title: "КР 3", courseId: 5, due: T5 + 10 * HOUR, status: "open", url: "https://m.test/mod/quiz/view.php?id=310" };
    await st.relay(SRC, { key: "new:moodle:quiz:31", text: "🆕 Новый тест: КР 3\nМатан · до 8 ноя, 22:00\n⚠️ Осталось 10 ч", x: kr3, covers: "moodle:quiz:31:day" });
    await settle();
    st.deadlines.set("tok-1001", { courses: COURSES, items: [kr3] });
    await tick("2026-11-08T12:00");
    await tick("2026-11-08T12:01");
    const kr = sends(A).slice(c0).map(textOf);
    check("d: «Новый тест … осталось 10 ч» (covers) — напоминания «⏰ … КР 3» нет", kr.length === 1 && /^🆕 Новый тест: КР 3/.test(kr[0]) && !kr.some((t) => /^⏰.*КР 3/.test(t)), kr.map(oneLine).join(" | "));

    // Срок перенесли раньше, внутри суток (notify: «📅 Срок перенесли раньше», ключ due:<id>:<новый срок>, covers —
    // «<id>:day» и «<id>:3h»): своё напоминание за сутки по новому сроку беседе не нужно.
    at("2026-11-08T13:00");
    const D3 = Date.parse("2026-11-08T21:00+03:00");
    const dz7 = { id: "moodle:assign:17", kind: "assign", title: "ДЗ 7", courseId: 5, due: D3, status: "open", url: url(17) };
    const s0 = sends(A).length;
    await st.relay(SRC, { key: `due:moodle:assign:17:${D3}`, text: "📅 Срок перенесли раньше: ДЗ 7\nМатан · было до 15 ноя, 18:00, теперь до 8 ноя, 21:00\n⚠️ Осталось 8 ч", x: dz7, covers: ["moodle:assign:17:day", "moodle:assign:17:3h"] });
    await settle();
    st.deadlines.set("tok-1001", { courses: COURSES, items: [dz7] });
    await tick("2026-11-08T13:01");
    await tick("2026-11-08T13:02");
    const all7 = sends(A).slice(s0).map(textOf);
    check("d: срок перенесли раньше, на «через 8 ч» (covers) — одно «📅 Срок перенесли раньше», без «⏰»",
      all7.length === 1 && /^📅 Срок перенесли раньше: ДЗ 7/.test(all7[0]), all7.map(oneLine).join(" | "));

    // Ночь: в 22:00 обхода не было (ноутбук спал), первый обход — в 23:30. Беседу ночью не будим — напоминание в 8:00.
    st.deadlines.set("tok-1001", { courses: COURSES, items: [
      { id: "moodle:assign:15", kind: "assign", title: "ДЗ 5", courseId: 5, due: Date.parse("2026-11-10T23:59+03:00"), status: "open", url: url(15) }] });
    const r6 = rem().length;
    await tick("2026-11-09T23:30");
    const night = rem().slice(r6).map((c) => new Date(c.at + 3 * HOUR).toISOString().slice(11, 16));
    await tick("2026-11-10T08:00");
    const all5 = rem().slice(r6).map((c) => new Date(c.at + 3 * HOUR).toISOString().slice(11, 16));
    check("d: ночью (23:00–08:00) напоминание не уходит, даже если 22:00 пропущено (сервер не работал) — уходит в 8:00",
      night.length === 0 && all5.length === 1 && all5[0] === "08:00", `отправлено в: ${all5.join(", ") || "—"}`);

    // Срок продлили (notify: «📅 Срок продлили», ключ due:<id>:<новый срок>, covers пуст — новый срок дальше суток):
    // сообщение в беседу; напоминание по прежнему сроку уже было — по новому придёт снова, за сутки до нового срока.
    const D1 = Date.parse("2026-11-12T18:00+03:00"), D2 = Date.parse("2026-11-15T18:00+03:00");
    const dz6 = { id: "moodle:assign:16", kind: "assign", title: "ДЗ 6", courseId: 5, due: D1, status: "done", url: url(16) };
    st.deadlines.set("tok-1001", { courses: COURSES, items: [dz6] });
    const e0 = sends(A).length;
    await tick("2026-11-11T18:00");
    const ext = { ...dz6, due: D2 };
    st.deadlines.set("tok-1001", { courses: COURSES, items: [ext] });
    at("2026-11-11T19:00");
    await st.relay(SRC, { key: `due:moodle:assign:16:${D2}`, text: "📅 Срок продлили: ДЗ 6\nМатан · было до 12 ноя, 18:00, теперь до 15 ноя, 18:00", x: ext, covers: [] });
    await settle();
    await tick("2026-11-11T19:01");
    await tick("2026-11-14T17:59");
    const mid6 = sends(A).slice(e0).map(textOf);
    await tick("2026-11-14T18:00");
    const all6 = sends(A).slice(e0).map(textOf);
    check("d: срок продлили — «📅 Срок продлили» в беседу; напоминание по новому сроку — снова, ровно за сутки до него",
      mid6.length === 2 && /^⏰ Завтра срок: ДЗ 6\nМатан · до 12 ноя, 18:00$/.test(mid6[0]) && /^📅 Срок продлили: ДЗ 6/.test(mid6[1])
      && all6.length === 3 && /^⏰ Завтра срок: ДЗ 6\nМатан · до 15 ноя, 18:00$/.test(all6[2]), all6.map(oneLine).join(" | "));
  }

  // ---------------- e. сбои отправки ----------------
  {
    st.deadlines.set("tok-1001", dl([]));
    at("2026-11-16T12:00");
    st.sendHook = (b) => (b.chat_id === A && /Э1/.test(b.text) ? { ok: false, error_code: 500, description: "Internal Server Error" } : null);
    const tries = () => sends(A).filter((c) => /Э1/.test(textOf(c))).length;
    const ex = (n) => ({ id: `moodle:assign:${n}`, kind: "assign", courseId: 5, url: `https://m.test/a/${n}` });
    await st.relay(SRC, { key: "new:moodle:assign:41", text: "🆕 Новое задание: Э1", x: ex(41) });
    await settle();
    const q1 = rec()[A]?.relay?.queue || [];
    check("e: Telegram ответил 500 — сообщение осталось в очереди (1 попытка, повтор через минуту)", tries() === 1 && q1.length === 1 && q1[0].key === "new:moodle:assign:41" && q1[0].n === 1, JSON.stringify(q1));
    await tick("2026-11-16T12:01");
    check("e: следующий обход повторил", tries() === 2 && rec()[A]?.relay?.queue?.[0]?.n === 2, `${tries()}`);
    await tick("2026-11-16T12:02");
    check("e: пауза растёт (1, 2, 4… мин): через минуту после второй неудачи — не повторяет", tries() === 2, `${tries()}`);
    // Попытки: 12:00, 12:01, 12:03, 12:07, 12:15 — пять за четверть часа; шестая в 12:31 — больше 30 мин с первой.
    for (const t of ["12:03", "12:07", "12:15"]) await tick(`2026-11-16T${t}`);
    const q15 = rec()[A]?.relay?.queue || [];
    check("e: сбой связи на четверть часа сообщение не съедает — 5 попыток, ещё в очереди", tries() === 5 && q15.length === 1, `попыток ${tries()}, очередь ${q15.length}`);
    await tick("2026-11-16T12:31");
    const q2 = rec()[A]?.relay?.queue || [];
    check("e: шестая неудача и полчаса с первой — больше не повторяется, очередь пуста", tries() === 6 && q2.length === 0 && rec()[A]?.relay?.sent?.["new:moodle:assign:41"] != null, `попыток ${tries()}, очередь ${q2.length}`);
    // Обрыв после отправки (Telegram мог принять): один повтор, второй такой же — отметка, без третьей попытки.
    st.sendHook = (b) => (b.chat_id === A && /Э9/.test(b.text) ? { ok: false, network: true, code: "ECONNRESET", description: "socket hang up" } : null);
    const t9 = () => sends(A).filter((c) => /Э9/.test(textOf(c))).length;
    at("2026-11-16T13:00");
    await st.relay(SRC, { key: "new:moodle:assign:49", text: "🆕 Новое задание: Э9", x: ex(49) }); await settle();
    await tick("2026-11-16T13:01"); await tick("2026-11-16T13:05"); await tick("2026-11-16T13:30");
    check("e: «неизвестно, дошло ли» — один повтор, не больше (иначе дубли всей беседе)", t9() === 2 && !(rec()[A]?.relay?.queue || []).length, `попыток ${t9()}`);

    // Беседа стала супергруппой: отправка отвечает migrate_to_chat_id — запись переезжает, сообщение уходит туда один раз.
    st.sendHook = (b) => (b.chat_id === A ? { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: A2 } } : null);
    await st.relay(SRC, { key: "new:moodle:assign:42", text: "🆕 Новое задание: Э2", x: ex(42) });
    await settle();
    const all = rec();
    check("e: супергруппа — запись перенесена на новый номер (источник, группа, отметки), в новую беседу ушло одно сообщение",
      !all[A] && all[A2]?.source === SRC && all[A2]?.group === "БИСТ-24-ПО-2" && all[A2]?.relay?.sent?.["new:moodle:assign:41"] != null
      && okSends(A2).filter((c) => /Э2/.test(textOf(c))).length === 1 && (all[A2]?.relay?.queue || []).length === 0, `${Object.keys(all).join(",")} | ${JSON.stringify(all[A2]?.relay?.queue)}`);
    await tick("2026-11-16T13:40");
    await st.relay(SRC, { key: "new:moodle:assign:42", text: "🆕 Новое задание: Э2", x: ex(42) });
    await settle();
    await st.relay(SRC, { key: "new:moodle:assign:43", text: "🆕 Новое задание: Э3", x: ex(43) });
    await settle();
    check("e: после переезда — без повтора на следующем обходе и при повторе у источника; новое уходит сразу в новую беседу",
      sends(A2).filter((c) => /Э2/.test(textOf(c))).length === 1 && sends(A).filter((c) => /Э2/.test(textOf(c))).length === 1
      && okSends(A2).filter((c) => /Э3/.test(textOf(c))).length === 1 && !sends(A).some((c) => /Э3/.test(textOf(c))),
      `Э2: старая ${sends(A).filter((c) => /Э2/.test(textOf(c))).length}, новая ${sends(A2).filter((c) => /Э2/.test(textOf(c))).length}; Э3 в новой ${sends(A2).filter((c) => /Э3/.test(textOf(c))).length}`);
    st.sendHook = null;
  }

  // ---------------- f. /notify и /group ----------------
  {
    at("2026-11-17T12:00");
    st.deadlines.set("tok-3003", dl([]));
    let r = await say(chatC, ADM2, "/notify on", "Пётр");
    check("f: /notify on — админ, не вошедший в Doodle: просьба войти и кнопка на личку (t.me); источника нет",
      /Сначала войдите в Doodle/.test(textOf(r)) && btns(r).length === 1 && /^https:\/\/t\.me\//.test(btns(r)[0].url) && !btns(r)[0].web_app && rec()[C]?.source == null, oneLine(textOf(r)));
    r = await say(chatC, MEM, "/notify on");
    const memToday = await say(chatC, MEM, "/today");
    check("f: /notify on — не админ: отказ; обычные команды (/today) участнику отвечают", /Включают админы беседы/.test(textOf(r)) && memToday !== null && rec()[C]?.source == null, oneLine(textOf(r)));
    const dm0 = st.dms.filter((d) => d.tgId === ADM).length;
    r = await say(chatC, ADM, "/notify on", "Ира");
    const dmAdm = st.dms.filter((d) => d.tgId === ADM);
    check("f: /notify on — админ, вошедший в Doodle: он источник, беседа привязана к его группе, ему в личку — что используется",
      rec()[C]?.source === ADM && rec()[C]?.group === "ГР-24-ПО-1" && /Уведомления по курсам Moodle включены/.test(textOf(r)) && /привязана к группе ГР-24-ПО-1/.test(textOf(r))
      && dmAdm.length === dm0 + 1 && DM_USED.test(dmAdm.at(-1).text) && DM_PERSONAL.test(dmAdm.at(-1).text), `${JSON.stringify(rec()[C])} | ${oneLine(textOf(r))}`);
    r = await say(chatC, MEM, "/notify off");
    check("f: /notify off — не админ: отказ, уведомления остаются", /Выключают уведомления только админы беседы/.test(textOf(r)) && rec()[C]?.source === ADM, oneLine(textOf(r)));
    await st.relay(ADM, { key: "new:moodle:quiz:61", text: "🆕 Новый тест: Т61", x: { id: "moodle:quiz:61", kind: "test", courseId: 5, url: "https://m.test/q/61" } });
    await settle();
    r = await say(chatC, ADM, "/group off");
    const c1 = rec()[C];
    check("f: /group off при включённых уведомлениях — запись остаётся: источник и отметки на месте, группы нет",
      c1?.source === ADM && c1.group === null && c1.relay?.sent?.["new:moodle:quiz:61"] != null && !("schedule" in c1), `${JSON.stringify(c1)?.slice(0, 200)}`);
    check("f: /group off при включённых уведомлениях — ответ называет прежнюю группу («отвязана от группы ГР-24-ПО-1», не «null»)",
      /отвязана от группы ГР-24-ПО-1\./.test(textOf(r)), oneLine(textOf(r)));
    r = await say(chatC, ADM, "/group БИСТ-24-ПО-2 2");
    const c2 = rec()[C];
    check("f: /group <группа> — источник и отметки пересылки остаются",
      /привязана к группе БИСТ-24-ПО-2, подгруппа 2/.test(textOf(r)) && c2?.group === "БИСТ-24-ПО-2" && c2.subgroup === "2" && c2.source === ADM && c2.relay?.sent?.["new:moodle:quiz:61"] != null,
      `${JSON.stringify(c2)?.slice(0, 200)}`);
    // Источник — обычный участник беседы (не админ): /notify off в беседе — отказ (выключает только админ), свои курсы
    // он отключает кнопкой в личке.
    const chatA2 = { id: A2, type: "supergroup", title: "Беседа А" };
    const refused = await say(chatA2, SRC, "/notify off", "Аня");
    const still = rec()[A2]?.source === SRC;
    const v = await chats.sourceOff(SRC, A2); await settle();
    const a2 = rec()[A2];
    r = { body: { text: v.text } };
    check("f: источник не админ — /notify off в беседе: отказ; кнопкой в личке — выключено; привязка к группе осталась, источника и очереди нет, отметки отправленного — на месте",
      /только админы/.test(textOf(refused)) && still && /Готово: ваши курсы больше не используются/.test(v.text) && a2?.group === "БИСТ-24-ПО-2" && a2.source == null && !(a2.relay?.queue || []).length
      && a2.relay?.sent?.["new:moodle:assign:42"] != null && (await st.isSource(SRC)) === false,
      `${JSON.stringify(a2)?.slice(0, 200)} | ${oneLine(textOf(r))}`);
    const n2 = sends(A2).length;
    await st.relay(SRC, { key: "new:moodle:assign:44", text: "🆕 Новое задание: Э4", x: { id: "moodle:assign:44", kind: "assign", courseId: 5 } }); await settle();
    check("f: после /notify off пересылки нет", sends(A2).length === n2);
    st.admins.add(SRC);
    r = await say(chatA2, SRC, "/notify");
    st.admins.delete(SRC);
    check("f: /notify без слов (админ) — «выключены»", /Уведомления по курсам выключены/.test(textOf(r)), oneLine(textOf(r)));
  }

  // ---------------- h. источник без группы в профиле ----------------
  {
    at("2026-11-18T12:00");
    const chatD = { id: D, type: "group", title: "Беседа Г" };
    await added(chatD, { id: NOGRP, is_bot: false, first_name: "Гоша" });
    await settle();
    const d = rec()[D], m = sends(D);
    check("h: добавил вошедший без группы в профиле — источник есть, группы нет, строки о привязке нет",
      d?.source === NOGRP && d.group === null && m.length === 1 && /Уведомления по курсам Moodle включены/.test(textOf(m[0])) && !/Беседа привязана/.test(textOf(m[0])), JSON.stringify(d));
    const s0 = st.scheduleCalls.length;
    let err = null;
    try { await chats.tick(); } catch (e) { err = e; }
    check("h: обход изменений расписания пропускает беседу без группы", !err && !st.scheduleCalls.slice(s0).some((g) => !g), `${err?.message || ""} ${JSON.stringify(st.scheduleCalls.slice(s0))}`);
    const n = await chats.relayTick(clock); await settle();
    check("h: обход уведомлений по беседе без группы не падает", typeof n === "number");
    st.admins.add(NOGRP);
    const r = await say(chatD, NOGRP, "/notify off", "Гоша");
    st.admins.delete(NOGRP);
    check("h: /notify off источником в беседе без группы — запись убрана целиком", /Готово/.test(textOf(r)) && !rec()[D], JSON.stringify(rec()[D] || null));
  }

  // ---------------- g. экзамены группы беседы ----------------
  {
    st.files = [
      { name: "itkn-old.xlsx", title: "Сессия ИТКН (черновик)", url: "https://misis.ru/files/itkn-old.xlsx", seenAt: 50, parsed: true, groups: ["БИСТ-24-ПО-2"], until: "2027-01-20" },
      { name: "itkn.xlsx", title: "Сессия ИТКН", url: "https://misis.ru/files/itkn.xlsx", seenAt: 100, parsed: true, groups: ["БИСТ-24-ПО-2", "БПМ-23-1"], until: "2027-01-20" },
      { name: "other.xlsx", title: "Чужая", url: "https://misis.ru/files/other.xlsx", seenAt: 200, parsed: true, groups: ["БПМ-23-1"], until: "2027-01-20" },
    ];
    st.exams.set("БИСТ-24-ПО-2", { file: "itkn.xlsx", list: [
      { date: "2027-01-11", time: "12:00", name: "Консультация по матанализу", kind: "consult", place: "Б-404", teacher: "" },
      { date: "2027-01-12", time: "10:00", name: "Математический анализ", kind: "exam", place: "Б-404", teacher: "Иванов И. И." },
      { date: "2027-01-14", time: "09:00", name: "Физика", kind: "exam", place: "А-100", teacher: "" },
      { date: "2027-01-15", time: null, name: "Физкультура", kind: "test", place: "", teacher: "" },
    ] });
    const g0 = sends(C).length, others = sends(A2).length + sends(B).length;
    await tick("2027-01-05T12:00");
    const ann = sends(C).slice(g0).filter((c) => /^📅 Расписание экзаменов опубликовано/.test(textOf(c)));
    const b = btns(ann[0]);
    check("g: вышло расписание экзаменов группы беседы — одно объявление со всеми экзаменами и кнопкой «Файл на misis.ru» (самый новый файл)",
      ann.length === 1 && /^📅 Расписание экзаменов опубликовано \(«Сессия ИТКН»\)\nГруппа БИСТ-24-ПО-2:\n/.test(textOf(ann[0]))
      && /• 12 янв, 10:00 — Математический анализ \(экзамен\), Б-404/.test(textOf(ann[0])) && /• 15 янв — Физкультура \(зачёт\)/.test(textOf(ann[0]))
      && b[0]?.text === "Файл на misis.ru" && b[0]?.url === "https://misis.ru/files/itkn.xlsx" && b.every((x) => x.url && !x.web_app),
      `${ann.length}: ${oneLine(textOf(ann[0]))} ${JSON.stringify(b)}`);
    check("g: прежний файл той же группы отмечен без сообщения; беседы без источника ничего не получили",
      rec()[C]?.relay?.sent?.["exams:БИСТ-24-ПО-2:itkn-old.xlsx"] != null && !sends(C).some((c) => /черновик/.test(textOf(c))) && sends(A2).length + sends(B).length === others);
    await tick("2027-01-05T12:01");
    check("g: следующий обход — без повтора объявления", sends(C).filter((c) => /^📅 Расписание экзаменов/.test(textOf(c))).length === 1);
    const eve = () => sends(C).filter((c) => /^⏰ Завтра экзамен: Математический анализ/.test(textOf(c)));
    await tick("2027-01-11T17:00");
    const at17 = eve().length;
    await tick("2027-01-11T19:00");
    const at19 = eve().length;
    await tick("2027-01-11T19:30");
    check("g: накануне экзамена — в 17:00 нет, в 19:00 одно «⏰ Завтра экзамен» (дата, время, аудитория, преподаватель), без повтора; консультация — без напоминания",
      at17 === 0 && at19 === 1 && eve().length === 1 && textOf(eve()[0]) === "⏰ Завтра экзамен: Математический анализ\n12 января, 10:00 · Б-404 · Иванов И. И."
      && !sends(C).some((c) => /^⏰.*Консультация/.test(textOf(c))), `17:00 → ${at17}, 19:00 → ${at19}: ${oneLine(textOf(eve()[0]))}`);
    const day = () => sends(C).filter((c) => /^⏰ Сегодня экзамен: Математический анализ/.test(textOf(c)));
    await tick("2027-01-12T06:30");
    const at0630 = day().length;
    await tick("2027-01-12T08:00");
    check("g: в день экзамена — в 6:30 нет, в 8:00 (до начала в 10:00) одно «⏰ Сегодня экзамен … в 10:00»",
      at0630 === 0 && day().length === 1 && textOf(day()[0]) === "⏰ Сегодня экзамен: Математический анализ в 10:00 · Б-404 · Иванов И. И.\nУдачи!", `${at0630} → ${day().length}: ${oneLine(textOf(day()[0]))}`);
    await tick("2027-01-14T09:30");
    check("g: экзамен уже начался (9:00, обход в 9:30) — «Сегодня экзамен» не шлём", !sends(C).some((c) => /^⏰ Сегодня экзамен: Физика/.test(textOf(c))));
  }

  // ---------------- i. только общее ----------------
  const E = -1005, chatE = { id: E, type: "group", title: "Беседа Д" };
  {
    at("2026-11-19T12:00");
    await added(chatE, { id: SRC, is_bot: false, first_name: "Аня" }); await settle();
    const e0 = sends(E).length, T = clock;
    // Курс 6 — прошлый семестр, включён вручную (долг); курс 7 — «Пересдачи…»; в общем курсе 5 — «Пересдача ЛР 3» и «ЛР 4».
    const items = [
      { id: "moodle:assign:71", kind: "lab", title: "ЛР01", courseId: 6, due: T + 20 * HOUR, status: "open", url: "https://m.test/a/71" },
      { id: "moodle:assign:72", kind: "lab", title: "ЛР 2", courseId: 7, due: T + 20 * HOUR, status: "open", url: "https://m.test/a/72" },
      { id: "moodle:assign:73", kind: "lab", title: "Пересдача ЛР 3", courseId: 5, due: T + 20 * HOUR, status: "open", url: "https://m.test/a/73" },
      { id: "moodle:assign:74", kind: "lab", title: "ЛР 4", courseId: 5, due: T + 20 * HOUR, status: "open", url: "https://m.test/a/74" },
    ];
    st.deadlines.set("tok-1001", dl(items));
    for (const x of items) await st.relay(SRC, { key: `new:${x.id}`, text: `🆕 Новая лабораторная: ${x.title}`, x });
    await st.relay(SRC, { key: "news:901", text: "📣 Объявление · ОС\nДолжникам", url: "https://m.test/d/901", courseIds: [6] });
    await st.relay(SRC, { key: "new:many:x", text: "🆕 Появилось сразу 6 новых работ", courseIds: [5, 6] });
    await st.relay(SRC, { key: "mat:9:x", text: "📎 Новый материал · ?", url: "https://m.test/c/9", courseIds: [9] }); // курс, которого у источника нет
    await settle();
    await tick("2026-11-19T12:01");
    const got = sends(E).slice(e0).map(textOf).filter((t) => !/^📅 Расписание экзаменов/.test(t)); // экзамены группы (g) — своё
    check("i: в беседу — только работа общего курса (новая и напоминание); долг, «Пересдачи», «Пересдача» в названии, объявление курса-долга, пачка с ним и неизвестный курс — нет",
      got.length === 2 && got.some((t) => /🆕 Новая лабораторная: ЛР 4/.test(t)) && got.some((t) => /^⏰ Завтра срок: ЛР 4/.test(t)) && !got.some((t) => /ЛР01|ЛР 2|ЛР 3|Должникам|сразу|\?/.test(t)), got.map(oneLine).join(" | "));
    // Личное продление: у источника срок ДЗ 8 — 25 ноя, у двух одногруппников беседы (та же группа, вошли в Doodle) —
    // 22 ноя. Вошедший из другой группы (ADM, ГР-24-ПО-1) с 25 ноя не в счёт. «Срок продлили» источника ждёт, пока
    // дедлайны одногруппников перечитаются, — у них прежний срок: в беседу не идёт. Напоминание — по их сроку.
    const P1 = 7001, P2 = 7002;
    st.tokens.set(P1, "tok-p1").set(P2, "tok-p2"); st.profiles.set(P1, { group: "БИСТ-24-ПО-2" }).set(P2, { group: "бист-24-по-2" });
    const D22 = Date.parse("2026-11-22T18:00+03:00"), D25 = Date.parse("2026-11-25T18:00+03:00");
    const mine = { id: "moodle:assign:81", kind: "assign", title: "ДЗ 8", courseId: 5, due: D25, status: "open", url: "https://m.test/a/81" };
    const peer = (due, updated) => ({ ...dl([{ ...mine, due }]), updated });
    st.deadlines.set("tok-1001", dl([mine])).set("tok-3003", peer(D25, clock)).set("tok-p1", peer(D22, clock - HOUR)).set("tok-p2", peer(D22, clock - HOUR));
    at("2026-11-19T13:00");
    const p0 = sends(E).length;
    await st.relay(SRC, { key: `due:moodle:assign:81:${D22}:${D25}`, text: "📅 Срок продлили: ДЗ 8\nМатан · было до 22 ноя, 18:00, теперь до 25 ноя, 18:00", x: mine, covers: [] }); await settle();
    await tick("2026-11-19T13:01");
    const waiting = sends(E).length === p0 && !!rec()[E]?.relay?.pendingDue?.[`due:moodle:assign:81:${D22}:${D25}`];
    st.deadlines.set("tok-p1", peer(D22, clock + MIN)).set("tok-p2", peer(D22, clock + MIN)); // одногруппников перечитали — срок прежний
    await tick("2026-11-19T13:20");
    check("i: личное продление источника — «Срок продлили» ждёт одногруппников; у них срок прежний — в беседу не идёт",
      waiting && sends(E).length === p0 && !rec()[E]?.relay?.pendingDue?.[`due:moodle:assign:81:${D22}:${D25}`], sends(E).slice(p0).map((c) => oneLine(textOf(c))).join(" | "));
    await tick("2026-11-21T17:59");
    const r0 = sends(E).length;
    await tick("2026-11-21T18:00");
    const rr = sends(E).slice(r0).map(textOf);
    check("i: напоминание — за сутки до срока одногруппников (22 ноя), а не до личного; голос другой группы не в счёт", rr.length === 1 && /^⏰ Завтра срок: ДЗ 8\nМатан · до 22 ноя, 18:00$/.test(rr[0]), rr.map(oneLine).join(" | "));
    // Общий перенос: у источника и у одногруппников новый срок — в беседу.
    const D29 = Date.parse("2026-11-29T18:00+03:00"), all9 = { ...mine, id: "moodle:assign:83", title: "ДЗ 83", due: D29 };
    st.deadlines.set("tok-1001", dl([all9])).set("tok-p1", peer(Date.parse("2026-11-27T18:00+03:00"), clock - HOUR)).set("tok-p2", { ...dl([{ ...all9, due: Date.parse("2026-11-27T18:00+03:00") }]), updated: clock - HOUR });
    st.deadlines.get("tok-p1").items[0].id = all9.id;
    at("2026-11-21T19:00");
    const g0 = sends(E).length;
    await st.relay(SRC, { key: `due:${all9.id}:x:${D29}`, text: "📅 Срок продлили: ДЗ 83", x: all9, covers: [] }); await settle();
    st.deadlines.get("tok-p1").items[0].due = D29; st.deadlines.get("tok-p1").updated = clock + MIN; // перечитали — у них тоже новый
    await tick("2026-11-21T19:05");
    check("i: общий перенос (у одногруппников после перечитывания тот же новый срок) — «Срок продлили» в беседе", sends(E).slice(g0).some((c) => /^📅 Срок продлили: ДЗ 83/.test(textOf(c))), sends(E).slice(g0).map((c) => oneLine(textOf(c))).join(" | "));
    st.tokens.delete(P1); st.tokens.delete(P2);
    st.deadlines.set("tok-1001", dl([])).set("tok-3003", dl([])).set("tok-6006", dl([]));
    // Работа, о которой источнику ещё не сообщено «Новое …», — напоминание подождёт (первым придёт «🆕»).
    at("2026-11-21T19:00");
    const fresh = { id: "moodle:assign:82", kind: "assign", title: "ДЗ 82", courseId: 5, due: clock + 5 * HOUR, status: "open", url: "https://m.test/a/82" };
    st.deadlines.set("tok-1001", dl([fresh])); st.unseen.add(fresh.id);
    const u0 = sends(E).length;
    await tick("2026-11-21T19:01");
    const early = sends(E).length - u0;
    st.unseen.delete(fresh.id);
    await tick("2026-11-21T19:02");
    check("i: напоминание по работе, о которой «🆕» ещё не было, ждёт; после — уходит", early === 0 && sends(E).slice(u0).some((c) => /^⏰ Сегодня \(через ~5 ч\) срок: ДЗ 82/.test(textOf(c))), `${early} → ${sends(E).length - u0}`);
    st.deadlines.set("tok-1001", dl([]));
  }

  // ---------------- j. источник выключил, вышел из беседы, вышел из Doodle ----------------
  {
    at("2026-11-23T12:00");
    const on = async () => { st.admins.add(SRC); await say(chatE, SRC, "/notify on", "Аня"); st.admins.delete(SRC); };
    let v = await chats.sourceOff(OUT, E);
    check("j: «Отключить мои курсы» — не источник: ничего не меняется", /уже не используются/.test(v.text) && rec()[E]?.source === SRC, oneLine(v.text));
    const k0 = sends(E).length;
    v = await chats.sourceOff(SRC, E); await settle();
    check("j: «Отключить мои курсы» источником из лички — выключено, в беседе «🔕 … отключил их»",
      /Готово/.test(v.text) && rec()[E]?.source == null && sends(E).slice(k0).some((c) => /^🔕 Уведомления по курсам выключены: тот, чьи курсы использовались, отключил их/.test(textOf(c))), oneLine(v.text));
    await on();
    check("j: /notify on снова — источник тот же", rec()[E]?.source === SRC);
    const dm0 = st.dms.filter((d) => d.tgId === SRC).length, k1 = sends(E).length;
    await chats.onMessage({ message_id: ++mid, date: Math.floor(clock / 1000), chat: chatE, from: { id: SRC, is_bot: false, first_name: "Аня" }, left_chat_member: { id: SRC, is_bot: false, first_name: "Аня" } });
    await settle();
    check("j: источник вышел из беседы — выключено, в беседе сказано, ему в личку",
      rec()[E]?.source == null && sends(E).slice(k1).some((c) => /вышел из беседы/.test(textOf(c))) && st.dms.filter((d) => d.tgId === SRC).length === dm0 + 1, JSON.stringify(rec()[E])?.slice(0, 160));
    await on();
    st.tokens.delete(SRC);
    const k2 = sends(E).length;
    await tick("2026-11-23T12:05");
    check("j: источник вышел из Doodle — обход выключил уведомления, в беседе сказано", rec()[E]?.source == null && sends(E).slice(k2).some((c) => /вышел из Doodle/.test(textOf(c))), JSON.stringify(rec()[E])?.slice(0, 160));
    st.tokens.set(SRC, "tok-1001");
    await on();
  }

  // ---------------- k. ночь ----------------
  {
    st.deadlines.set("tok-1001", dl([]));
    at("2026-11-24T01:00");
    const n0 = sends(E).length;
    const x1 = { id: "moodle:assign:91", kind: "assign", courseId: 5, title: "ДЗ 9", due: Date.parse("2026-11-27T18:00+03:00"), url: "https://m.test/a/91" };
    const q1 = { id: "moodle:quiz:92", kind: "test", courseId: 5, title: "Т 9", due: Date.parse("2026-11-24T03:00+03:00"), url: "https://m.test/q/92" };
    await st.relay(SRC, { key: `new:${x1.id}`, text: "🆕 Новое задание: ДЗ 9", x: x1 });
    await st.relay(SRC, { key: `open:${q1.id}`, text: "🟢 Тест открыт: Т 9", x: q1 });
    await settle();
    const night = sends(E).slice(n0).map(textOf);
    await tick("2026-11-24T07:59");
    const before8 = sends(E).slice(n0).length;
    await tick("2026-11-24T08:00");
    const after8 = sends(E).slice(n0).map(textOf);
    check("k: ночью «тест открыт» уходит сразу, новое задание (срок через 3 дня) ждёт до 8:00",
      night.length === 1 && /Тест открыт/.test(night[0]) && before8 === 1 && after8.length === 2 && /Новое задание: ДЗ 9/.test(after8[1]), after8.map(oneLine).join(" | "));
  }

  // ---------------- поток команд (16 окт 2026: в беседе пишут «/notify удали компьютер») ----------------
  {
    at("2026-11-26T12:00");
    const F = -1009, chatF = { id: F, type: "supergroup", title: "Беседа Ж" }, TROLL = 7007, OTHER = 8008;
    const n0 = sends(F).length;
    for (let i = 0; i < 10; i++) await say(chatF, TROLL, `/notify удали компьютер ${i}`);
    const troll = sends(F).slice(n0).map(textOf);
    const other = await say(chatF, OTHER, "/notify");
    at("2026-11-26T12:01:30");
    const again = await say(chatF, TROLL, "/notify удали компьютер");
    check("поток: «/notify удали компьютер» — бот только просит on/off, ничего не меняет; от одного человека — не больше 6 ответов в минуту, сверх — молча; другому участнику отвечает; через минуту — снова",
      troll.length === 6 && troll.every((t) => /^Напишите \/notify on или \/notify off\.$/.test(t)) && rec()[F] == null && other !== null && /Уведомления по курсам выключены/.test(textOf(other))
      && again !== null, `${troll.length} ответов: ${oneLine(troll[0])}`);
    at("2026-11-26T13:00");
    const n1 = sends(F).length;
    for (let i = 0; i < 20; i++) await say(chatF, 9000 + i, "/notify");
    check("поток: много разных людей — во всю беседу не больше 15 ответов в минуту", sends(F).length - n1 === 15, `${sends(F).length - n1}`);
    at("2026-11-26T14:00");
    const n2 = sends(F).length;
    await say(chatF, OTHER, "/today а"); await say(chatF, TROLL, "/today б"); await say(chatF, OTHER, "/pairs");
    check("поток: «/today а», «/today б», /pairs подряд — один ответ (слова после команды расписания ни на что не влияют)", sends(F).length - n2 === 1, `${sends(F).length - n2}`);
  }

  // ---------------- итог по всем сообщениям в беседы ----------------
  {
    const toChats = st.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id < 0);
    const webApp = toChats.filter((c) => btns(c).some((x) => x.web_app || !x.url));
    check("всё: ни одной кнопки web_app (и кнопки без ссылки) под сообщениями в беседах", toChats.length > 10 && webApp.length === 0, `сообщений ${toChats.length}, с web_app ${webApp.length}`);
    check("всё: личные сообщения (deliver) — только людям, не беседам", st.dms.every((d) => d.tgId > 0), JSON.stringify(st.dms.map((d) => d.tgId)));
  }
} catch (e) { fails++; console.log("СБОЙ СЦЕНАРИЯ: " + (e.stack || e)); }

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
