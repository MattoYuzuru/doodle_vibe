// Бот в общих беседах (просьба владельца, 15 окт 2026: «добавить возможность добавлять бота в общие чаты», этап 1).
//
// В беседе — только то, что одинаково для всей учебной группы: расписание с «Дневача» и официальных файлов МИСИС и его
// изменения. Личное (дедлайны, оценки, журнал, сессия) в беседу не попадает: на такие команды бот зовёт в личку.
// Входить в Moodle для этого никому не нужно.
//
//   /group БИСТ-24-ПО-2 [1|2] — привязать беседу к группе (подгруппа по желанию; без неё — пары всех подгрупп
//                               с пометкой «подгр. N»); /group off — отвязать. Менять могут только админы беседы.
//   /group                    — что привязано и как поменять.
//   /today, /tomorrow, /week — расписание группы беседы (/pairs — прежнее имя /today).
//   Изменения расписания (перенос, отмена, новая пара, аудитория) — сообщением в беседу (tick, раз в 15 минут).
//
// Особенности Telegram: кнопка web_app в беседах запрещена — под сообщениями только ссылка на личный чат с ботом
// (t.me/<бот>). Режим приватности бота остаётся включённым: бот видит только команды, а не переписку. Беседа, ставшая
// супергруппой, меняет номер (migrate_to_chat_id) — привязка переезжает. Бота удалили или он больше не может писать —
// привязка снимается.
//
// Уведомления по курсам (этап 2, 16 окт 2026) — см. «уведомления по курсам старосты» ниже: /notify on | off.
//
// Хранение: chats.json рядом с сервером — { "<номер беседы>": { title, group, subgroup, by, at, schedule, source, relay } };
// group может быть null (беседа с уведомлениями по курсам, но без привязки к группе).
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as admission from "./admission.mjs";
import * as botCommands from "./bot-commands.mjs";
import * as moodle from "./moodle.mjs";
import * as notify from "./notify.mjs";
import * as official from "./official.mjs";
import { groupList, schedule } from "./schedule.mjs";
import * as session from "./session.mjs";
import { StateReadError, readJson, writeJsonAtomic } from "./state-file.mjs";
import * as users from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILE = join(DIR, "chats.json");
const GROUP_TYPES = new Set(["group", "supergroup"]);
const ANON_ADMIN = 1087968824; // @GroupAnonymousBot: от его имени пишут анонимные админы беседы
const SCHEDULE_CMDS = { pairs: "pairs", today: "pairs", tomorrow: "tomorrow", week: "week" };
const PERSONAL = new Set(["deadlines", "grades", "journal", "session", "settings", "digest", "stop", "invite", "stats", "terms", "privacy"]);
/*
 * Личные команды прямо в беседе (16 окт 2026, владелец: «давай попробуем»; Bot API 10.2/10.3 — эфемерные сообщения).
 * Команда из меню с is_ephemeral приходит с ephemeral_message_id (message_id = 0): её видят только автор и бот. Ответ —
 * тоже эфемерный (ephemeral_message_parameters + reply_parameters.ephemeral_message_id), его видит только автор, и
 * только в течение 15 секунд после команды — поэтому ответ ждём не дольше EPHEMERAL_WAIT, а не успели — короткое «пришлю
 * в личку» и полный ответ в личку. Доставку Telegram не обещает. Ответ короткий (bot-commands.compact, вариант A
 * владельца: три главные строки, остальное в сворачиваемой цитате) с одной кнопкой-ссылкой в личку — web_app в беседах
 * нельзя, нажатия на кнопки эфемерных сообщений бот не разбирает.
 * Выключатель: файл ephemeral.off рядом с сервером + перезапуск — меню и ответы как раньше («Это личное…» и ссылка в личку).
 * Откат кода — ops/rollback/ephemeral-2026-10-16/КАК-ВЕРНУТЬ.md.
 */
const EPHEMERAL = new Set(["deadlines", "grades", "journal", "session"]); // только просмотр: /stop, /settings и т. п. что-то меняют
const ephemeralOn = () => !existsSync(join(DIR, "ephemeral.off"));
const EPHEMERAL_WAIT = Number(process.env.CHAT_EPHEMERAL_WAIT_MS) || 9e3;
/** Меню команд бота в беседах (setMyCommands со scope all_group_chats — welcome.mjs; меняется при перезапуске). */
export const MENU = [
  { command: "today", description: "Пары группы сегодня" },
  { command: "tomorrow", description: "Пары на завтра" },
  { command: "week", description: "Расписание на неделю" },
  ...(ephemeralOn() ? [
    { command: "deadlines", description: "Мои сроки 🔒", is_ephemeral: true },
    { command: "grades", description: "Мои оценки 🔒", is_ephemeral: true },
    { command: "journal", description: "Мой журнал 🔒", is_ephemeral: true },
    { command: "session", description: "Моя сессия 🔒", is_ephemeral: true },
  ] : []),
  { command: "group", description: "Привязать беседу к группе (админы)" },
  { command: "notify", description: "Уведомления по курсам: on / off (админы)" },
  { command: "help", description: "Что бот умеет в беседе" },
];
const COOLDOWN =Number(process.env.CHAT_COOLDOWN_MS) || 20e3; // одна и та же команда в беседе — не чаще раза в 20 с

// --- хранение ---
// 15 окт 2026: файл общий для всех бесед, поэтому «пусто» — только когда его нет. Раньше любая ошибка чтения давала {}
// и запоминалась до перезапуска: tick не видел ни одной беседы, а первая же привязка /group записывала {} плюс одну
// беседу — привязки всех остальных пропадали. Теперь занятый файл — повторы и ошибка (в кэш не кладётся, update ничего
// не пишет), испорченный — копия в chats.json.bad-<время> и тоже ошибка: владелец чинит руками, пустым не затираем.
let cache = null, queue = Promise.resolve();
let brokenAt = null; // время изменения испорченного chats.json, уже отложенного в .bad-*: пока файл не поправили — без новых копий
const mtimeOf = () => stat(FILE).then((s) => s.mtimeMs, () => null);
async function load() {
  if (cache) return cache;
  const mtime = await mtimeOf();
  if (brokenAt !== null && mtime === brokenAt) throw new StateReadError(FILE, new Error("chats.json испорчен, копия уже в chats.json.bad-* — поправьте файл"));
  let all;
  try { all = await readJson(FILE, { missing: () => ({}), corrupt: "throw" }); }
  catch (e) { if (e?.cause instanceof SyntaxError) brokenAt = mtime; throw e; }
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new StateReadError(FILE, new Error("в chats.json не объект"));
  return (cache ??= all);
}
/** Изменение привязок по очереди: fn получает все беседы и может их менять — они сохранятся. Не прочитали — не пишем. */
function update(fn) {
  const next = queue.catch(() => {}).then(async () => {
    const all = await load(), before = JSON.stringify(all);
    const out = await fn(all);
    if (JSON.stringify(all) === before) return out; // ничего не поменялось — файл не переписываем (обход раз в минуту)
    await mkdir(DIR, { recursive: true });
    await writeJsonAtomic(FILE, all, { space: 2 }); // своё имя временного файла и rename с повторами (state-file.mjs)
    return out;
  });
  queue = next;
  return next;
}
/** Все привязанные беседы: [{ id, title, group, subgroup }] — для сводки владельцу и проверок. */
export async function list() { return Object.entries(await load()).map(([id, c]) => ({ id: Number(id), title: c.title, group: c.group, subgroup: c.subgroup })); }

// --- отправка ---
let botName = null;
const username = async () => (botName ??= (await notify.tg("getMe", {})).result?.username || null);
/**
 * Кнопка в беседе: web_app нельзя, поэтому ссылка на личный чат с ботом (там — «Открыть Doodle»). Без «?start=…»
 * (16 окт 2026, владелец: «перебрасывало на личный чат без нажатия на кнопку start»): с параметром Telegram каждый раз
 * показывает «Старт», а так — просто открывает чат. Кто боту ещё не писал, «Старт» увидит всё равно — это правило Telegram.
 */
