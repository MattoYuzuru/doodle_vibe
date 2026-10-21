// Напоминания и уведомления в Telegram (через `openclaw message send`, модель не нужна), по каждому пользователю.
// Каждые 15 минут server.mjs вызывает check(tgId, items, courses): новые работы (внезапные тесты), напоминания за сутки и за 3 часа по настройкам
// пользователя, новые оценки из Moodle. Что уже отправлено — в notify/<tgId>.json, чтобы не дублировать.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bots from "./bots.mjs";
import * as botStats from "./bot-stats.mjs";
import { readJson, writeJsonAtomic } from "./state-file.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(DIR, "notify");
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const HOUR = 3600e3, DAY = 24 * HOUR;
const DEFAULT_REMINDER = "day";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const fmt = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
};
/** Календарный день по Москве: «2026-10-15». */
const mskDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date(ms));
// Срок 00:00 показываем как 23:59 накануне (как в приложении).
const effective = (ms) => { const p = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)); return p === "00:00" ? ms - 60e3 : ms; };

/** Адрес мини-приложения (пишет tunnel-url.mjs); нужен для кнопки «В Джарвисе». */
const appUrl = () => readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
/** Кнопка «Открыть лабу» под сообщением бота: мини-приложение откроется сразу на чате этой лабораторной. */
export const labButton = (assignId) => appButton("Открыть лабу в Doodle", `lab:${assignId}`);
/** Кнопка, открывающая мини-приложение на нужном экране (?open=…, см. App.tsx). */
export async function appButton(text, open) {
  const app = await appUrl();
  return app ? [[{ text, web_app: { url: `${app}/?open=${open}` } }]] : undefined;
}

/*
 * Пересылка в беседы (16 окт 2026, владелец: «уведомления на тесты, появление новых материалов, контрольные… у старосты,
 * кроме пересдач и задолженностей, будут отображаться в общем чате»). Обработчик ставит chats.mjs при загрузке (так нет
 * круговых импортов): relay(tgId, m) — общее сообщение человека (новая работа или тест, «тест открыт», объявление,
 * материал) уходит и в беседы, где он источник уведомлений. Личное (оценки, замечания, пропуски, сессия, лабы) сюда не
 * передаётся. Пересылка не зависит от /stop и настроек самого человека — у беседы свой выключатель (/notify off).
 * m: { key, text, url?, x?, covers?, ttl? } — key: по нему беседа не получит одно и то же дважды.
 */
let relayTo = null, relaySource = null;
export function setRelay(fn, isSource) { relayTo = fn; relaySource = isSource; }
export async function relay(tgId, m) {
  if (!relayTo) return;
  try { await relayTo(Number(tgId), m); } catch (e) { console.log(`беседы: пересылка от ${tgId} не записана (${e.message || e})`); }
}
/** Пересылает ли человек свои общие уведомления в какую-нибудь беседу (сообщения тогда собираются и при выключенных у него). */
export async function isRelaySource(tgId) {
  try { return !!(relaySource && await relaySource(Number(tgId))); } catch { return false; }
}
// Общие сообщения проверок этого модуля, которые идут и в беседу: новые работы и тесты, «тест открыт», «срок изменён».
const RELAYED = /^(new|open|due):/;
/** Короткий отпечаток строки (для ключей пересылки): «a1b2c3d». */
export const hashOf = (s) => { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); };
/** Время «12 окт, 23:59», срок с поправкой «00:00 → 23:59 накануне», день по Москве — для текстов беседы (chats.mjs). */
export { effective as effectiveDue, fmt as fmtTime, mskDay };

/**
 * Прямой вызов Bot API для того, чего нет в send (ролик-гифка, правка сообщения, ответ на нажатие кнопки, описание бота,
 * приём сообщений): body — объект или FormData. Возвращает ответ Telegram { ok, result, description }; сбой сети — ok: false.
 */
export const tg = (method, body, opts) => bots.call(method, body, opts);

// Telegram не даёт боту писать человеку: тот не нажимал Start, заблокировал бота или чата нет.
const unreachable = (r) => r.error_code === 403 || /can't initiate|chat not found|bot was blocked|user is deactivated|PEER_ID_INVALID/i.test(String(r.description || ""));
/*
 * Telegram ограничивает частоту (около 30 сообщений в секунду на бота, около одного в секунду в один чат): лишнее получает
 * отказ 429 с parameters.retry_after. Раньше такое сообщение терялось молча — отметка «отправлено» к этому времени уже
 * стоит (проверка нагрузки 15 окт 2026). Короткую паузу выжидаем и повторяем один раз; долгую (бот под ограничением) не
 * ждём, чтобы обход остальных пользователей не стоял.
 */
const RETRY_AFTER_MAX_S = 10;
async function callTg(method, body, opts) {
  const r = await bots.call(method, body, opts);
  const wait = Number(r?.parameters?.retry_after);
  if (r.ok || r.error_code !== 429 || !(wait > 0 && wait <= RETRY_AFTER_MAX_S)) return r;
  await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 250));
  return bots.call(method, body, opts);
}
/*
 * Чем кончилась отправка (15 окт 2026, баг «отметка „отправлено“ ставится до отправки»). Раньше send отвечал только
 * true/false, и места, которые запоминают «уже отправлено» (напоминания, «Новый тест», оценки, «Тест открыт», экзамены…),
 * не могли отличить «не дойдёт никогда» (повторять незачем) от временного сбоя (повторить) и от «неизвестно, может, и
 * дошло» (повтор даст дубль) — отметку ставили заранее, и сообщение, не ушедшее из-за сети или 5xx, терялось навсегда.
 * Статусы (deliver):
 *   sent — дошло; muted — человек выключил сообщения (/stop): считается обработанным;
 *   unreachable — 403, «chat not found» и т. п.: человек боту недоступен; rejected — другой отказ 4xx (текст слишком
 *     длинный, неверная кнопка): повтор того же сообщения бессмыслен;
 *   limited — 429 и после повтора callTg или долгая пауза; failed — 5xx, ответ не JSON, нет токена или токен отклонён
 *     (401/404), не прочитался файл вложения, соединение не установилось (нет сети, DNS, отказ в соединении), OpenClaw
 *     с ошибкой: точно не дошло, можно повторить;
 *   unknown — обрыв или таймаут уже установленного соединения: Telegram мог и принять сообщение; partial — длинный
 *     текст ушёл, а документ нет.
 * ok — sent | muted; retryable — limited | failed | unknown; maybe — unknown | partial (повтор может продублировать).
 * down — сбой не этого сообщения, а связи с Telegram или самого бота (unknown, limited, failed из-за сети или 401/404):
 *   остальные сообщения того же прохода не пробовать (sendOut и обходы admission), см. ниже.
 */
const RETRYABLE = new Set(["limited", "failed", "unknown"]);
/*
 * Ошибки сети, при которых запрос до Telegram точно не ушёл (15 окт 2026): соединение не установлено — адрес не найден
 * (DNS, сеть ещё не поднялась после сна), отказ в соединении, сеть или узел недоступны, таймаут подключения undici.
 * Это «failed» (повторить), а не «unknown»: раньше такой сбой считался «могло и дойти», и утренняя сводка (там
 * неоднозначный исход считается отправленным) пропадала как раз тогда, когда сети не было вовсе. Обрыв (ECONNRESET,
 * UND_ERR_SOCKET) и таймаут ответа остаются «unknown»: соединение было, тело запроса могло уйти. Тот же список —
 * NO_CONNECT в users.mjs.
 */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);
