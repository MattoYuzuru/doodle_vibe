// Приветствие бота (просьба владельца, 5 окт 2026: «приветственное сообщение после /start… гифка или что-то интерактивное»).
//
// Что здесь есть:
//   1. Экран до нажатия Start — текст «Что умеет этот бот» (setProfile; гифку к нему ставит владелец в BotFather:
//      Bot API картинку описания менять не даёт).
//   2. Ответ на /start — ролик-гифка, пара строк и кнопки (sendWelcome).
//   3. Листаемые карточки «Что умеет Doodle» прямо в чате (кнопки «Дальше» / «Назад»).
//   4. Личное приветствие после входа в Moodle: сколько курсов и работ нашлось, какой срок ближайший (afterLogin).
//   5. Знакомство внутри приложения — на клиенте (web/src/components/Onboarding.tsx), сюда ведёт кнопка ?open=tour.
//
// Пункты 2 и 3 требуют, чтобы сообщения, написанные боту, получал этот сервер (watchUpdates). У бота может быть только
// один получатель, а сейчас это OpenClaw (чат владельца с агентом; посторонним он не отвечает). Поэтому приём выключен,
// пока владелец не перенесёт чат с агентом в другого бота или не выключит его: тогда — пустой файл bot-updates.on рядом
// с сервером или переменная BOT_UPDATES=1. Пока приём выключен, работают пункты 1, 4 и 5.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bots from "./bots.mjs";
import * as chats from "./chats.mjs";
import * as notify from "./notify.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(DIR, "assets", "welcome", "doodle-welcome.mp4"); // беззвучный ролик 640×360 (Telegram показывает его как гифку)
const MEDIA_ID = join(DIR, "welcome-media.json"); // номер ролика в Telegram: после первой отправки файл заново не загружается
const appUrl = () => readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const fmt = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
};

// --- тексты ---
export const DESCRIPTION = `Doodle — учёба в МИСИС без лишних вкладок.

• Дедлайны и оценки из Moodle на одном экране
• Расписание группы и изменения в нём
• Посещаемость и баллы из электронного журнала
• Напоминания о сроках, новых заданиях и тестах

⚠️ Ранний доступ: уведомления и другие функции пока могут работать с перебоями.

Нажмите «Старт», откройте приложение кнопкой внизу и войдите с учётной записью Moodle МИСИС.

Нажимая «Старт», вы соглашаетесь с условиями использования и политикой конфиденциальности: /terms и /privacy.`;
export const SHORT_DESCRIPTION = "Дедлайны, расписание, журнал и напоминания МИСИС — в одном приложении. Ранний доступ.";
const WELCOME = `👋 Привет! Это Doodle — учёба в МИСИС без лишних вкладок.

• дедлайны и оценки из Moodle
• расписание группы
• посещаемость и баллы из журнала
• напоминания о сроках, новых заданиях и тестах

Откройте приложение и войдите с учётной записью Moodle — дальше я буду напоминать сам.`;
const HOW = `Как войти

1. Нажмите «Открыть Doodle».
2. Введите логин и пароль Moodle МИСИС (те же, что на newlms.misis.ru).
3. Готово: дедлайны, расписание и журнал подтянутся сами.

Пароль хранится в зашифрованном виде — только чтобы электронный журнал не просил его снова. Выйти можно в любой момент: Профиль → «Выйти», пароль удалится.`;
/** Карточки «Что умеет Doodle»: листаются в одном сообщении кнопками «Дальше» и «Назад». */
export const TOUR = [
  `📋 Дедлайны · 1 из 4

Все задания и тесты из Moodle одним списком: что сдавать, до какого числа, что уже оценено. Оценки и замечания преподавателя — в карточке работы. Свои задачи и заметки можно добавить рядом.`,
  `🔔 Напоминания · 2 из 4

Я сам напишу: за сутки и за 3 часа до срока, когда появилось новое задание или тест, когда тест открылся и его можно проходить, когда пришла оценка или замечание преподавателя.`,
  `📊 Журнал и расписание · 3 из 4

Посещаемость и баллы из электронного журнала по каждому предмету. Расписание группы на неделю; если пару перенесли или отменили — сообщу.`,
  `📅 Календарь · 4 из 4

Пары и сроки можно добавить в календарь телефона: Профиль → «Календарь в телефоне». А что присылать в чат, настраивается в Профиле → «Уведомления бота».`,
];