async function dmButton(text = "Открыть Doodle в личке") { const n = await username(); return n ? [[{ text, url: `https://t.me/${n}` }]] : []; }
// Бота нет в беседе или писать туда нельзя — привязка больше не нужна.
const gone = (r) => r.error_code === 403 || /chat not found|bot was kicked|not a member|have no rights to send|CHAT_WRITE_FORBIDDEN|group chat was deactivated/i.test(String(r.description || ""));
/**
 * Сообщение в беседу: { to, res } — to: номер беседы, куда ушло (беседа стала супергруппой — привязка перенесена, номер
 * новый), или null; res — итог отправки, как у личных сообщений (notify.resultOf: sent, failed, limited, unknown…).
 */
async function postRaw(chatId, text, buttons, replyTo) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true, ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
  let r = await notify.tg("sendMessage", body);
  const moved = r.parameters?.migrate_to_chat_id;
  if (!r.ok && moved) { await migrate(chatId, moved); r = await notify.tg("sendMessage", { ...body, chat_id: moved }); chatId = moved; }
  if (r.ok) return { to: chatId, res: notify.resultOf(r) };
  if (gone(r)) { await forget(chatId, `сообщение не ушло: ${r.description}`); return { to: null, res: { ...notify.resultOf(r), status: "gone" } }; }
  console.log(`chats ${chatId}: ${r.description || "нет ответа"}`);
  return { to: null, res: notify.resultOf(r) };
}
/** То же, ответом «номер беседы, куда ушло» или false. */
const post = async (chatId, text, buttons, replyTo) => (await postRaw(chatId, text, buttons, replyTo)).to || false;
async function migrate(from, to) {
  // Прежний номер запоминаем: под ним кнопка «Отключить мои курсы от беседы» в личке источника (sourceOff).
  await update((all) => { if (all[from]) { all[to] = all[from]; delete all[from]; all[to].prevIds = [...new Set([...(all[to].prevIds || []), from])].slice(-5); } });
  console.log(`chats: беседа ${from} стала супергруппой ${to} — привязка перенесена`);
}
async function forget(chatId, why) {
  const had = await update((all) => { const h = !!all[chatId]; delete all[chatId]; return h; });
  if (had) console.log(`chats ${chatId}: привязка снята (${why})`);
}

// --- группа ---
/** Название группы как в списке групп (регистр, латиница/кириллица) или null. */
async function findGroup(name) {
  const want = official.normGroup(name);
  const all = await groupList().catch(() => []);
  return all.find((g) => official.normGroup(g) === want) || null;
}
async function isAdmin(chatId, m) {
  if (m.from?.id === ANON_ADMIN && m.sender_chat?.id === chatId) return true; // анонимный админ пишет от имени беседы
  const r = await notify.tg("getChatMember", { chat_id: chatId, user_id: m.from.id });
  return r.ok && (r.result?.status === "creator" || r.result?.status === "administrator");
}
const subLabel = (s) => (s ? `, подгруппа ${s}` : ", все подгруппы");
const HELP = `Я бот Doodle. В беседе показываю расписание группы и пишу, когда пару переносят или отменяют. С уведомлениями по курсам — ещё новые задания и тесты, объявления и материалы, сроки (за сутки) и экзамены.

Привязать беседу к группе (только админы): /group БИСТ-24-ПО-2
С подгруппой: /group БИСТ-24-ПО-2 2 · отвязать: /group off
Уведомления по курсам: /notify on (админ, вошедший в Doodle) · выключить: /notify off

Команды: /today — пары сегодня, /tomorrow — завтра, /week — неделя.
Личное (оценки, журнал, свои дедлайны) — только в личке.`;

async function groupCmd(chatId, m, args) {
  const cur = (await load())[chatId];
  if (!args.length) {
    return cur?.group ? `Беседа привязана к группе ${cur.group}${subLabel(cur.subgroup)}. Изменения расписания пишу сюда.\nПоменять (только админы): /group <группа> [подгруппа] · отвязать: /group off`
      : `Беседа ещё не привязана к группе.\nАдмин беседы может написать: /group БИСТ-24-ПО-2 (и номер подгруппы, если нужен).`;
  }
  if (!(await isAdmin(chatId, m))) return "Привязку меняют только админы беседы.";
  if (/^(off|выкл|отвязать|нет)$/i.test(args[0])) {
    if (!cur?.group) return "Беседа и так не привязана к группе.";
    const was = cur.group; // cur — та же запись в памяти, update её поменяет
    // Уведомления по курсам от группы не зависят — их запись остаётся (выключаются отдельно, /notify off).
    await update((all) => { const c = all[chatId]; if (!c) return; if (c.source != null) { c.group = null; c.subgroup = null; delete c.schedule; } else delete all[chatId]; });
    return `Готово: беседа отвязана от группы ${was}. Изменения расписания сюда больше не приходят.`;
  }
  let sub = null;
  if (args.length > 1 && /^[12]$/.test(args.at(-1))) sub = args.pop();
  const name = args.join(" ").slice(0, 60);
  const group = await findGroup(name);
  if (!group) return `Группу «${name}» не нашёл в расписании МИСИС. Проверьте написание, например: /group БИСТ-24-ПО-2`;
  await update((all) => {
    const c = all[chatId] || {}, keep = c.group === group && c.subgroup === sub ? c.schedule : undefined;
    // Уведомления по курсам (source, relay) при смене группы остаются.
    all[chatId] = { ...c, title: String(m.chat.title || "").slice(0, 120), group, subgroup: sub, by: m.from.id, at: Date.now() };
    if (keep) all[chatId].schedule = keep; else delete all[chatId].schedule;
    // Экзамены прежней группы, ещё не ушедшие, — прочь из очереди (ключи exams:<группа>:…, exam:<группа>:…).
    const g = official.normGroup(group), r = all[chatId].relay;
    if (Array.isArray(r?.queue)) r.queue = r.queue.filter((q) => !/^exams?:/.test(q.key) || q.key.startsWith(`exams:${g}:`) || q.key.startsWith(`exam:${g}:`));
  });
  void prime(chatId); // снимок расписания сразу: первое изменение после привязки уже будет замечено
  return `Готово: беседа привязана к группе ${group}${subLabel(sub)}.\nЕсли пару перенесут или отменят — напишу сюда. Расписание: /today, /tomorrow, /week.`;
}

// --- приём сообщений из бесед (welcome.mjs) ---
const lastCmd = new Map(); // «беседа:команда» → когда отвечали
// Поток команд (16 окт 2026, владелец: в беседе пишут «/notify удали компьютер» и подобное — «обезопасить бота»). Бот
// такие слова не выполняет — понимает только свой список команд, — но на каждую команду отвечает в беседу, а /notify и
// /group ещё и спрашивают Telegram, админ ли (getChatMember). Поэтому от одного человека в беседе — не больше PER_USER
// команд в минуту, во всю беседу — не больше PER_CHAT ответов в минуту; сверх — молча.
const PER_USER = Number(process.env.CHAT_PER_USER) || 6, PER_CHAT = Number(process.env.CHAT_PER_CHAT) || 15, WINDOW = 60e3;
const recent = new Map(); // «беседа» и «беседа:человек» → времена команд за последнюю минуту
const warned = new Map(); // «беседа:человек» → когда записали в журнал, что он пишет слишком часто
function tooMany(key, max, now) {
  const list = (recent.get(key) || []).filter((t) => now - t < WINDOW);
  const over = list.length >= max;
  if (!over) list.push(now);
  recent.set(key, list);
  if (recent.size > 5000) recent.clear();
  return over;
}
/** Добавили или убрали бота: my_chat_member. */
export async function onMember(u) {
  const chat = u.chat, now = u.new_chat_member?.status, was = u.old_chat_member?.status;
  if (!chat || !GROUP_TYPES.has(chat.type)) return;
  const inside = (s) => s === "member" || s === "administrator" || s === "restricted";
  if (inside(now) && !inside(was)) await added(chat, u.from);
  else if (!inside(now) && inside(was)) await forget(chat.id, "бота убрали из беседы");
}
/**
 * Бота добавили в беседу. Добавил тот, кто вошёл в Doodle, — его курсы сразу становятся источником уведомлений беседы
 * (решение владельца 16 окт 2026: без вопроса), беседа без группы привязывается к группе из его профиля; ему в личку —
 * что из его данных используется. Иначе — приветствие с подсказкой /group и /notify on.
 */