// Бот или токен, а не сообщение: 401 — токен отозван или заменён (перевыпуск в BotFather, переезд бота), 404 — битый
// токен. Раньше это был «rejected» (4xx: повтор бессмыслен), и при сломанном токене все «⏰», «🆕», «📅» отмечались
// отправленными и не повторялись уже после починки (15 окт 2026). Теперь «failed»: повторы по обычным правилам.
const botBroken = (r) => r.error_code === 401 || r.error_code === 404;
const outcome = (status, r = {}) => ({ status, ok: status === "sent" || status === "muted", retryable: RETRYABLE.has(status), maybe: status === "unknown" || status === "partial",
  down: status === "unknown" || status === "limited" || (status === "failed" && (!!r.network || botBroken(r))),
  description: String(r.description || "") + (r.code ? ` (${r.code})` : ""), retryAfter: Number(r.parameters?.retry_after) || 0 });
/** Ответ Bot API → статус. 429 сюда доходит, только если callTg уже повторил или пауза слишком долгая. */
function statusOf(r) {
  if (r.ok) return "sent";
  if (r.network) return NOT_SENT.has(r.code) ? "failed" : "unknown"; // соединения не было — точно не ушло; иначе мог потеряться только ответ
  if (botBroken(r)) return "failed";
  if (unreachable(r)) return "unreachable";
  if (r.error_code === 429) return "limited";
  return r.error_code >= 400 && r.error_code < 500 ? "rejected" : "failed"; // 5xx, «HTTP 502» без JSON, нет токена, локальная ошибка
}
/** Ответ Bot API (bots.call) → итог отправки, как у deliver: для бесед (chats.mjs), у которых своя отправка. */
export const resultOf = (r) => outcome(statusOf(r), r);
/** Одна отправка через Bot API → { status, ok, retryable, maybe, description, retryAfter }. */
async function sendVia(tgId, text, media, buttons) {
  const markup = buttons?.length ? { inline_keyboard: buttons } : null;
  let r;
  if (media) {
    let first = null;
    try {
      const form = new FormData();
      form.set("chat_id", String(tgId));
      // Подпись к документу — до 1024 знаков; длинный текст уходит отдельным сообщением перед файлом.
      if (text.length <= 1024) { form.set("caption", text); if (markup) form.set("reply_markup", JSON.stringify(markup)); }
      else { first = await sendVia(tgId, text, undefined, buttons); if (first.status !== "sent") return first; }
      form.set("document", new Blob([await readFile(media)], { type: "application/pdf" }), basename(media));
      r = await callTg("sendDocument", form, { timeout: 120000 });
    } catch (e) { r = { ok: false, description: e.message }; }
    // Текст уже дошёл отдельным сообщением, а документ нет: повтор целиком продублировал бы текст.
    if (first && !r.ok) { console.error("telegram sendDocument:", r.description || "нет ответа", "(текст ушёл отдельно)"); return outcome("partial", r); }
  } else {
    r = await callTg("sendMessage", { chat_id: tgId, text, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  }
  const status = statusOf(r);
  if (status !== "sent" && status !== "unreachable") console.error(`telegram ${media ? "sendDocument" : "sendMessage"}:`, ...[r.description || "нет ответа", r.code && `(${r.code})`,
    botBroken(r) && "— токен бота отклонён: проверьте bot-token.txt, сообщения не уходят"].filter(Boolean));
  return outcome(status, r);
}

/**
 * Отправка без проверки /stop: её делает deliver или проверки этого модуля по уже прочитанному под замком состоянию.
 * И текст, и вложение (media — путь к файлу, уходит документом) идут напрямую в Bot API. Раньше вложение отправлялось
 * через `openclaw message send --media`, а OpenClaw не отдаёт файлы вне своих разрешённых папок: 1 окт 2026 отчёты
 * других пользователей (moodle-work\users\…) в Telegram не дошли («Local media path is not under an allowed directory»).
 * openclaw остаётся запасным путём — пока этим же ботом пользуется и OpenClaw, и только при сбое, который мог быть
 * временным (failed, limited): человеку, недоступному боту, и отказу 4xx тот же бот через OpenClaw не поможет, а ждать
 * его до минуты. После переезда на своего бота (bots.ownBot) запасного пути нет: у OpenClaw бот другой.
 */
async function transmit(tgId, text, media, buttons) {
  let r = null;
  if (bots.hasBot) {
    r = await sendVia(tgId, text, media, buttons);
    if (r.status === "sent") { botStats.note("sent"); return r; }
    if (bots.ownBot() || (r.status !== "failed" && r.status !== "limited")) return r;
  }
  const code = await new Promise((resolve) => {
    const args = [OPENCLAW, "message", "send", "--channel", "telegram", "--target", String(tgId), "-m", text];
    if (media) args.push("--media", media, "--force-document");
    const p = spawn(process.execPath, args, { windowsHide: true });
    let killed = false;
    const t = setTimeout(() => { killed = true; p.kill(); }, 60e3);
    p.on("close", (c) => { clearTimeout(t); resolve(killed ? "timeout" : c); });
    p.on("error", () => { clearTimeout(t); resolve("error"); });
  });
  if (code === 0) return outcome("sent");
  if (code === "timeout") return outcome("unknown", { description: "openclaw: не ответил за 60 с" }); // убит по таймауту — могло и уйти
  return r || outcome("failed", { description: `openclaw: ${code === "error" ? "не запустился" : `код ${code}`}` });
}

/**
 * Сообщение пользователю в Telegram с подробным итогом (статусы — выше). Бот может писать только тем, кто хоть раз
 * нажал Start. buttons — inline-кнопки Bot API (массив рядов). Никогда не бросает.
 */
export async function deliver(tgId, text, media, buttons, { force = false } = {}) {
  // Человек выключил все сообщения бота (/stop): уведомление считается обработанным и не копится на потом.
  // force — ответ на его собственную команду или нажатие: такие сообщения приходят всегда.
  if (!force) {
    let muted = false;
    // Файл состояния сейчас не читается (занят дольше ~0,8 с: антивирус, чужой процесс) — неизвестно, не выключил ли
    // человек сообщения. Отправляем всё равно, одной строкой в журнал (15 окт 2026). Сначала здесь было «не пишем,
    // failed — вызывающий повторит», но повторяют не все: отчёт лабы с PDF, тревоги владельцу (пауза Moodle, копия)
    // и другие разовые сообщения терялись насовсем. Потерять их хуже, чем изредка написать человеку после /stop, пока
    // его файл кем-то занят. Проверки этого модуля (sendOut) берут /stop из уже прочитанного под замком состояния и
    // сюда не попадают; не читается сам файл — они отказывают целиком и ничего не шлют.
    try { muted = await isMuted(tgId); }
    catch (e) { console.error(`notify ${tgId}: не прочитано, выключены ли сообщения (${e.message || e}) — отправляю всё равно`); }
    if (muted) return outcome("muted");
  }
  return transmit(tgId, text, media, buttons);
}
/** То же, что deliver, ответом true/false, как раньше: true — дошло или человек выключил сообщения (/stop), false — нет. */
export async function send(tgId, text, media, buttons, opts) { return (await deliver(tgId, text, media, buttons, opts)).ok; }
/**
 * Ставить ли отметку «отправлено»: сообщение дошло или не дойдёт никогда (повторять незачем). dupOk = false — там, где
 * дубль хуже потери (утренняя сводка): неоднозначный исход (unknown) тоже считается отправленным.
 */
export const settled = (r, { dupOk = true } = {}) => !r.retryable || (r.maybe && !dupOk);

/*
 * Сколько повторять не ушедшее сообщение: state.retry[key] = { n, first, last, unknown? } — неудачных попыток, время
 * первой и последней, был ли уже неоднозначный исход. Отметка ставится всё равно (с записью в журнал), когда:
 *   - попыток не меньше RETRY_MAX И с первой неудачи прошло не меньше RETRY_MIN (30 мин). Одного счётчика мало
 *     (15 окт 2026): «Тест открыт» повторяется каждые 2 минуты, материалы — раз в ~50 с, «Новый тест» — с каждым
 *     быстрым опросом, и шесть попыток набирались за 5–20 минут — обрыв VPN на четверть часа съедал сообщение навсегда;
 *   - или с первой неудачи прошли сутки (RETRY_FOR) — постоянная ошибка не крутится вечно;
 *   - или исход второй раз «unknown» (обрыв или таймаут после отправки: Telegram мог принять). После первого такого
 *     исхода повтор один — «иногда один дубль»; раньше unknown повторялся до шести раз, и при медленном Telegram
 *     приходило до шести одинаковых «⏰», «🟢 Тест открыт», «📅» (у «Сессии» — до конца окна или суток).
 * Эпизод: запись, в которой RETRY_GAP (2 ч) не было ни одной неудачи, — от прежнего сбоя (сообщение перестало
 * собираться: пропуск сняли, изменение расписания отменили, материал скрыли — а ключ «journal», «schedule», «mat:<курс>»
 * переиспользуется). Новая неудача начинает счёт заново: раньше остаток старого эпизода (n, first старше суток)
 * исчерпывал попытки с первой же неудачи нового, и сообщение терялось без единого повтора. Запись с первой неудачей
 * старше суток доживает до новой неудачи только так — внутри одного эпизода с шагом меньше 2 ч шесть попыток и 30 минут
 * набираются раньше. Дошло или окончательно не дойдёт — запись убирает вызывающий (retryClear); забытые чистит check.
 * Пропуски предохранителя (sendOut, обходы admission после «Telegram недоступен») сюда не попадают: попыткой они не
 * считаются.
 */
const RETRY_MAX = 6, RETRY_MIN = 30 * 60e3, RETRY_FOR = DAY, RETRY_GAP = 2 * HOUR;
/** Запись попыток от прежнего, закончившегося эпизода сбоев (или испорченная): новая неудача начинает счёт заново. */
const retryStale = (t, now) => !(now - (t.last ?? t.first) < RETRY_GAP);
/**
 * Ещё одна неудачная попытка по key; true — попытки кончились, отметку пора поставить всё равно. min, ms — пороги по
 * времени (для «Сессии», где повторы ограничивает окно, — Infinity: остаётся только правило «unknown один раз»).
 */
export function retryExhausted(state, key, r, { max = RETRY_MAX, min = RETRY_MIN, ms = RETRY_FOR, now = Date.now() } = {}) {
  if (!state.retry || typeof state.retry !== "object") state.retry = {};
  const retry = state.retry;
  let t = retry[key];
  if (!t || typeof t !== "object" || retryStale(t, now)) t = retry[key] = { n: 0, first: now };
  t.n++;
  t.last = now;
  let why = null;
  if (r.status === "unknown") { if (t.unknown) why = "второй неизвестный исход — повтор мог бы продублировать"; else t.unknown = 1; }
  if (!why && t.n >= max && now - t.first >= min) why = `попыток: ${t.n} за ${Math.round((now - t.first) / 60e3)} мин`;
  if (!why && now - t.first >= ms) why = `попыток: ${t.n} за сутки с первой неудачи`;
  if (!why) return false;
  console.error(`notify: «${key}» не ушло: ${why} (${r.status}${r.description ? `: ${r.description.slice(0, 160)}` : ""}) — больше не повторяю`);
  retryClear(state, key);
  return true;
}
/** Сообщение дошло (или окончательно не дойдёт) — счётчик попыток больше не нужен. */
export function retryClear(state, key) {
  if (!state.retry || typeof state.retry !== "object" || !Object.hasOwn(state.retry, key)) return; // и испорченная запись (null) — тоже прочь
  delete state.retry[key];
  if (!Object.keys(state.retry).length) delete state.retry;
}
/**
 * Разослать подготовленные сообщения по порядку — под замком пользователя, state уже прочитан. Отметку сообщения
 * (m.mark) ставим, только когда оно дошло или не дойдёт никогда, и сразу сохраняем: если процесс убьют посреди рассылки,
 * уже ушедшие не повторятся. Временный сбой — отметки нет, следующая проверка повторит. m: { key, text, x?, buttons?,
 * mark }; кнопки по умолчанию — buttonsFor(m.x). /stop — по тому же state, без второго чтения файла. Возвращает число дошедших.
 * Предохранитель (15 окт 2026): после исхода «down» (Telegram не отвечает или висит, 429, токен отклонён — см. outcome)
 * остаток списка в этом проходе не пробуем. Раньше каждое следующее сообщение тоже ждало таймаут (до 20 с) под замком
 * пользователя — при зависшем Telegram проход тянулся минутами, а /stop и настройки этого человека ждали. Пропущенные
 * остаются без отметки и без засчитанной попытки — следующий проход начнёт с них.
 */
async function sendOut(tgId, state, out, courses = null) {
  let n = 0;
  for (const m of out) {
    // В беседу — раньше личной отправки и независимо от /stop; повтор того же сообщения беседа отсечёт по ключу.
    // courses — курсы из той же проверки (с признаками auto, debt): беседа решает «общее ли» и тогда, когда кэш дедлайнов
    // источника пуст (сдал работу, сменил курсы, перезапуск) — иначе сообщение для неё терялось бы.
    if (RELAYED.test(m.key)) await relay(tgId, { key: m.relayKey || m.key, text: m.relayText ?? m.text, x: m.x, xs: m.xs, covers: m.covers, courseIds: m.courseIds, courses });
    // Собрано только для беседы (у самого человека это сообщение не нужно — например, срок сданной работы): отметка без отправки.
    if (m.quiet) { m.mark?.(state); retryClear(state, m.key); await saveState(tgId, state); continue; }
    const r = state.muted === true ? outcome("muted") : await transmit(tgId, m.text, undefined, "buttons" in m ? m.buttons : await buttonsFor(m.x));
    if (settled(r) || retryExhausted(state, m.key, r)) { m.mark?.(state); retryClear(state, m.key); if (r.ok) n++; }
    await saveState(tgId, state);
    if (r.down) {
      const left = out.length - out.indexOf(m) - 1;
      if (left) console.error(`notify ${tgId}: Telegram сейчас недоступен (${r.status}) — ещё ${left} сообщ. повторю в следующей проверке`);
      break;
    }
  }
  return n;
}

const stateFile = (tgId) => join(STATE_DIR, `${tgId}.json`);
/*
 * Поля по умолчанию добавляем и к прочитанному файлу: запись старого формата без grades/sent роняла всю проверку пользователя.
 * Чтение — через state-file (15 окт 2026): «файла нет» — только ENOENT. Занятый файл (антивирус, ежедневная копия, чужой
 * rename) читается повторно, а если не вышло — StateReadError: проверка этого пользователя бросает (обход запишет в журнал
 * и повторит), и НИЧЕГО не пишется. Раньше любая ошибка чтения давала пустое состояние, и следующая запись затирала /stop,
 * настройки напоминаний, отметки «отправлено», виденные работы — человеку снова писали после /stop, приходили повторные
 * «⏰». Испорченный JSON откладывается в .bad-* и дальше — как у нового пользователя (первая проверка только запоминает).
 */
async function loadState(tgId) {
  const s = await readJson(stateFile(tgId), { missing: () => ({}) });
  return { sent: {}, grades: {}, prefs: {}, ...(s && typeof s === "object" && !Array.isArray(s) ? s : {}) };
}
// Полная проверка (15 мин) и быстрый опрос (2 мин) могут совпасть по времени: оба читают и пишут один файл состояния,
// и поздний писал бы поверх раннего (потерянные «виденные» → повторное «Новый тест»). Поэтому на пользователя — очередь.
const locks = new Map();
function withLock(tgId, fn) {
  const next = (locks.get(tgId) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(tgId, next);
  next.finally(() => { if (locks.get(tgId) === next) locks.delete(tgId); }).catch(() => {});
  return next;
}
// Пишем во временный файл и переименовываем: при нехватке места (ENOSPC) прежний файл остаётся целым, а не пустым.
// Пустой файл состояния однажды превратился в 22 «новых задания» — после сброса список «виденного» заполнялся заново.
// На Windows переименование иногда отказывает (EPERM/EACCES/EBUSY): свежий файл на миг держит антивирус или чтение.
// 15 окт 2026 на стенде так потерялось «включить все сообщения» — пользователь остался выключенным и не получил
// расписание экзаменов. Несколько коротких повторов. Временный файл — свой на каждую запись (state-file.writeJsonAtomic):
// с общим «.tmp» две записи подряд могли переименовать недописанный чужой файл.
async function saveState(tgId, s) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeJsonAtomic(stateFile(tgId), s, { space: 2 });
}

/**
 * Отзыв согласия (21 окт 2026): состояние уведомлений (оценки, пропуски, расписание, замечания, настройки) удаляется
 * целиком вместе с отложенными испорченными копиями. По общей очереди, чтобы идущая проверка не вернула файл.
 */
export const eraseState = (tgId) => withLock(tgId, async () => {
  await rm(stateFile(tgId), { force: true });
  const pre = `${tgId}.json.`;
  for (const f of await readdir(STATE_DIR).catch(() => [])) if (f.startsWith(pre)) await rm(join(STATE_DIR, f), { force: true });
});

/**
 * Состояние уведомлений пользователя для других модулей (объявления и материалы — news.mjs, журнал — attendance.mjs):
 * fn получает состояние, может менять его — оно сохранится. Очередь та же, что у проверок работ, поэтому внутри fn
 * не должно быть долгих запросов к Moodle: сначала сходить в сеть, потом сравнить и записать.
 * Ничего не поменялось — файл не пишется (15 окт 2026): проверка материалов (каждые ~50 с у каждого) и утренняя
 * сводка (каждые 5 мин) раньше переписывали файл без единого изменения, а каждый лишний rename на Windows — шанс, что
 * чтение рядом получит «файл занят».
 */
export const withState = (tgId, fn) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const before = JSON.stringify(state);
  const out = await fn(state);
  if (JSON.stringify(state) !== before) await saveState(tgId, state);
  return out;
});
/**
 * Только прочитать состояние: без замка и без записи (снимок «когда проверяли последний раз», показ настроек). Менять
 * его бесполезно — не сохранится; для изменений — withState. Не читается — StateReadError, как и у withState.
 */