const openButton = (app, text = "Открыть Doodle", open = "") => ({ text, web_app: { url: open ? `${app}/?open=${open}` : `${app}/` } });
/** Кнопки под карточкой n: «Назад», «Дальше», на последней — «Открыть Doodle». */
function tourButtons(n, app) {
  const row = [];
  if (n > 0) row.push({ text: "← Назад", callback_data: `tour:${n - 1}` });
  if (n < TOUR.length - 1) row.push({ text: "Дальше →", callback_data: `tour:${n + 1}` });
  return [row, ...(app && n === TOUR.length - 1 ? [[openButton(app)]] : [])].filter((r) => r.length);
}

/**
 * Приветствие: ролик-гифка с подписью и кнопками; ролика нет или он не ушёл — то же текстом. callbacks — сервер получает
 * нажатия кнопок (приём сообщений включён): «Что умеет» листает карточки в чате; иначе та же кнопка открывает
 * знакомство в приложении.
 */
export async function sendWelcome(tgId, { callbacks = false } = {}) {
  const app = await appUrl();
  const buttons = [
    app ? [openButton(app)] : [],
    callbacks ? [{ text: "Что умеет Doodle", callback_data: "tour:new" }, { text: "Как войти", callback_data: "how" }]
      : app ? [openButton(app, "Что умеет Doodle", "tour")] : [],
  ].filter((r) => r.length);
  const markup = buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
  if (existsSync(MEDIA)) {
    const known = await readFile(MEDIA_ID, "utf8").then(JSON.parse).catch(() => null);
    let r = known?.id ? await notify.tg("sendAnimation", { chat_id: tgId, animation: known.id, caption: WELCOME, ...markup }) : { ok: false };
    if (!r.ok) {
      const form = new FormData();
      form.set("chat_id", String(tgId));
      form.set("caption", WELCOME);
      form.set("width", "640"); form.set("height", "360");
      if (markup.reply_markup) form.set("reply_markup", JSON.stringify(markup.reply_markup));
      form.set("animation", new Blob([await readFile(MEDIA)], { type: "video/mp4" }), "doodle.mp4");
      r = await notify.tg("sendAnimation", form, { timeout: 120000 });
      const id = r.result?.animation?.file_id || r.result?.video?.file_id || r.result?.document?.file_id;
      if (r.ok && id) await writeFile(MEDIA_ID, JSON.stringify({ id, at: Date.now() })).catch(() => {});
    }
    if (r.ok) return true;
    console.error("welcome: ролик не отправлен:", r.description || "нет ответа");
  }
  return notify.send(tgId, WELCOME, undefined, buttons, { force: true });
}

// --- личное приветствие после входа ---
const justLoggedIn = new Map(); // tgId → когда вошёл (до первого удачного чтения дедлайнов)
/** Пользователь только что вошёл в Moodle: после первого чтения дедлайнов ему уйдёт личное приветствие. */
export function noteLogin(tgId) { justLoggedIn.set(tgId, Date.now()); }
/**
 * Личное приветствие: один раз на пользователя, после входа и первого чтения дедлайнов (d — уже прочитанные данные,
 * лишних запросов к Moodle нет). name() отдаёт { fullName, tgName }. Тем, кто вошёл до появления приветствия, оно не
 * приходит: отметка о входе ставится только самим входом.
 */