async function added(chat, from) {
  let src = null, bound = null;
  // Сбой включения (файл бесед не читается и т. п.) не должен оставить беседу без приветствия, как было до этапа 2.
  try {
    src = from && !from.is_bot ? await candidate(from.id) : null;
    if (src) bound = await enable(chat.id, chat.title, src);
  } catch (e) { console.log(`chats ${chat.id}: уведомления по курсам не включились (${e.message || e})`); src = null; }
  const lines = [HELP];
  if (src) lines.push("", await relayOnText(from.first_name));
  else lines.push("", "Чтобы сюда приходили уведомления по курсам (новые задания и тесты, сроки, объявления), админ беседы, вошедший в Doodle, пишет /notify on.");
  if (bound) lines.push("", `Беседа привязана к группе ${bound} (из профиля в Doodle). Поменять: /group <группа>.`);
  const { to, res } = await postRaw(chat.id, lines.join("\n"), await dmButton());
  // Источнику сказать обязательно, раз его курсы уже используются: и тогда, когда приветствие в беседу не ушло из-за
  // временного сбоя. Беседа недоступна (gone) — запись уже снята, говорить не о чем.
  if (src && (to || res.status !== "gone")) await tellSource(src.tgId, to || chat.id, chat.title, bound);
}
/** Человек вошёл в Doodle (есть токен Moodle) — { tgId, group } для источника уведомлений, иначе null. */
async function candidate(tgId) {
  const token = await users.moodleToken(tgId).catch(() => null);
  if (!token) return null;
  const p = await users.profile(tgId).catch(() => null);
  return { tgId: Number(tgId), group: p?.group || null };
}
/** Сделать человека источником уведомлений беседы. Возвращает группу, если беседа была без группы и привязана к его. */
async function enable(chatId, title, src) {
  const bound = await update((all) => {
    const c = (all[chatId] ??= { title: String(title || "").slice(0, 120), group: null, subgroup: null, at: Date.now() });
    if (c.source !== src.tgId) { c.source = src.tgId; c.sourceAt = Date.now(); }
    if (!c.group && src.group) { c.group = src.group; c.subgroup = null; c.by = src.tgId; return src.group; }
    return null;
  });
  if (bound) void prime(chatId);
  return bound;
}
/** Команда с именем бота: в беседе с другими ботами (режим приватности) голая «/notify» до нас может не дойти. */
const cmdFor = async (c) => { const n = await username(); return n ? c.replace(/^\/(\w+)/, `/$1@${n}`) : c; };
const relayOnText = async (name) => `🔔 Уведомления по курсам Moodle включены: новые задания и тесты, открытие тестов, объявления и материалы, напоминание за сутки до срока, переносы сроков, экзамены группы. Источник — курсы текущего семестра ${name ? `участника ${name}` : "участника"}, который подключил бота; оценки, долги и другие личные данные сюда не попадают.
Выключить: ${await cmdFor("/notify off")} (админы).`;
/**
 * Источнику — в личку (просьба владельца 16 окт 2026): что из его данных используется, что нет, и кнопка «Отключить» —
 * выключить можно и не заходя в беседу (callback chatoff:<беседа>, welcome.mjs → sourceOff). Приходит и при /stop.
 */
async function tellSource(tgId, chatId, title, bound) {
  await notify.deliver(tgId, `🔔 Doodle подключён к беседе «${String(title || "без названия").slice(0, 80)}».
Сведения о ваших курсах Moodle текущего семестра используются для общих уведомлений в этой беседе: новые задания и тесты, открытие тестов, объявления и материалы курсов, напоминания за сутки до срока (сдали вы работу или нет), переносы сроков.${bound ? `\nБеседа привязана к вашей группе ${bound} — туда же придут её расписание и экзамены.` : ""}
Ваши личные данные — оценки, замечания преподавателей, пропуски, баллы и долги, пересдачи, ваша работа над лабораторными в Doodle — не используются и в беседу не попадают. В беседе видно, что уведомления идут по вашим курсам.
Выключить: кнопка ниже (в беседе — админ командой ${await cmdFor("/notify off")}).`, undefined, [[{ text: "Отключить мои курсы от беседы", callback_data: `chatoff:${chatId}` }]], { force: true });
}
/**
 * Отзыв согласия (21 окт 2026): человек перестаёт быть источником курсов бесед (беседа получает то же сообщение, что при
 * выходе) и больше не записан в них тем, кто привязал беседу (by) и источником (source).
 */
export async function eraseUser(tgId) {
  tgId = Number(tgId);
  const all = await load();
  for (const id of Object.keys(all)) if (all[id]?.source === tgId) await disable(Number(id), "logout");
  await update((all2) => { for (const c of Object.values(all2)) if (c && c.by === tgId) c.by = null; });
}
/** Нажатие «Отключить мои курсы от беседы» в личке (welcome.mjs): { text } для правки сообщения. */
export async function sourceOff(tgId, chatId) {
  const all = await load();
  // Беседа могла стать супергруппой (номер сменился) — ищем и по прежним номерам.
  const id = all[chatId] ? Number(chatId) : Number(Object.keys(all).find((k) => all[k]?.prevIds?.includes(Number(chatId))) ?? chatId);
  const c = all[id];
  if (!c || c.source !== Number(tgId)) return { text: "Ваши курсы этой беседой уже не используются." };
  await disable(id, "dm");
  return { text: `Готово: ваши курсы больше не используются для уведомлений в беседе «${String(c.title || "без названия").slice(0, 80)}». Включить снова — /notify on в беседе (это может админ беседы).` };
}
/**
 * Выключить уведомления по курсам беседы: why — off (команда /notify off, ответ даёт она), dm (источник отключил из
 * лички), left (источник вышел из беседы), logout (вышел из Doodle). Отправленное (relay.sent) остаётся: включат снова —
 * то же самое повторно не придёт. Беседа без группы и без отметок — запись прочь. Возвращает бывший источник или null.
 */
async function disable(chatId, why) {
  const had = await update((all) => {
    const c = all[chatId];
    if (!c || c.source == null) return null;
    const src = c.source;
    delete c.source; delete c.sourceAt;
    if (c.relay && typeof c.relay === "object") c.relay.queue = [];
    if (!c.group && !Object.keys(c.relay?.sent || {}).length) delete all[chatId];
    return src;
  });
  if (had == null || why === "off") return had;
  const say = { dm: "тот, чьи курсы использовались, отключил их", left: "тот, чьи курсы использовались, вышел из беседы", logout: "тот, чьи курсы использовались, вышел из Doodle" }[why];
  console.log(`chats ${chatId}: уведомления по курсам выключены (${why})`);
  await post(chatId, `🔕 Уведомления по курсам выключены: ${say}. Расписание и его изменения — как раньше.\nВключить снова: ${await cmdFor("/notify on")} — админ беседы, вошедший в Doodle.`).catch(() => {});
  return had;
}
/** /notify — уведомления по курсам: без слов — состояние, on — источником становится написавший (админ, вошедший в Doodle), off — выключить. */
async function notifyCmd(chatId, m, args) {
  const cur = (await load())[chatId];
  const on = cur?.source != null;
  if (!args.length) return on ? `Уведомления по курсам Moodle включены: новые задания и тесты, объявления и материалы, сроки за сутки, экзамены. Личное (оценки и т. п.) сюда не попадает.\nВыключить: /notify off (админы)`
    : "Уведомления по курсам выключены. Включить: /notify on — админ беседы, вошедший в Doodle (сроки и новые работы берутся из его курсов; личное сюда не попадает).";
  if (/^(off|выкл|нет)$/i.test(args[0])) {
    if (!on) return "Уведомления по курсам и так выключены.";
    // Выключить уведомления в беседе — только админ (16 окт 2026, владелец: «только выключение уведомлений доступно
    // админу»). Тот, чьи это курсы, свои данные отключает кнопкой в личке (sourceOff) — это его право, не беседы.
    if (!(await isAdmin(chatId, m))) return "Выключают уведомления только админы беседы.";
    await disable(chatId, "off");
    return "Готово: уведомления по курсам сюда больше не приходят. Расписание и его изменения — как раньше.";
  }
  if (!/^(on|вкл|да)$/i.test(args[0])) return "Напишите /notify on или /notify off.";
  if (m.from.id === ANON_ADMIN) return "Анонимный админ не может включить: уведомления берутся из курсов того, кто включает. Напишите /notify on от своего имени.";
  if (!(await isAdmin(chatId, m))) return "Включают админы беседы.";
  const src = await candidate(m.from.id);
  if (!src) return "Сначала войдите в Doodle в личке бота (кнопка ниже): сроки и новые работы берутся из ваших курсов Moodle.";
  if (cur?.source === src.tgId) return "Уведомления по вашим курсам уже приходят сюда.";
  const bound = await enable(chatId, m.chat.title, src);
  await tellSource(src.tgId, chatId, m.chat.title, bound);
  return [await relayOnText(m.from.first_name), ...(bound ? ["", `Беседа привязана к группе ${bound} (из профиля в Doodle). Поменять: /group <группа>.`] : [])].join("\n");
}
/**
 * Сообщение из беседы: команды бота, переезд в супергруппу. Остальное (обычную переписку бот с режимом приватности и
 * не получает) — молча пропускаем.
 */