export const peekState = (tgId) => loadState(tgId);

/** Все сообщения бота выключены самим человеком (команда /stop; включить — /settings). Хранится в его состоянии уведомлений. */
export const isMuted = async (tgId) => (await loadState(tgId)).muted === true;
export const setMuted = (tgId, on) => withLock(tgId, async () => { const s = await loadState(tgId); if (on) s.muted = true; else delete s.muted; await saveState(tgId, s); return !!on; });

/** Настройки напоминаний пользователя: { "<deadlineId>": "day" | "3h" | "none" }. */
export async function loadPrefs(tgId) { return (await loadState(tgId)).prefs || {}; }
export const savePrefs = (tgId, prefs) => withLock(tgId, async () => { const s = await loadState(tgId); s.prefs = prefs; await saveState(tgId, s); });

/**
 * items — дедлайны пользователя (id, title, due, status, grade, gradeMax); courses — { id, short }.
 * Напоминание уходит, когда до срока осталось меньше окна (24 ч или 3 ч) и больше 0, один раз на дедлайн и окно.
 */
/**
 * Кнопка под уведомлением о работе. Задание (лабораторная, курсовая и т. п.) открывается в Doodle — на карточке этой
 * работы; оттуда студент при желании сам переходит в Moodle (просьба владельца, 5 окт 2026). Тест, объявление и
 * материал курса ведут в Moodle: тест проходят там и время на него короткое, а своих экранов для объявлений в
 * приложении нет. Адрес приложения неизвестен (туннель не поднят) — тоже Moodle, чтобы кнопка была рабочей.
 */