export async function afterLogin(tgId, d, name) {
  const at = justLoggedIn.get(tgId);
  if (!at || !d?.items || d.stale) return false;
  justLoggedIn.delete(tgId);
  if (Date.now() - at > 30 * 60e3) return false;
  const first = await notify.withState(tgId, (state) => { state.welcome ??= {}; if (state.welcome.login) return false; state.welcome.login = Date.now(); return true; });
  if (!first) return false;
  const who = await Promise.resolve().then(name).catch(() => null);
  const firstName = String(who?.fullName || "").trim().split(/\s+/)[1] || who?.tgName || ""; // «Фамилия Имя Отчество» → имя
  const now = Date.now();
  const ahead = d.items.filter((x) => x.status === "open" && x.due > now).sort((a, b) => a.due - b.due);
  const next = ahead[0];
  const course = next ? d.courses.find((c) => c.id === next.courseId)?.short : null;
  const text = `✅ ${firstName ? `${firstName}, вход` : "Вход"} выполнен — Doodle подключён к вашему Moodle.

Курсов этого семестра: ${d.courses.length}. Работ со сроком впереди: ${ahead.length}.${next ? `\nБлижайший срок: ${next.title}${course ? ` (${course})` : ""} — до ${fmt(next.due)}.` : ""}

Дальше я сам напомню о сроках и напишу о новых заданиях, тестах, оценках и замечаниях преподавателя. Что именно присылать — Профиль → «Уведомления бота».`;
  const app = await appUrl();
  const ok = await notify.send(tgId, text, undefined, app ? [[openButton(app)]] : undefined);
  // Не ушло (человек не нажал Start у бота) — отметку снимаем: приветствие придёт при следующем входе.
  if (ok !== true) await notify.withState(tgId, (state) => { if (state.welcome) delete state.welcome.login; });
  return ok === true;
}