export async function onMessage(m) {
  const chatId = m.chat.id;
  if (m.migrate_to_chat_id) return migrate(chatId, m.migrate_to_chat_id);
  if (m.left_chat_member && m.left_chat_member.username && m.left_chat_member.username === (await username())) return forget(chatId, "бота убрали из беседы");
  // Ушёл (или его удалили) тот, чьи курсы — источник уведомлений: его данные этой беседе больше не отдаём. Служебные
  // сообщения о выходе бот получает и в режиме приватности.
  if (m.left_chat_member && !m.left_chat_member.is_bot && (await load())[chatId]?.source === m.left_chat_member.id) {
    if (await disable(chatId, "left") != null) await notify.deliver(m.left_chat_member.id, `Вы вышли из беседы «${String(m.chat.title || "без названия").slice(0, 80)}» — ваши курсы больше не используются для её уведомлений.`, undefined, undefined, { force: true });
    return;
  }
  const t = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(String(m.text || "").trim());
  if (!t || !m.from || (m.from.is_bot && m.from.id !== ANON_ADMIN)) return;
  if (t[2] && t[2].toLowerCase() !== String(await username()).toLowerCase()) return; // команда другому боту
  const cmd = t[1].toLowerCase(), args = String(t[3] || "").trim().split(/\s+/).filter(Boolean);
  const known = cmd === "group" || cmd === "notify" || cmd === "help" || cmd === "start" || SCHEDULE_CMDS[cmd] || PERSONAL.has(cmd);
  if (!known) return;
  // Команда, которую видит только автор: ответ тоже только ему — беседу не засоряет, поэтому без общего «не чаще раза
  // в 20 с» и предела на беседу; предел на человека остаётся.
  if (m.ephemeral_message_id != null && EPHEMERAL.has(cmd) && !m.from.is_bot) {
    if (tooMany(`${chatId}:${m.from.id}`, PER_USER, Date.now())) return;
    return ephemeralReply(chatId, m, cmd);
  }
  // Слова после команд расписания и справки ни на что не влияют — в ключе их нет: «/today а», «/today б» подряд не дают
  // два одинаковых ответа (/pairs и /today — одна команда).
  const key = cmd === "group" || cmd === "notify" ? `${chatId}:${cmd}:${args.join(" ")}` : `${chatId}:${SCHEDULE_CMDS[cmd] || cmd}`;
  if (cmd !== "group" && cmd !== "notify" && Date.now() - (lastCmd.get(key) || 0) < COOLDOWN) return; // не засыпать беседу одинаковыми ответами
  const now = Date.now(), who = `${chatId}:${m.from.id}`;
  if (tooMany(who, PER_USER, now)) {
    if (now - (warned.get(who) || 0) > 10 * WINDOW) { warned.set(who, now); console.log(`chats ${chatId}: ${m.from.id} пишет команды чаще ${PER_USER} в минуту — не отвечаю`); }
    if (warned.size > 5000) warned.clear();
    return;
  }
  if (tooMany(String(chatId), PER_CHAT, now)) return;
  lastCmd.set(key, now);
  if (lastCmd.size > 5000) lastCmd.clear();
  let text, buttons;
  if (cmd === "group") text = await groupCmd(chatId, m, args);
  else if (cmd === "notify") { text = await notifyCmd(chatId, m, args); if (/Сначала войдите в Doodle/.test(text)) buttons = await dmButton(); }
  else if (cmd === "help" || cmd === "start") { text = HELP; buttons = await mineRow(); }
  else if (PERSONAL.has(cmd)) { text = "Это личное — дедлайны, оценки и настройки показываю только в личке."; buttons = await dmButton("Написать боту"); }
  else {
    const c = (await load())[chatId];
    if (!c?.group) text = "Беседа ещё не привязана к группе. Админ беседы может написать: /group БИСТ-24-ПО-2";
    else {
      text = await botCommands.scheduleText(SCHEDULE_CMDS[cmd], { group: c.group, subgroup: c.subgroup }).catch(() => "Расписание сейчас не загрузилось — попробуйте чуть позже.");
      text = text.replace(/^(📅 [^\n]+|🗓 [^\n]+)/, `$1 · ${c.group}${c.subgroup ? `, подгр. ${c.subgroup}` : ""}`);
      buttons = await mineRow();
    }
  }
  await post(chatId, text, buttons, m.message_id);
}
/*
 * Кнопки личного ответа (16 окт 2026, владелец: «давай так и сделаем» — переключатель, «Обновить», «Мои сроки 🔒»):
 *   - вкладки «Сроки · Оценки · Журнал · Сессия» (eph:<команда>) — тот же ответ правится на месте
 *     (editEphemeralMessageText); текущая вкладка — неактивная кнопка (disabled, Bot API 10.3);
 *   - «🔄 Обновить» (eph:r:<команда>) — пересобрать из уже загруженных сервером данных;
 *   - «Мои сроки 🔒» под общими сообщениями бота (eph:new:deadlines) — нажавшему новый личный ответ (callback_query_id,
 *     те же 15 секунд). Общее сообщение не заменяется: его видят и читают все.
 * Нажимать вкладки может только получатель ответа — эфемерное сообщение никто другой не видит; данные — всегда того,
 * кто нажал (cb.from от Telegram).
 */
const TABS = [["deadlines", "Сроки"], ["grades", "Оценки"], ["journal", "Журнал"], ["session", "Сессия"]];
const CB_PER_USER = 20; // нажатий в минуту на человека: вкладки листают быстрее, чем пишут команды
async function ephemeralKeyboard(cmd, more) {
  const tabs = TABS.map(([c, label]) => (c === cmd ? { text: `• ${label}`, disabled: {} } : { text: label, callback_data: `eph:${c}` }));
  return [tabs, [{ text: "🔄 Обновить", callback_data: `eph:r:${cmd}` }, ...((await dmButton(more || "Открыть Doodle в личке"))[0] || [])]];
}
/** Кнопки под общим сообщением бота: ссылка в личку и (если личные ответы включены) «Мои сроки 🔒» в той же строке. */
async function mineRow() {
  const dm = (await dmButton())[0] || [];
  const row = [...dm, ...(ephemeralOn() ? [{ text: "Мои сроки 🔒", callback_data: "eph:new:deadlines" }] : [])];
  return row.length ? [row] : [];
}
const ephemeralReply = (chatId, m, cmd) => ephemeralSend(m.chat, m.from.id, cmd, { replyTo: m.ephemeral_message_id });
/**
 * Личный ответ, который видит только tgId: на эфемерную команду (to.replyTo — её ephemeral_message_id) или на нажатие
 * «Мои сроки 🔒» (to.cbId — callback_query_id). Короткий (bot-commands.compact — заголовок, три строки, остальное
 * в сворачиваемой цитате, HTML) с вкладками и «Обновить». Не успели за EPHEMERAL_WAIT или Telegram не принял — полный
 * ответ (bot-commands.answer, как в личке, со всеми кнопками) в личку.
 */