export async function buttonsFor(x) {
  const rows = [];
  if (!x) return rows; // сводное сообщение без конкретной работы
  const app = await appUrl();
  if (app && /^moodle:assign:\d+$/.test(String(x.id || ""))) return [[{ text: "Открыть в Doodle", web_app: { url: `${app}/?open=${encodeURIComponent(x.id)}` } }]];
  // Через страницу-прокладку сервера: она открывает приложение Moodle (moodlemobile://), а без него — сайт.
  if (x.url) rows.push([{ text: x.kind === "test" ? "Открыть тест в Moodle" : "Открыть в Moodle", url: app ? `${app}/go/moodle?u=${encodeURIComponent(x.url)}` : x.url }]);
  return rows;
}

/**
 * Новые работы: сравниваем с тем, что уже видели (state.seen). Тест в Moodle может появиться внезапно и с коротким окном —
 * сообщаем сразу. Первая проверка только запоминает, что есть, чтобы не засыпать пользователя всем списком.
 * У работы без срока (due = null) пишем «срок не указан».
 */
function noteNew(state, items, courseShort, now, out, mode = "full") {
  const ids = items.map((x) => x.id);
  // Первый проход каждого вида (полная проверка / быстрый опрос тестов) только запоминает — отдельные флаги, потому что
  // наборы разные: быстрый опрос видит тесты без срока, полная проверка — задания. Иначе один проход «засевал» бы
  // список, а другой считал бы всё остальное новым (так и пришла пачка уведомлений).
  const flag = mode === "quick" ? "seededQuick" : "seededFull";
  if (!Array.isArray(state.seen) || !state[flag]) {
    state.seen = [...new Set([...(Array.isArray(state.seen) ? state.seen : []), ...ids])];
    state[flag] = true;
    return;
  }
  const seen = new Set(state.seen);
  const fresh = items.filter((x) => !seen.has(x.id) && x.status === "open");
  // id новых работ попадают в «виденные» только вместе с отметкой своего сообщения (m.mark — когда оно дошло или не
  // дойдёт никогда, см. sendOut), 15 окт 2026: раньше все id ставились заранее, и не ушедшее «Новый тест» (сбой сети,
  // 5xx) не приходило уже никогда — а это самое срочное сообщение приложения. Остальные id (закрытые, уже виденные) — сразу.
  const addSeen = (list) => (s) => { s.seen = [...new Set([...(Array.isArray(s.seen) ? s.seen : []), ...list])]; };
  const freshIds = new Set(fresh.map((x) => x.id));
  addSeen(ids.filter((id) => !freshIds.has(id)))(state);
  // Предохранитель от потока: больше 5 «новых» разом — это не внезапные тесты, а смена списка (новый курс, сброс
  // состояния) — одно сообщение вместо пачки.
  if (fresh.length > 5) {
    const list = fresh.slice(0, 5).map((x) => `• ${x.title}`).join("\n");
    // Ключ «new:many» общий для всех таких пачек — для беседы своя пачка своим ключом (по набору работ).
    // Беседе — без «смотрите вкладку» и догадок про список курсов; courseIds — чтобы беседа отсекла чужие ей курсы.
    out.push({ x: null, key: "new:many", relayKey: `new:many:${hashOf([...freshIds].sort().join(","))}`, courseIds: [...new Set(fresh.map((x) => x.courseId))],
      xs: fresh.map((x) => ({ id: x.id, title: x.title, courseId: x.courseId })), // беседа уберёт из пачки не общее и соберёт текст заново
      relayText: `🆕 Появилось сразу ${fresh.length} новых работ:\n${list}${fresh.length > 5 ? `\n…и ещё ${fresh.length - 5}` : ""}`, text: `🆕 Появилось сразу ${fresh.length} новых работ (похоже, обновился список курсов):\n${list}\n…смотрите вкладку «Дедлайны».`, mark: addSeen([...freshIds]) });
    return;
  }
  for (const x of fresh) {
    if (seen.has(x.id) || x.status !== "open") continue;
    const left = x.due ? effective(x.due) - now : null;
    const soon = left != null && left > 0 && left <= DAY ? `
⚠️ Осталось ${left < 2 * HOUR ? Math.max(1, Math.round(left / 60e3)) + " мин" : Math.round(left / HOUR) + " ч"}` : "";
    // «Завтра» не дублируем — срок уже в этом сообщении: отметка суточного напоминания ставится вместе с ним, а пока
    // оно не ушло, check суточное не шлёт (covers) — иначе в одном обходе пришли бы оба.
    const day = soon ? `${x.id}:day` : null;
    // Тест, который ещё не открылся: о его открытии придёт отдельное сообщение (checkOpen).
    const opens = x.opensAt ? (x.opensAt > now ? `откроется ${fmt(x.opensAt)} (сообщу), ` : `открыт с ${fmt(x.opensAt)}, `) : "";
    // Вид работы — словом, чтобы в беседе было видно сразу (16 окт 2026, владелец: «уведомления о появлении новых
    // лабораторных, материалах и других работ»). Лабораторная и контрольная — по названию: kindOf в moodle.mjs называет
    // «lab» любое задание без особых слов, а «Домашнее задание 3» лабораторной не назовёшь.
    const head = x.kind === "test" ? "🆕 Новый тест" : x.kind === "coursework" ? "🆕 Новый этап курсовой"
      : /лаборатор|(^|[^а-яё])лаб\.?\s*(раб|№|\d)|(^|[^а-яё])лр\s*-?\s*№?\s*\d|\blab\b/i.test(x.title) ? "🆕 Новая лабораторная"
        : /контрольн/i.test(x.title) ? "🆕 Новая контрольная" : "🆕 Новое задание";
    out.push({ x, key: `new:${x.id}`, covers: day, text: `${head}: ${x.title}
${courseShort.get(x.courseId) ?? ""} · ${opens}${x.due ? "до " + fmt(x.due) : "срок не указан"}${soon}`, mark: (s) => { addSeen([x.id])(s); if (day) s.sent[day] = now; } });
  }
}