// --- экран до Start ---
/** Текст «Что умеет этот бот» и короткое описание в профиле бота. Гифку описания ставит владелец в BotFather. */
export async function setProfile() {
  const a = await notify.tg("setMyDescription", { description: DESCRIPTION });
  const b = await notify.tg("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
  return { description: a.ok === true, short: b.ok === true, error: a.description || b.description || null };
}

// --- приём сообщений бота ---
const hinted = new Map(); // чат → когда последний раз подсказывали (не чаще раза в 10 минут)
// Задаёт сервер в watchUpdates: commands(tgId, команда) → { text, buttons } или null; callbacks(tgId, данные кнопки) → то же
// (сообщение с кнопкой правится на месте); onStart(tgId, хвост ссылки) — первый Start и приглашения.
let commands = null, callbacks = null, onStart = null;
async function handle(u) {
  // Общие беседы (chats.mjs): бота добавили или убрали; команды и служебные сообщения из беседы.
  if (u.my_chat_member) return chats.onMember(u.my_chat_member);
  if (u.message && /^(group|supergroup)$/.test(u.message.chat?.type || "")) return chats.onMessage(u.message);
  const cb = u.callback_query;
  if (cb) {
    const chat = cb.message?.chat?.id, data = String(cb.data || ""), app = await appUrl();
    if (chat && cb.message?.chat?.type === "private") {
      const t = /^tour:(new|\d+)$/.exec(data);
      if (t) {
        const n = t[1] === "new" ? 0 : Math.min(Number(t[1]), TOUR.length - 1);
        const body = { chat_id: chat, text: TOUR[n], reply_markup: { inline_keyboard: tourButtons(n, app) } };
        // Из приветствия — новое сообщение с первой карточкой; внутри карточек — правка того же сообщения.
        if (t[1] === "new") await notify.tg("sendMessage", body);
        else await notify.tg("editMessageText", { ...body, message_id: cb.message.message_id });
      } else if (data === "how") await notify.send(chat, HOW, undefined, app ? [[openButton(app)]] : undefined, { force: true });
      else if (/^chatoff:-?\d{1,20}$/.test(data)) {
        // «Отключить мои курсы от беседы» под сообщением о подключении (chats.tellSource): выключить может только сам источник.
        const view = await chats.sourceOff(cb.from?.id ?? chat, Number(data.slice(8))).catch(() => null);
        if (view) await notify.tg("editMessageText", { chat_id: chat, message_id: cb.message.message_id, text: view.text });
      } else {
        const view = callbacks ? await callbacks(chat, data).catch(() => null) : null;
        if (view) await notify.tg("editMessageText", { chat_id: chat, message_id: cb.message.message_id, text: view.text, reply_markup: { inline_keyboard: view.buttons || [] } });
      }
    }
    await notify.tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  const m = u.message;
  if (!m || m.chat?.type !== "private" || !m.from || m.from.is_bot) return;
  const text = String(m.text || "").trim();
  if (/^\/start(\s|@|$)/.test(text)) {
    const payload = text.split(/\s+/)[1] || "";
    let first = true;
    try { first = onStart?.(m.chat.id, payload) !== false; } catch { /* статистика не должна мешать приветствию */ }
    // Ссылка из беседы в старых сообщениях (…?start=chat): тот, кто уже нажимал Start, хотел просто открыть чат —
    // Telegram сам шлёт «/start chat», приветствие повторно не шлём (16 окт 2026, владелец: «если уже нажал на старт —
    // ничего не отправляется»). Первый Start по этой ссылке — обычное приветствие.
    if (payload === "chat" && (!first || (await notify.peekState(m.chat.id).catch(() => ({}))).welcome?.start)) return;
    await sendWelcome(m.chat.id, { callbacks: true });
    await notify.withState(m.chat.id, (state) => { (state.welcome ??= {}).start = Date.now(); }).catch(() => {});
    return;
  }
  // Быстрые команды (/today, /deadlines, /grades): ответ собирает сервер из уже загруженных данных (bot-commands.mjs).
  const cmd = /^\/([a-z_]+)(@\w+)?(\s|$)/i.exec(text)?.[1]?.toLowerCase();
  const reply = cmd && commands ? await commands(m.chat.id, cmd) : null;
  if (reply) { const app = await appUrl(); await notify.send(m.chat.id, reply.text, undefined, [...(reply.buttons || []), ...(app ? [[openButton(app)]] : [])], { force: true }); return; }
  if (/^\/help(\s|@|$)/.test(text)) { await notify.send(m.chat.id, HOW, undefined, [[{ text: "Что умеет Doodle", callback_data: "tour:new" }]], { force: true }); return; }
  // Любое другое сообщение: бот не переписывается — раз в 10 минут подсказываем, где приложение.
  if (Date.now() - (hinted.get(m.chat.id) || 0) < 10 * 60e3) return;
  hinted.set(m.chat.id, Date.now());
  const app = await appUrl();
  await notify.send(m.chat.id, "Я бот Doodle: присылаю напоминания и открываю приложение. На сообщения в чате не отвечаю — всё остальное внутри приложения.", undefined,
    [app ? [openButton(app)] : [], [{ text: "Что умеет Doodle", callback_data: "tour:new" }]].filter((r) => r.length), { force: true });
}
/**
 * Приём сообщений, написанных боту (getUpdates). Включается файлом bot-updates.on или BOT_UPDATES=1 — только когда у бота
 * нет другого получателя. Если Telegram отвечает «конфликт» (сообщения забирает другая программа), сервер пишет об этом
 * в журнал и пробует раз в минуту, никому не мешая.
 */
export function watchUpdates({ log = console.log, onCommand = null, onCallback = null, onFirstStart = null, menu = [] } = {}) {
  if (!bots.ownBot()) return false;
  commands = onCommand; callbacks = onCallback; onStart = onFirstStart;
  // Список команд в меню бота — при каждом запуске (дёшево и не расходится с кодом).
  void notify.tg("setMyCommands", { commands: [...menu, { command: "help", description: "Как войти и что умеет Doodle" }, { command: "start", description: "Приветствие и кнопка приложения" }] });
  // В беседах — своё меню: только общее для группы (chats.mjs).
  void notify.tg("setMyCommands", { scope: { type: "all_group_chats" }, commands: chats.MENU });
  // Меню админов (scope all_chat_administrators) ставилось 16 окт 2026 и отменено в тот же день — убрать, если осталось.
  void notify.tg("deleteMyCommands", { scope: { type: "all_chat_administrators" } });
  let offset = 0, conflict = false;
  (async () => {
    log("welcome: приём сообщений бота включён (ответ на /start, карточки «Что умеет Doodle»)");
    for (;;) {
      const r = await notify.tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member"] }, { timeout: 40000 });
      if (!r.ok) {
        const busy = /conflict|terminated by other/i.test(String(r.description || ""));
        if (busy && !conflict) log("welcome: сообщения бота забирает другая программа (OpenClaw?) — ответ на /start работать не будет, пока она подключена к этому боту");
        conflict = busy;
        await sleep(busy ? 60e3 : 5e3);
        continue;
      }
      conflict = false;
      const list = Array.isArray(r.result) ? r.result : [];
      for (const u of list) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        try { await handle(u); } catch (e) { log(`welcome: ${e.message || e}`); }
      }
      if (!list.length) await sleep(1000);
    }
  })();
  return true;
}