async function ephemeralSend(chat, tgId, cmd, to) {
  const toDm = async () => {
    const r = await botCommands.answer(tgId, cmd).catch(() => null);
    if (r) await notify.deliver(tgId, `Ответ на /${cmd} из беседы «${String(chat.title || "без названия").slice(0, 80)}»:\n\n${r.text}`, undefined, r.buttons, { force: true }).catch(() => {});
  };
  let r, late = false, full = false;
  if (!ephemeralOn()) r = { text: "Это личное — дедлайны, оценки и настройки показываю только в личке." };
  else {
    const job = botCommands.compact(tgId, cmd).catch(() => null);
    let timer;
    r = await Promise.race([job, new Promise((ok) => { timer = setTimeout(() => ok("late"), EPHEMERAL_WAIT); })]);
    clearTimeout(timer);
    if (r === "late") { late = true; r = { text: "⏳ Долго собираю — пришлю в личку." }; void job.then(toDm); }
    else if (!r) r = { text: "Не получилось собрать ответ — попробуйте ещё раз чуть позже." };
    else full = true;
  }
  const buttons = full ? await ephemeralKeyboard(cmd, r.more) : await dmButton(r.more || "Открыть Doodle в личке");
  const res = await notify.tg("sendMessage", { chat_id: chat.id, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ephemeral_message_parameters: { receiver_user_id: tgId, ...(to.cbId ? { callback_query_id: to.cbId } : {}) },
    ...(to.replyTo != null ? { reply_parameters: { ephemeral_message_id: to.replyTo } } : {}) });
  if (res.ok) return;
  console.log(`chats ${chat.id}: эфемерный ответ на /${cmd} не ушёл (${res.description || "нет ответа"}) — шлю в личку`);
  if (!late && ephemeralOn()) await toDm();
}
/**
 * Нажатие кнопки в беседе (welcome.mjs): eph:* — вкладки и «Обновить» личного ответа, «Мои сроки 🔒» под общими
 * сообщениями. Возвращает текст всплывающей подсказки (answerCallbackQuery) или null; чужие кнопки — null.
 */
export async function onCallback(cb) {
  const chat = cb.message?.chat, tgId = cb.from?.id;
  const t = /^eph:(?:(r|new):)?(deadlines|grades|journal|session)$/.exec(String(cb.data || ""));
  if (!t || !chat || !GROUP_TYPES.has(chat.type) || !tgId || cb.from.is_bot) return null;
  if (!ephemeralOn()) return "Личные ответы в беседе выключены — напишите боту в личку.";
  if (tooMany(`cb:${chat.id}:${tgId}`, CB_PER_USER, Date.now())) return "Слишком часто — подождите немного.";
  const cmd = t[2], eid = cb.message.ephemeral_message_id;
  if (t[1] === "new" || eid == null) { await ephemeralSend(chat, tgId, cmd, { cbId: cb.id }); return null; }
  // Вкладка или «Обновить» на самом личном ответе — правим его на месте (срока в 15 секунд у правки нет).
  const v = (await botCommands.compact(tgId, cmd).catch(() => null)) || { text: "Не получилось собрать ответ — попробуйте ещё раз чуть позже." };
  const res = await notify.tg("editEphemeralMessageText", { chat_id: chat.id, receiver_user_id: tgId, ephemeral_message_id: eid, text: v.text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: await ephemeralKeyboard(cmd, v.more) } });
  if (res.ok) return t[1] === "r" ? "Обновлено" : null;
  if (/not modified/i.test(String(res.description || ""))) return "Новых изменений нет";
  // Ответ уже исчез (эфемерные живут недолго) — новым личным ответом.
  console.log(`chats ${chat.id}: правка личного ответа не прошла (${res.description || "нет ответа"}) — шлю новый`);
  await ephemeralSend(chat, tgId, cmd, { cbId: cb.id });
  return null;
}

// --- изменения расписания ---
/** Снимок расписания беседы без сообщения (сразу после привязки). */
async function prime(chatId) {
  try { await checkOne(chatId, { silent: true }); } catch (e) { console.log(`chats ${chatId}: ${e.message || e}`); }
}
async function checkOne(chatId, { silent = false } = {}) {
  const c = (await load())[chatId];
  if (!c?.group) return 0; // беседа только с уведомлениями по курсам, без группы
  const s = await schedule(c.group);
  const r = notify.scheduleDiff(c.schedule, s.lessons || [], c.group, c.subgroup);
  if (r.suspicious) { console.log(`chats ${chatId}: расписание: ${r.suspicious} — похоже на сбой данных, не пишу`); return 0; }
  // Снимок пишем до отправки: при сбое сообщения изменение не повторится бесконечно (как и в личных чатах).
  const still = await update((all) => { if (!all[chatId] || all[chatId].group !== c.group || all[chatId].subgroup !== c.subgroup) return false; all[chatId].schedule = r.snapshot; return true; });
  if (!still || silent || !r.count) return 0;
  return (await post(chatId, r.text, await mineRow())) ? r.count : 0;
}
let busy = false;
/** Обход всех бесед: вызывается сервером раз в 15 минут. Возвращает число изменений, о которых написано. */
export async function tick() {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    for (const id of Object.keys(await load())) {
      try { n += await checkOne(Number(id)); } catch (e) { console.log(`chats ${id}: ${e.message || e}`); }
    }
  } finally { busy = false; }
  return n;
}