/** Пользователь изменил список курсов: работы новых курсов запоминаем молча, иначе старые тесты уйдут как «новые». */
export const reseed = (tgId, items) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  state.seen = [...new Set([...(Array.isArray(state.seen) ? state.seen : []), ...items.map((x) => x.id)])];
  state.seededQuick = true; state.seededFull = true;
  // То же с замечаниями преподавателя по работам включённого курса: они уже были, сообщать о них не нужно.
  state.remarks ??= {};
  for (const x of items) if (x.remarks?.length) state.remarks[x.id] = [...new Set([...(Array.isArray(state.remarks[x.id]) ? state.remarks[x.id] : []), ...x.remarks.map((r) => r.key)])].slice(-100);
  await saveState(tgId, state);
});

/**
 * Вопрос о курсе прошлого семестра, в котором появилась новая работа (moodle.pendingCourses): сам курс в дедлайны не
 * добавляется — спрашиваем пользователя, один раз на курс. Ответ он даёт в приложении («Курсы» → «Уточните»), и тот
 * сохраняется как ручной выбор курса. Отметку «спросили» ставим и тогда, когда вопрос не дойдёт никогда (человек не
 * нажал Start у бота): он всё равно виден в приложении, а повторять отправку каждые 15 минут незачем. При временном сбое
 * (сеть, 5xx, 429) — с 15 окт 2026 отметки нет, повторим на следующем обходе (пределы — retryExhausted).
 * Возвращает число дошедших вопросов.
 */
export const askCourses = (tgId, pending) => withLock(tgId, async () => {
  if (!pending?.length) return 0;
  const state = await loadState(tgId);
  state.askedCourses ??= {};
  const fresh = pending.filter((p) => !state.askedCourses[p.id]);
  if (!fresh.length) return 0;
  const app = await appUrl();
  const out = fresh.map((p) => ({ key: `ask:${p.id}`, text: `❓ В курсе «${p.fullname}» появилась работа «${p.title}»${p.section ? ` (раздел «${p.section}»)` : ""}, срок до ${fmt(effective(p.due))}.
Курс не из текущего семестра, поэтому в дедлайны он не добавлен. Это ваш курс сейчас?
${app ? "Ответьте в Doodle — кнопка ниже." : "Ответьте в Doodle: Профиль → Курсы."}`,
    buttons: app ? [[{ text: "Ответить в Doodle", web_app: { url: `${app}/?open=courses` } }]] : undefined, mark: (s) => { (s.askedCourses ??= {})[p.id] = Date.now(); } }));
  const n = await sendOut(tgId, state, out);
  await saveState(tgId, state);
  return n;
});

/**
 * «Тест открыт» (просьба владельца, 5 окт 2026): отдельное сообщение не когда тест появился в курсе, а когда его
 * действительно можно начать. Тест с временем открытия в будущем запоминается (state.quizWait); когда время пришло,
 * сервер спрашивает Moodle, доступен ли тест студенту (available — функция от сервера: id → { ok }), и только при «да»
 * уходит сообщение. Тест ещё закрыт (преподаватель придержал) — спросим снова; закрылся или исчез — забываем.
 * Возвращает { sent, waiting: [{ id, at }] } — когда по каким тестам проверить снова (сервер ставит таймеры).
 */
const OPEN_RETRY_MS = Number(process.env.QUIZ_OPEN_RETRY_MS) || 2 * 60e3, OPEN_TRIES = 10;
/**
 * Тесты, которые ещё не открылись, — в список ожидания (state.quizWait: id → { opensAt, tries, askedAt }). Время открытия
 * перенесли — запись обновляется; сняли или перенесли в прошлое — тест открыт уже сейчас (берём «сейчас», а не новое
 * время: запись старше суток была бы тут же забыта). Вызывается и полной проверкой, и быстрым опросом тестов.
 */
function noteWait(state, tests, now) {
  const wait = (state.quizWait ??= {});
  for (const x of tests) {
    if (x.opensAt && x.opensAt > now) { if (!wait[x.id] || wait[x.id].opensAt !== x.opensAt) wait[x.id] = { opensAt: x.opensAt, tries: 0 }; }
    else if (wait[x.id] && wait[x.id].opensAt > now) wait[x.id].opensAt = now;
  }
  return wait;
}
/** Когда по каким тестам проверить снова: в момент открытия; время пришло, а тест закрыт — через OPEN_RETRY_MS, пока попытки не кончились. */
const waitingOf = (wait, now) => Object.entries(wait).map(([id, w]) => ({ id, at: w.opensAt > now ? w.opensAt : w.tries + (w.misses || 0) < OPEN_TRIES ? now + OPEN_RETRY_MS : null })).filter((w) => w.at);
export async function checkOpen(tgId, items, courses, available) {
  const tests = new Map(items.filter((x) => x.kind === "test" && x.status === "open").map((x) => [x.id, x]));
  // 1. Под замком состояния: обновить список ожидания и решить, о каких тестах пора спросить Moodle.
  const due = await withLock(tgId, async () => {
    const state = await loadState(tgId), now = Date.now();
    const wait = noteWait(state, tests.values(), now);
    state.quizAt = now; // когда тесты последний раз читались свежими — см. check()
    for (const [id, w] of Object.entries(wait)) {
      const x = tests.get(id);
      if (!x || (x.due && x.due <= now) || now - w.opensAt > DAY) delete wait[id]; // исчез, закрылся или ждём больше суток
    }
    // Время открытия прошло, а Moodle OPEN_TRIES раз ответил «нельзя начать» (пароль, ограничение по группе, попытки
    // исчерпаны) — дальше спрашиваем не чаще раза в час: поздно открытый тест всё же даст сообщение, а лишних запросов нет.
    const ids = Object.keys(wait).filter((id) => wait[id].opensAt <= now && (wait[id].tries + (wait[id].misses || 0) < OPEN_TRIES || now - (wait[id].askedAt || 0) >= HOUR));
    for (const id of ids) wait[id].askedAt = now;
    await saveState(tgId, state);
    return ids;
  });
  // 2. Вне замка: вопрос Moodle. Он идёт через общую очередь и может занять десятки секунд — проверки работ и настройки
  //    этого пользователя в это время не должны ждать.
  let acc = null;
  if (due.length) { try { acc = await available(due); } catch { /* Moodle не ответил — спросим в следующий раз */ } }
  // 3. Снова под замком, по свежему состоянию: отметить попытку или отправить сообщение. Весь шаг под замком, поэтому
  //    одновременный вызов (таймер открытия и обычный опрос) второго сообщения не даст и тогда, когда запись снимается
  //    ПОСЛЕ отправки. Снимается она, только когда сообщение дошло или не дойдёт никогда (15 окт 2026; раньше — до
  //    отправки, и не ушедшее «Тест открыт» терялось). Временный сбой — запись остаётся, и waitingOf ставит повтор через
  //    OPEN_RETRY_MS (Moodle спросим ещё раз — тест за это время мог и закрыться); срок жизни записи — прежний (сутки).
  return withLock(tgId, async () => {
    const state = await loadState(tgId), now = Date.now(), wait = (state.quizWait ??= {});
    const courseShort = new Map(courses.map((c) => [c.id, c.short]));
    const out = [];
    for (const id of due) {
      const x = tests.get(id), a = acc?.get(id);
      if (!wait[id]) continue;
      // Moodle по этому тесту не ответил: считаем отдельно, чтобы после десяти таких проверок тоже перейти на «раз в час».
      if (!a) { wait[id].misses = (wait[id].misses || 0) + 1; continue; }
      wait[id].misses = 0;
      if (!a.ok) { wait[id].tries++; continue; }
      const about = [x.timeLimit ? `на попытку ${Math.max(1, Math.round(x.timeLimit / 60))} мин` : "", x.attempts ? `попыток: ${x.attempts}` : ""].filter(Boolean).join(" · ");
      const head = `🟢 Тест открыт: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · можно проходить${x.due ? " до " + fmt(x.due) : ""}`;
      // По этой работе пользователь отключил сообщения — ему не шлём, но беседе, где он источник, «тест открыт» нужен
      // (quiet). Время на попытку и число попыток — только ему: у него они могут быть личными (продление в Moodle).
      out.push({ x, key: `open:${id}`, text: `${head}${about ? "\n⏱ " + about : ""}`, relayText: head, quiet: (state.prefs || {})[id] === "none", mark: (s) => { delete s.quizWait?.[id]; } });
    }
    const sent = await sendOut(tgId, state, out, courses);
    await saveState(tgId, state);
    return { sent, waiting: waitingOf(wait, now) };
  });
}
/** Тесты, открытия которых ждёт пользователь: [{ id, at }] — сервер ставит по ним таймеры (после перезапуска и после полной проверки). */
export async function quizWaiting(tgId) {
  return waitingOf((await loadState(tgId)).quizWait || {}, Date.now());
}

/** Быстрая проверка (каждые 2 мин): только новые тесты — сообщение с кнопкой сразу. items — из moodle.quizzesQuick. */
// Возвращает число дошедших сообщений. Ничего не поменялось — файл не пишется (опрос идёт каждые 45 с у каждого).
export const checkNew = (tgId, items, courses) => withLock(tgId, async () => {
  const state = await loadState(tgId), before = JSON.stringify(state);
  const out = [];
  noteNew(state, items, new Map(courses.map((c) => [c.id, c.short])), Date.now(), out, "quick");
  const n = await sendOut(tgId, state, out, courses);
  if (JSON.stringify(state) !== before) await saveState(tgId, state);
  return n;
});

/**
 * Когда должны уйти ещё не отправленные напоминания по этим работам: [{ key, at }] (key — `${id}:day|3h`). Обход идёт раз
 * в 10 минут, и напоминание по нему опаздывало на 0–10 минут; по этому списку сервер ставит таймер на саму минуту.
 * Условие то же, что в check: напоминание «созревает», когда до срока остаётся не больше окна.
 */
export async function reminderTimes(tgId, items) {
  const state = await loadState(tgId);
  const prefs = state.prefs || {};
  const now = Date.now(), out = [];
  for (const x of items) {
    if (x.status !== "open" || !x.due) continue;
    const pref = prefs[x.id] ?? DEFAULT_REMINDER;
    if (pref === "none") continue;
    const windows = pref === "3h" ? [["3h", 3 * HOUR]] : [["day", DAY], ["3h", 3 * HOUR]];
    for (const [key, ms] of windows) {
      const at = effective(x.due) - ms;
      if (at > now && !state.sent[`${x.id}:${key}`]) out.push({ key: `${x.id}:${key}`, at });
    }
  }
  return out;
}

/*
 * Каждое сообщение проверки несёт свою отметку (mark): sent[id:окно], seen, grades[id], remarks[id]. Ставится она после
 * отправки — когда сообщение дошло или не дойдёт никогда (sendOut); временный сбой — отметки нет, и следующий обход
 * (10 мин) или таймер напоминания повторят (15 окт 2026: раньше все отметки ставились при сборке, и не ушедшее «⏰»,
 * «Новый тест» или «Оценка» терялись навсегда). Отметки, не связанные с отправкой (первый проход, первая синхронизация
 * оценок, «завтра», когда осталось меньше 3 ч), ставятся сразу, как раньше. Возвращает число дошедших сообщений.
 */