// --- уведомления по курсам старосты ---
// Владелец, 16 окт 2026: «если бота добавил в группу староста, то уведомления на тесты, появление новых материалов,
// контрольные… все уведомления, которые у старосты, кроме пересдач и задолженностей, будут отображаться в общем чате»;
// «бот должен присылать дедлайны работ вне зависимости, сдал староста работу или нет, — за сутки»; «если изменили срок
// работы… об этом тоже нужно уведомлять»; при подключении старосте в личку — что сведения о его курсах используются для
// общих уведомлений, а личные — нет (tellSource).
// Источник (source) — тот, кто добавил бота и вошёл в Doodle, или админ, написавший /notify on. В беседу идёт только общее:
//   - новые задания и тесты, «тест открыт», «срок перенесли», объявления и материалы курсов — те же сообщения, что у
//     источника (notify.relay из notify.sendOut и news.sendAll), даже если у него самого они выключены;
//   - напоминание за сутки до срока каждой работы его курсов — своё (relayTick), по сроку, а не по тому, сдал ли он;
//   - экзамены группы беседы (файлы МИСИС, а не план источника): расписание, когда вышло, и напоминания накануне
//     (18–22) и в день экзамена (7–11, до начала).
// Что считается общим (две независимые проверки 16 окт 2026 — исправлено):
//   - только курсы текущего семестра по автоматике (courses[].auto, moodle.courseAuto) и не для должников (courses[].debt —
//     по полному названию): курс прошлого семестра, включённый вручную (долг), «Пересдача…» — не в беседу; работы с такими
//     словами в названии — тоже (и из пачки «появилось сразу N»); курсы берутся из той же проверки, что прислала
//     сообщение (кэш дедлайнов источника бывает пуст);
//   - материалы — только видимые всей группе (news.forAll); объявления для одной группы курса (groupid > 0) — нет;
//   - срок — источника, если хоть у одного одногруппника беседы (вошедшего в Doodle, та же группа) он такой же или у
//     одногруппников этой работы нет; иначе — их общий (личное продление источника беседе не показываем). «Срок
//     перенесли» ждёт (relay.pendingDue), пока дедлайны одногруппников перечитаются: у них тот же новый срок или их нет —
//     в беседу, у них прежний — это личное, не пишем; не дождались за 3 ч — пишем. Время на попытку теста — только ему.
// Оценки, замечания, пропуски, баллы и долги к сессии, лабы источника сюда не попадают (их notify и не пересылает).
// Отправка: сообщение ставится в очередь беседы (relay.queue, под замком файла) и уходит сразу; не ушло — повтор, как у
// личных сообщений (notify.retryExhausted): сбой связи или 429 — повтор с паузой (retry_after, иначе 1, 2, 4… до 30 мин),
// сдаёмся не раньше 30 минут и 6 попыток с первой неудачи или через сутки после неё; «неизвестно, дошло ли» — один
// повтор; отказ 4xx — сразу. Ночью (23:00–08:00 по Москве) очередь ждёт утра, кроме срочного (тест открыт, срок раньше
// чем через 10 ч). Срок прошёл — не отправляем. Текст напоминания о сроке собирается в момент отправки («Завтра» вечером
// и «Сегодня» утром). relay.sent — что уже ушло (ключ → когда), помнится SENT_KEEP.
const HOUR = 3600e3, DAY = 24 * HOUR, MSK = 3 * HOUR, MIN = 60e3;
const TRIES = 6, GIVE_UP_AFTER = 30 * MIN, QUEUE_MAX = 40, SENT_KEEP = 90 * DAY, PER_FLUSH = 10, URGENT = 10 * HOUR;
const PENDING_WAIT = 3 * HOUR, NEAR = 10 * MIN;
const DEBT = /пересда|задолж|должник|ликвидац/i;
/** Состояние пересылки беседы (с починкой испорченного) и чистка старых отметок. */
function relayState(c, now = Date.now()) {
  if (!c.relay || typeof c.relay !== "object") c.relay = {};
  const r = c.relay;
  if (!r.sent || typeof r.sent !== "object" || Array.isArray(r.sent)) r.sent = {};
  if (!Array.isArray(r.queue)) r.queue = [];
  if (!r.pendingDue || typeof r.pendingDue !== "object" || Array.isArray(r.pendingDue)) r.pendingDue = {};
  for (const [k, at] of Object.entries(r.sent)) if (!(now - at < SENT_KEEP)) delete r.sent[k];
  return r;
}
const wasSent = (r, key, ttl, now) => { const at = r?.sent?.[key]; return at != null && (!ttl || now - at < ttl); };
const queued = (r, key) => !!r?.queue?.some?.((q) => q.key === key) || !!r?.pendingDue?.[key];
/** Источник ли человек хоть одной беседы. */
async function isSource(tgId) { return Object.values(await load()).some((c) => c?.source === tgId); }
/** Общие курсы (см. выше) из списка курсов источника: Set id или null — курсы не известны. */
function generalCourses(courses) {
  return Array.isArray(courses) ? new Set(courses.filter((c) => c.auto === true && !c.debt && !DEBT.test(`${c.name || ""} ${c.short || ""}`)).map((c) => c.id)) : null;
}
const general = (gen, x) => !!gen && gen.has(x.courseId) && !DEBT.test(String(x.title || ""));
/** Группа, по которой ищем одногруппников беседы: её собственная или (беседа без группы) группа источника. */
async function chatGroup(c) { return official.normGroup(c.group || (await users.profile(c.source).catch(() => null))?.group || ""); }
/*
 * Сроки одногруппников беседы: id работы → [{ due, at }] — у вошедших в Doodle той же группы, кроме источника; at — когда
 * их дедлайны прочитаны из Moodle. Только уже прочитанное сервером (staleDeadlines), в Moodle не ходим. Память на 20 с:
 * relay зовётся на каждое сообщение источника.
 */