export const check = (tgId, items, courses, readAt = Date.now()) => withLock(tgId, async () => {
  const state = await loadState(tgId), before = JSON.stringify(state);
  const prefs = state.prefs || {};
  const now = Date.now();
  const courseShort = new Map(courses.map((c) => [c.id, c.short]));
  const out = [];
  if (!Number.isFinite(readAt)) readAt = now;
  // Данные старше уже обработанных (копия дедлайнов с диска после перезапуска, восстановленная копия папки): по ним
  // «новые» работы, оценки и замечания считать нельзя — оценка 7 сменилась бы обратно на 5 и пришла бы дважды. Только
  // напоминания о сроках: они зависят от времени, а не от свежести списка.
  const older = readAt < (state.readAt || 0);
  if (!older) state.readAt = readAt;

  if (!older) noteNew(state, items, courseShort, now, out);
  // Тест, который ещё не открылся, — в список ожидания сразу: ночью быстрого опроса тестов нет, и обещанное «сообщу»
  // должно сработать и для теста, найденного полной проверкой (таймер на открытие ставит сервер).
  // Только по данным не старше последнего опроса тестов (readAt — когда items прочитаны из Moodle): обход часто работает
  // с дедлайнами получасовой давности и по ним вернул бы в ожидание тест, о котором уже сообщили (открытие перенесли).
  if (readAt >= (state.quizAt || 0)) noteWait(state, items.filter((x) => x.kind === "test" && x.status === "open"), now);

  // Срок работы изменили (16 окт 2026, владелец: «если изменили срок работы или теста, или лабораторной, контрольной —
  // об этом тоже нужно уведомлять»). state.dues — последний известный срок каждой работы; первая проверка после появления
  // функции и новая работа — только запоминают (о новой пишет noteNew). Сообщение человеку — по работе, которую он ещё не
  // сдал и по которой не выключал напоминания; иначе оно собирается только для беседы, где он источник (quiet). Новый
  // срок дальше окна напоминания — напоминание этого окна придёт заново, по новому сроку; уже внутри окна — это сообщение
  // его и заменяет (covers). Обе даты в прошлом (архивная работа) — молча.
  if (!older) {
    if (!state.dues || typeof state.dues !== "object" || Array.isArray(state.dues)) state.dues = {};
    if (!state.duesSeen || typeof state.duesSeen !== "object" || Array.isArray(state.duesSeen)) state.duesSeen = {};
    const dues = state.dues;
    for (const x of items) {
      if (!x.due) continue;
      state.duesSeen[x.id] = now;
      const prev = dues[x.id];
      if (prev === undefined || !state.duesSeeded) { dues[x.id] = x.due; continue; }
      if (prev === x.due) continue;
      // Сдвиг меньше 10 минут — не перенос (правка секунд, пересчёт часового пояса): запоминаем молча.
      if (Math.abs(x.due - prev) < 10 * 60e3) { dues[x.id] = x.due; continue; }
      const due = x.due, left = effective(due) - now, later = due > prev;
      if (Math.max(prev, due) <= now) { dues[x.id] = due; continue; }
      const covers = [["day", DAY], ["3h", 3 * HOUR]].filter(([, ms]) => left > 0 && left <= ms).map(([k]) => `${x.id}:${k}`);
      const soon = !later && left > 0 && left <= DAY ? `\n⚠️ Осталось ${left < 2 * HOUR ? Math.max(1, Math.round(left / 60e3)) + " мин" : Math.round(left / HOUR) + " ч"}` : "";
      // В ключе беседы — и прежний срок: перенос «туда и обратно» — два разных сообщения.
      out.push({ x, key: `due:${x.id}`, relayKey: `due:${x.id}:${prev}:${due}`, covers, quiet: x.status !== "open" || (prefs[x.id] ?? DEFAULT_REMINDER) === "none",
        text: `📅 Срок ${later ? "продлили" : "перенесли раньше"}: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · было до ${fmt(prev)}, теперь до ${fmt(due)}${soon}`,
        mark: (s) => {
          (s.dues ??= {})[x.id] = due;
          for (const [k, ms] of [["day", DAY], ["3h", 3 * HOUR]]) if (left > ms) delete s.sent[`${x.id}:${k}`]; // окно по новому сроку впереди
          for (const k of covers) s.sent[k] = now;
        } });
    }
    // Работа выпала из списка (закрытый тест без попытки, курс выключили, сбой чтения) — её срок помним ещё 60 дней:
    // тест переоткрыли с новым сроком — это «срок продлили», а не новая молчаливая запись.
    for (const id of Object.keys(dues)) if (!(now - (state.duesSeen[id] || 0) < 60 * DAY)) { delete dues[id]; delete state.duesSeen[id]; }
    state.duesSeeded = true;
  }

  // Суточные напоминания, которые заменяет ещё не ушедшее «Новый …» (в нём уже написано «осталось N ч»).
  const covered = new Set(out.flatMap((m) => [].concat(m.covers || []))); // covers — ключ или список ключей
  for (const x of items) {
    if (x.status !== "open") continue;
    const pref = prefs[x.id] ?? DEFAULT_REMINDER;
    if (pref === "none") continue;
    const left = effective(x.due) - now;
    const windows = pref === "3h" ? [["3h", 3 * HOUR]] : [["day", DAY], ["3h", 3 * HOUR]];
    for (const [key, ms] of windows) {
      const k = `${x.id}:${key}`;
      if (state.sent[k] || covered.has(k) || left <= 0 || left > ms) continue;
      // Если уже меньше 3 часов, «завтра» не шлём — уйдёт только «через N ч».
      if (key === "day" && left <= 3 * HOUR) { state.sent[k] = now; continue; }
      const h = Math.round(left / HOUR);
      // Суточное напоминание могло опоздать (ПК спал, Moodle не отвечал) и прийти уже в день срока — тогда не «Завтра».
      // Не ушло (сбой) — повтор следующим обходом, пока окно открыто: «завтра» гасится, когда осталось меньше 3 ч, «через
      // N ч» — сроком.
      const when = key === "3h" ? `Через ~${h} ч` : mskDay(effective(x.due)) === mskDay(now) ? `Сегодня (через ~${h} ч)` : "Завтра";
      out.push({ x, key: `remind:${k}`, text: `⏰ ${when} срок: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · до ${fmt(x.due)}`, mark: (s) => { s.sent[k] = now; } });
    }
  }

  for (const x of older ? [] : items) {
    if (x.grade == null) continue;
    const prev = state.grades[x.id];
    if (prev === undefined) { state.grades[x.id] = x.grade; continue; } // первая синхронизация: только запоминаем
    if (prev !== x.grade) {
      const grade = x.grade; // новое значение запоминается, когда сообщение ушло; не ушло — следующий обход повторит
      out.push({ x, key: `grade:${x.id}`, text: `📝 Оценка: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · ${x.grade}${x.gradeMax ? ` из ${x.gradeMax}` : ""}`, mark: (s) => { s.grades[x.id] = grade; } });
    }
  }

  // Замечания преподавателя (отзыв к оценке и комментарии к ответу): о каждом новом — сообщение. Новое — то, чьей метки
  // (key из moodle.mjs) ещё не было: запись в комментариях или отзыв, переписанный после повторной проверки.
  // Первая проверка после появления этой функции только запоминает то, что уже есть. Метки новых — в отметке сообщения.
  if (!older) {
    state.remarks ??= {};
    for (const x of items) {
      if (!x.remarks?.length) continue;
      const prev = state.remarks[x.id];
      const known = new Set(Array.isArray(prev) ? prev : []);
      const fresh = x.remarks.filter((r) => !known.has(r.key));
      if (!fresh.length) continue;
      const keys = [...known, ...fresh.map((r) => r.key)].slice(-100);
      if (!state.remarksSeeded) { state.remarks[x.id] = keys; continue; }
      const last = fresh[fresh.length - 1];
      out.push({ x, key: `remark:${x.id}`, text: `💬 Замечание преподавателя: ${x.title}\n${courseShort.get(x.courseId) ?? ""}${last.author ? ` · ${last.author}` : ""}\n«${last.text.slice(0, 500)}${last.text.length > 500 ? "…" : ""}»\n${fresh.length > 1 ? `Новых замечаний: ${fresh.length}, все` : "Полный текст"} — в карточке работы в Doodle.`,
        mark: (s) => { (s.remarks ??= {})[x.id] = keys; } });
    }
    state.remarksSeeded = true;
  }

  // Счётчики попыток по сообщениям, которые больше не собираются (работа исчезла, окно напоминания закрылось), — прочь.
  // С 15 окт 2026 — по тому же признаку «эпизод закончился» (RETRY_GAP без неудач), что и в retryExhausted: такая
  // запись при следующей неудаче всё равно начнётся заново. Раньше чистились только записи старше двух суток, и
  // остаток в окне «сутки–двое» исчерпывал попытки нового сообщения с тем же ключом сразу.
  if (state.retry && typeof state.retry === "object") for (const [k, t] of Object.entries(state.retry)) if (!t || typeof t !== "object" || retryStale(t, now)) retryClear(state, k);
  const n = await sendOut(tgId, state, out, courses);
  if (JSON.stringify(state) !== before) await saveState(tgId, state);
  return n;
});