const peersMemo = new Map(); // группа|источник → { at, map }
async function peerDues(group, source, now = Date.now()) {
  if (!group) return new Map();
  const key = `${group}|${source}`, m = peersMemo.get(key);
  if (m && now - m.at < 20e3 && now >= m.at) return m.map;
  const map = new Map();
  for (const u of await users.allLoggedIn().catch(() => [])) {
    if (u.tgId === source) continue;
    const g = official.normGroup((await users.profile(u.tgId).catch(() => null))?.group || "");
    const d = g === group ? moodle.staleDeadlines(u.token) : null;
    for (const x of d?.items || []) if (x.due) (map.get(x.id) || map.set(x.id, []).get(x.id)).push({ due: x.due, at: d.updated || 0 });
  }
  if (peersMemo.size > 200) peersMemo.clear();
  peersMemo.set(key, { at: now, map });
  return map;
}
/** Срок работы для беседы: источника, если у одногруппников он такой же (±10 мин) или работы у них нет; иначе их самый частый. */
function dueFor(peers, x) {
  const list = peers.get(x.id) || [];
  if (!list.length || list.some((p) => Math.abs(p.due - x.due) < NEAR)) return x.due;
  const n = new Map();
  for (const p of list) n.set(p.due, (n.get(p.due) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}
/**
 * В очередь бесед: list — [{ key, text?, remind?, url?, label?, test?, ttl?, covers?, until?, urgent?, silent? }] (silent —
 * только отметка «уже было»; remind — { title, short, due }: текст напоминания соберёт flush; label — подпись кнопки-ссылки,
 * по умолчанию «Открыть в Moodle»; covers — ключ напоминания, которое это сообщение заменяет (отметится, когда уйдёт);
 * until — после этого момента не отправлять; urgent — отправлять и ночью). chatIds — номера бесед; null — все беседы,
 * где tgId — источник. Возвращает номера бесед, где очередь пополнилась.
 */
function enqueue(chatIds, tgId, list, now = Date.now()) {
  return update((all) => {
    const hit = [];
    for (const [id, c] of Object.entries(all)) {
      if (!c || c.source == null || (chatIds ? !chatIds.includes(Number(id)) : c.source !== tgId)) continue;
      const r = relayState(c, now);
      let added = false;
      for (const m of list) {
        if (m.silent) { r.sent[m.key] ??= now; continue; }
        if (wasSent(r, m.key, m.ttl, now) || r.queue.some((q) => q.key === m.key)) continue;
        delete r.pendingDue[m.key];
        r.queue.push({ key: m.key, ...(m.remind ? { remind: m.remind } : { text: m.text }), url: m.url || null, ...(m.label ? { label: m.label } : {}), test: !!m.test, at: now, n: 0,
          ...(m.until ? { until: m.until } : {}), ...(m.urgent ? { urgent: true } : {}), ...(m.covers ? { covers: m.covers } : {}) });
        added = true;
      }
      if (r.queue.length > QUEUE_MAX) { console.log(`chats ${id}: очередь уведомлений длиннее ${QUEUE_MAX} — старые пропущены`); r.queue.splice(0, r.queue.length - QUEUE_MAX); }
      if (added) hit.push(Number(id));
    }
    return hit;
  });
}
const fmtLeft = (ms) => (ms < 2 * HOUR ? `${Math.max(1, Math.round(ms / MIN))} мин` : `${Math.round(ms / HOUR)} ч`);
/**
 * Общее сообщение источника (notify.relay): m — { key, text, x?, xs?, url?, courseIds?, courses?, covers?, ttl? }.
 * Отсекается всё, что не общее (см. выше), остальное — в очереди его бесед и сразу в отправку; «срок перенесли» — в
 * ожидание (pendingDue), его решит relayTick. Файл бесед не пишется, если пересылать некуда или всё уже было.
 */
async function relay(tgId, m) {
  const now = Date.now();
  const mine = Object.entries(await load()).filter(([, c]) => c?.source === tgId);
  if (!mine.length || mine.every(([, c]) => wasSent(c.relay, m.key, m.ttl, now) || queued(c.relay, m.key))) return;
  let courses = m.courses;
  if (!Array.isArray(courses)) { const token = await users.moodleToken(tgId).catch(() => null); courses = token ? moodle.staleDeadlines(token)?.courses : null; }
  const gen = generalCourses(courses);
  if (!gen) { console.log(`беседы: курсы источника ${tgId} не известны — «${m.key}» не пересылаю`); return; }
  const x = m.x;
  let text = m.text;
  if (m.xs) { // пачка «появилось сразу N»: только общие работы, текст заново
    const ok = m.xs.filter((y) => general(gen, y));
    if (!ok.length) return;
    text = `🆕 Появилось сразу ${ok.length} новых работ:\n${ok.slice(0, 5).map((y) => `• ${y.title}`).join("\n")}${ok.length > 5 ? `\n…и ещё ${ok.length - 5}` : ""}`;
  } else if (x ? !general(gen, x) : !(m.courseIds?.length && m.courseIds.every((id) => gen.has(id)))) return;
  // По беседам: у каждой свои одногруппники (группа беседы) — свой «общий» срок.
  for (const [id, c] of mine) {
    if (wasSent(c.relay, m.key, m.ttl, now) || queued(c.relay, m.key)) continue;
    let t = text, covers = null, until = null, urgent = /^open:/.test(m.key);
    if (x?.due) {
      if (/^due:/.test(m.key)) { // перенос срока — ждать одногруппников (relayTick)
        await update((all) => { const cc = all[id]; if (cc?.source !== tgId) return; relayState(cc, now).pendingDue[m.key] = { id: x.id, due: x.due, text, url: x.url || null, test: x.kind === "test", first: now, covers: [].concat(m.covers || []).includes(`${x.id}:day`) }; });
        continue;
      }
      const due = dueFor(await peerDues(await chatGroup(c), tgId, now), x);
      if (due !== x.due) t = t.split(notify.fmtTime(x.due)).join(notify.fmtTime(due)).replace(/\n⚠️ Осталось [^\n]*/, ""); // личный срок источника — в тексте общий
      else if ([].concat(m.covers || []).includes(`${x.id}:day`)) covers = remindKey(x.id, due);
      until = notify.effectiveDue(due);
      urgent ||= due - now < URGENT;
    }
    const ids = await enqueue([Number(id)], tgId, [{ key: m.key, text: t, url: x?.url || m.url, test: x?.kind === "test", ttl: m.ttl, covers, until, urgent }], now);
    for (const n of ids) void flush(n);
  }
}
notify.setRelay(relay, isSource);
/** Кнопки под уведомлением в беседе: ссылка на работу в Moodle (если есть) и личный чат с ботом. */
async function relayButtons(q) {
  return [...(q.url ? [[{ text: q.label || (q.test ? "Открыть тест в Moodle" : "Открыть в Moodle"), url: q.url }]] : []), ...(await mineRow())];
}
const mskHour = (t) => new Date(t + MSK).getUTCHours();
const mskMidnight = (t) => Math.floor((t + MSK) / DAY) * DAY - MSK;
// CHATS_QUIET=off — без ночной тишины (стенд: регрессия не должна зависеть от того, в котором часу её запустили).
const QUIET_OFF = process.env.CHATS_QUIET === "off";
const isNight = (t) => { const h = mskHour(t); return !QUIET_OFF && (h >= 23 || h < 8); };
/** Ночью (23:00–08:00 по Москве) беседу не будим: момент из ночи — в 22:00 того же вечера или в 8:00 утра. */
const QUIET = (t) => { const h = mskHour(t); return QUIET_OFF ? t : h >= 23 ? mskMidnight(t) + 22 * HOUR : h < 8 ? mskMidnight(t) + 8 * HOUR : t; };
/** Можно ли отправлять это сообщение сейчас: пауза после сбоя прошла, и не ночь (или оно срочное). */
const ready = (q, now) => !(q.next > now) && (!isNight(now) || q.urgent || (q.remind && q.remind.due - now < URGENT));
/** Текст напоминания о сроке — в момент отправки. */
function remindText(r, now) {
  const due = notify.effectiveDue(r.due), left = due - now;
  const when = notify.mskDay(due) === notify.mskDay(now) ? `Сегодня (через ~${fmtLeft(left)})` : notify.mskDay(due) === notify.mskDay(now + DAY) ? "Завтра" : `Через ~${fmtLeft(left)}`;
  return `⏰ ${when} срок: ${r.title}\n${r.short ?? ""} · до ${notify.fmtTime(r.due)}`;
}
const flushing = new Set(), flushAgain = new Set();
/**
 * Отправить очередь беседы (не больше PER_FLUSH за раз). Первая неудача — остальное в следующий обход. Повторы — как у
 * личных сообщений (см. выше).
 */
async function flush(chatId) {
  if (flushing.has(chatId)) { flushAgain.add(chatId); return 0; }
  flushing.add(chatId);
  let n = 0, cid = chatId;
  try {
    for (let i = 0; i < PER_FLUSH; i++) {
      const now = Date.now(), queue = (await load())[cid]?.relay?.queue || [];
      // Срок прошёл — слать поздно: отметка без отправки.
      const late = queue.filter((q) => q.until && now > q.until).map((q) => q.key);
      if (late.length) await update((all) => { const r = all[cid]?.relay; if (!r?.queue) return; r.queue = r.queue.filter((q) => !late.includes(q.key)); for (const k of late) r.sent[k] = now; });
      const q = queue.find((x) => !late.includes(x.key) && ready(x, now));
      if (!q) break;
      const { to, res } = await postRaw(cid, q.remind ? remindText(q.remind, now) : q.text, await relayButtons(q));
      if (to && to !== cid) { flushing.add(to); cid = to; } // беседа стала супергруппой — запись уже под новым номером
      const at = Date.now();
      await update((all) => {
        const r = all[cid]?.relay;
        if (!r || !Array.isArray(r.queue)) return; // беседу забыли (бота убрали) или уведомления выключили
        const k = r.queue.findIndex((x) => x.key === q.key);
        if (k < 0) return;
        const x = r.queue[k], done = (why) => {
          r.queue.splice(k, 1); r.sent[q.key] = at;
          if (!why && x.covers) r.sent[x.covers] ??= at; // заменённое напоминание — только если это сообщение дошло
          if (why) console.log(`chats ${cid}: «${q.key}» не ушло (${why}) — больше не повторяю`);
        };
        if (to) return done();
        if (res.status === "gone") return; // запись снята в postRaw
        if (res.status === "rejected") return done(`отказ: ${res.description.slice(0, 120)}`);
        x.first ??= at; // пределы — от первой неудачи, а не от постановки в очередь (сообщение могло ждать ночь)
        if (res.status === "unknown") { // Telegram мог и принять: один повтор, не больше — иначе вся беседа получит дубли
          if (x.unknown) return done("второй раз неизвестно, дошло ли");
          x.unknown = 1; x.next = at + MIN; return;
        }
        x.n = (x.n || 0) + 1;
        if ((x.n >= TRIES && at - x.first >= GIVE_UP_AFTER) || at - x.first >= DAY) return done(`${x.n} попыток за ${Math.round((at - x.first) / MIN)} мин`);
        x.next = at + (res.retryAfter ? res.retryAfter * 1000 + 250 : Math.min(GIVE_UP_AFTER, MIN * 2 ** (x.n - 1)));
      });
      if (!to) break;
      n++;
    }
  } catch (e) { console.log(`chats ${cid}: уведомления: ${e.message || e}`); }
  finally {
    flushing.delete(chatId); flushing.delete(cid);
    if (flushAgain.delete(chatId) || flushAgain.delete(cid)) void flush(cid);
  }
  return n;
}
/** Ключ напоминания за сутки: со сроком — срок перенесли, и напоминание по новому сроку придёт снова. */
const remindKey = (id, due) => `remind:${id}:${due}:day`;
/** Было ли напоминание по этой работе со сроком в пределах ±10 мин (срок «сдвинули на минуты» — второе не нужно). */
const remindedNear = (r, id, due) => Object.keys(r?.sent || {}).some((k) => { const m = /^remind:(.+):(\d+):day$/.exec(k); return !!m && m[1] === id && Math.abs(Number(m[2]) - due) < NEAR; })
  || !!r?.queue?.some?.((q) => q.covers === remindKey(id, due) || (q.remind && q.key.startsWith(`remind:${id}:`)));
/**
 * Напоминания за сутки по работам общих курсов источника — по сроку, сдал ли он работу, неважно; срок — dueFor. Работа, о
 * которой источнику ещё не сообщено «Новое …» (нет в его notify seen), подождёт: первым в беседу придёт «🆕».
 */
async function dueReminders(c, d, peers, now) {
  const gen = generalCourses(d?.courses);
  if (!gen) return [];
  const short = new Map((d.courses || []).map((x) => [x.id, x.short]));
  const seen = new Set((await notify.peekState(c.source).catch(() => ({}))).seen || []);
  const out = [];
  for (const it of d.items || []) {
    if (!/^moodle:/.test(String(it.id)) || !it.due || !general(gen, it) || !seen.has(it.id)) continue;
    // Перенос срока этой работы ждёт решения (pendingDue) — напоминание тоже подождёт: «📅 Срок перенесли» его заменит.
    if (Object.values(c.relay?.pendingDue || {}).some((p) => p.id === it.id)) continue;
    const dueAt = dueFor(peers, it), due = notify.effectiveDue(dueAt), left = due - now, key = remindKey(it.id, dueAt);
    // Ночью не собираем (кроме горящего срока): ушло бы утром и всё равно не раньше 8:00.
    if (left <= 0 || now < QUIET(due - DAY) || (isNight(now) && left >= URGENT) || remindedNear(c.relay, it.id, dueAt)) continue;
    out.push({ key, url: it.url, test: it.kind === "test", until: due, urgent: left < URGENT, remind: { title: it.title, short: short.get(it.courseId) ?? "", due: dueAt } });
  }
  return out.slice(0, 8); // после долгого простоя — не пачкой больше восьми за минуту
}
/**
 * Отложенные «срок перенесли» (relay.pendingDue): одногруппники с дедлайнами, прочитанными после того, как перенос увидел
 * источник, видят тот же срок — в беседу; видят прежний — это личное продление источника, не пишем; у них такой работы
 * нет — в беседу сразу; не дождались за PENDING_WAIT — в беседу.
 */
function pendingDecide(p, peers, now) {
  const list = peers.get(p.id) || [];
  if (!list.length) return "send";
  const fresh = list.filter((x) => x.at > p.first);
  if (fresh.some((x) => Math.abs(x.due - p.due) < NEAR)) return "send";
  if (fresh.length) return "drop";
  return now - p.first >= PENDING_WAIT ? "send" : "wait";
}
const addDays = (day, n) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * DAY).toISOString().slice(0, 10);
const examWord = (e) => (e.kind === "test" ? "зачёт" : e.kind === "consult" ? "консультация" : "экзамен");
/**
 * Экзамены группы беседы: расписание, когда вышло (самый новый файл с её группой), и напоминания накануне и в день.
 * В ключах — группа: беседу перепривязали к другой группе — её экзамены придут, хоть файл и тот же.
 */
async function examNotes(c, now) {
  if (!c.group) return [];
  const g = official.normGroup(c.group), sent = c.relay?.sent || {}, out = [], today = notify.mskDay(now);
  const files = (await session.files().catch(() => [])).filter((f) => f.parsed && f.groups.length && f.until);
  const marks = Object.fromEntries(Object.entries(sent).filter(([k]) => k.startsWith(`exams:${g}:`)).map(([k, v]) => [`exams:${k.slice(`exams:${g}:`.length)}`, v]));
  const late = admission.lateAnnounce(files, c.group, today, marks);
  for (const name of late.superseded) out.push({ key: `exams:${g}:${name}`, silent: true });
  const ex = await session.examsFor(c.group).catch(() => null);
  const list = (ex?.list || []).filter((e) => e.date && e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "").localeCompare(String(b.time || "")));
  if (late.file) {
    const key = `exams:${g}:${late.file.name}`;
    if (!list.length) out.push({ key, silent: true }); // всё уже прошло — сообщать нечего
    else out.push({ key, url: late.file.url, label: "Файл на misis.ru", text: `📅 Расписание экзаменов опубликовано${late.file.title ? ` («${late.file.title}»)` : ""}\nГруппа ${c.group}:\n${list.map((e) => `• ${admission.dayText(e.date)}${e.time ? `, ${e.time}` : ""} — ${e.name} (${examWord(e)})${e.place ? `, ${e.place}` : ""}`).join("\n")}\n\nНапомню здесь накануне и утром в день каждого экзамена и зачёта.` });
  }
  const p = new Date(now + MSK), h = p.getUTCHours(), hm = p.toISOString().slice(11, 16);
  for (const e of list) {
    if (e.kind === "consult") continue;
    let slot = null;
    if (today === addDays(e.date, -1) && h >= 18 && h < 22) slot = "eve";
    else if (today === e.date && h >= 7 && h < 11 && (!e.time || hm < e.time)) slot = "day";
    if (!slot) continue;
    const key = `exam:${g}:${e.date}:${e.name}:${slot}`;
    if (sent[key] != null) continue;
    const where = `${e.place ? ` · ${e.place}` : ""}${e.teacher ? ` · ${e.teacher}` : ""}`;
    // Окно напоминания кончилось (накануне — к 22:00, в день — к началу экзамена или к 11:00) — слать поздно.
    const until = slot === "eve" ? mskMidnight(now) + 22 * HOUR : e.time && /^\d\d:\d\d$/.test(e.time) ? mskMidnight(now) + (Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3))) * MIN : mskMidnight(now) + 11 * HOUR;
    out.push({ key, until, urgent: slot === "day", text: slot === "eve" ? `⏰ Завтра ${examWord(e)}: ${e.name}\n${admission.dayText(e.date, true)}${e.time ? `, ${e.time}` : ""}${where}`
      : `⏰ Сегодня ${examWord(e)}: ${e.name}${e.time ? ` в ${e.time}` : ""}${where}\nУдачи!` });
  }
  return out;
}
let relayBusy = false;
/**
 * Обход бесед с уведомлениями по курсам (сервер — раз в минуту): напоминания за сутки, отложенные переносы сроков,
 * экзамены, повтор не ушедшего. Источник вышел из Doodle — уведомления беседы выключаются (с сообщением в беседу).
 * Возвращает число отправленных сообщений. now — для стенда.
 */