// ---------- изменения расписания ----------
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dayLabel = (iso) => { const d = new Date(`${iso}T12:00:00Z`); return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const todayMsk = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
const pairOf = (l) => [l.start, l.name, l.place || "", l.typeLabel || ""];
const pairKey = (p) => p.join("|");

/**
 * Изменения расписания группы (просьба владельца, 3 окт 2026): основа — официальное расписание МИСИС, переносы и
 * замены приходят с «Дневача» (schedule.mjs). Каждую проверку (15 мин) пары пользователя (его подгруппа) с сегодняшнего
 * дня сравниваются со снимком прошлой проверки, и обо всём, что поменялось в уже известных днях, — одно сообщение.
 * Первая проверка, смена группы или подгруппы — только запоминают. Новые дни в конце окна — не изменение. Если пропало
 * больше половины пар и ничего не появилось — это сбой данных (файл МИСИС не разобрался и т. п.), а не отмена: не пишем
 * и снимок не трогаем. Возвращает число изменений (0 — если сообщение не дошло).
 * Новый снимок с изменениями сохраняется, только когда сообщение дошло или не дойдёт никогда (15 окт 2026; раньше —
 * до отправки, и не ушедшее сообщение о переносе пары терялось навсегда). Временный сбой — остаётся прежний снимок, и
 * следующая проверка (15 мин) пересчитает разницу заново; прошедшие дни из неё выпадут сами.
 */
export const checkSchedule = (tgId, group, subgroup, lessons) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const r = scheduleDiff(state.schedule, lessons, group, subgroup);
  if (r.suspicious) { console.log(`notify ${tgId}: расписание: ${r.suspicious} — похоже на сбой данных, не пишу`); return 0; }
  if (!r.count) {
    if (JSON.stringify(state.schedule) !== JSON.stringify(r.snapshot)) { state.schedule = r.snapshot; await saveState(tgId, state); }
    return 0;
  }
  const app = await appUrl();
  const n = await sendOut(tgId, state, [{ key: "schedule", text: r.text, buttons: app ? [[{ text: "Открыть расписание", web_app: { url: `${app}/?tab=plan` } }]] : undefined,
    mark: (s) => { s.schedule = r.snapshot; } }]);
  return n ? r.count : 0;
});
/**
 * Сравнение пар со снимком прошлой проверки (общее для личных чатов и бесед — chats.mjs). subgroup null — пары всех
 * подгрупп, у пар подгруппы к названию добавляется «(подгр. N)». Возвращает { snapshot, count, text } — новый снимок,
 * число изменений и текст сообщения; или { suspicious } — похоже на сбой данных, снимок не менять.
 */
export function scheduleDiff(prev, lessons, group, subgroup) {
  const today = todayMsk();
  const days = {};
  for (const l of lessons) {
    if (l.change === "removed" || l.date < today || (subgroup && l.subgroup && l.subgroup !== subgroup)) continue;
    const p = pairOf(l);
    if (!subgroup && l.subgroup) p[1] += ` (подгр. ${l.subgroup})`;
    (days[l.date] ||= []).push(p);
  }
  const snapshot = { group, subgroup, days };
  if (!prev || prev.group !== group || prev.subgroup !== subgroup) return { snapshot, count: 0 };
  const lines = [];
  let gone = 0, before = 0, added = 0;
  for (const [date, was] of Object.entries(prev.days || {})) {
    if (date < today) continue;
    before += was.length;
    const now = days[date];
    if (!now) { if (date <= Object.keys(days).sort().at(-1)) gone += was.length; else continue; } // день ушёл из окна — не изменение
    const nowKeys = new Set((now || []).map(pairKey)), wasKeys = new Set(was.map(pairKey));
    const del = was.filter((p) => !nowKeys.has(pairKey(p))), add = (now || []).filter((p) => !wasKeys.has(pairKey(p)));
    if (!del.length && !add.length) continue;
    gone += now ? del.length : 0;
    added += add.length;
    const out = [];
    for (const d of del) {
      // Та же пара появилась в другое время или в другой аудитории — это перенос, а не отмена и новая пара.
      const same = add.find((a) => a[1] === d[1]);
      if (same) {
        add.splice(add.indexOf(same), 1);
        out.push(same[0] !== d[0] ? `«${d[1]}» перенесена с ${d[0]} на ${same[0]}${same[2] ? `, ${same[2]}` : ""}`
          : `«${d[1]}», ${d[0]}: аудитория ${same[2] || "не указана"} (была ${d[2] || "не указана"})`);
      } else out.push(`отменена «${d[1]}», ${d[0]}`);
    }
    for (const a of add) out.push(`новая пара «${a[1]}»${a[3] ? ` (${a[3].toLowerCase()})` : ""}, ${a[0]}${a[2] ? `, ${a[2]}` : ""}`);
    lines.push(`${dayLabel(date)}:`, ...out.map((t) => `• ${t}`));
  }
  if (!lines.length) return { snapshot, count: 0 };
  if (gone > before / 2 && !added) return { suspicious: `пропало ${gone} из ${before} пар без замен` };
  const text = [`📅 Изменения в расписании · ${group}`, ...lines.slice(0, 24), lines.length > 24 ? `…и ещё ${lines.length - 24} строк — всё в Doodle.` : ""].filter(Boolean).join("\n");
  return { snapshot, count: lines.filter((l) => l.startsWith("•")).length, text };
}