export async function relayTick(now = Date.now()) {
  if (relayBusy) return 0;
  relayBusy = true;
  let n = 0;
  try {
    for (const [id, c] of Object.entries(await load())) {
      if (!c || c.source == null) continue;
      try {
        let token;
        try { token = await users.moodleToken(c.source); } catch { continue; } // файл пользователя сейчас не читается — в следующий раз
        if (!token) { await disable(Number(id), "logout"); continue; }
        const peers = await peerDues(await chatGroup(c), c.source, now);
        const add = [...await dueReminders(c, moodle.staleDeadlines(token), peers, now), ...await examNotes(c, now)];
        const drop = [];
        for (const [key, p] of Object.entries(c.relay?.pendingDue || {})) {
          const v = pendingDecide(p, peers, now);
          if (v === "wait") continue;
          if (v === "drop") { drop.push(key); console.log(`chats ${id}: «${key}» — личный срок источника, в беседу не пишу`); continue; }
          const due = notify.effectiveDue(p.due);
          add.push({ key, text: p.text, url: p.url, test: p.test, until: due, urgent: due - now < URGENT, covers: p.covers ? remindKey(p.id, p.due) : null });
        }
        if (drop.length) await update((all) => { const r = all[id]?.relay; if (!r?.pendingDue) return; for (const k of drop) { delete r.pendingDue[k]; r.sent[k] = now; } });
        if (add.length) await enqueue([Number(id)], c.source, add, now);
        if ((await load())[id]?.relay?.queue?.length) n += await flush(Number(id));
      } catch (e) { console.log(`chats ${id}: уведомления: ${e.message || e}`); }
    }
  } catch (e) { console.log(`chats: обход уведомлений прерван (${e.message || e})`); }
  finally { relayBusy = false; }
  return n;
}
