// Согласие на обработку персональных данных в боте (21 окт 2026, письмо системного администратора МИСИС).
// Отдельный документ (terms.mjs CONSENT) показывается сообщением с кнопками «Согласен(на)» / «Не согласен(на)». Нажатие —
// запись о согласии (users.giveConsent: редакция и время). Пока записи нет, users.moodleToken() отдаёт null, и Doodle
// ничего не читает в Moodle и журнале: ни приложение, ни команды бота, ни фоновые обходы.
//
// Кому и когда бот просит согласие:
//  - новому пользователю — вместо приветствия на /start (приветствие уходит после согласия);
//  - уже вошедшим без согласия — при запуске сервера и раз в 6 часов (askPending): не чаще раза в сутки и не больше трёх раз;
//  - командой /consent — текст и статус; /revoke — отзыв (с подтверждением): то же, что «Выйти», и согласие стирается.
import * as users from "./users.mjs";
import * as notify from "./notify.mjs";
import { CONSENT } from "./terms.mjs";

const ASK_EVERY_MS = 24 * 3600e3, ASK_MAX = 3;
const when = (ms) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const BUTTONS = [[{ text: "✅ Согласен(на)", callback_data: "consent:yes" }], [{ text: "Не согласен(на)", callback_data: "consent:no" }]];
const INTRO_NEW = "Прежде чем начать: Doodle читает ваши данные в Moodle и электронном журнале МИСИС, поэтому нужно ваше отдельное согласие на обработку персональных данных. Без него приложение ничего не читает.\n\n";
const INTRO_OLD = "Doodle обновил правила: для работы с вашими данными в Moodle и электронном журнале нужно отдельное согласие на обработку персональных данных. Пока вы его не дали, Doodle ничего не читает и не присылает уведомления — нажмите «Согласен(на)», чтобы всё работало как раньше.\n\n";

/** Команды, которые работают без согласия: сами документы, помощь и работа с согласием. */
export const OPEN_COMMANDS = new Set(["start", "help", "terms", "privacy", "consent", "revoke"]);

/** Запросить согласие у пользователя: текст документа и кнопки. old — напоминание уже вошедшему. */
export async function ask(tgId, { old = false } = {}) {
  return notify.send(tgId, (old ? INTRO_OLD : INTRO_NEW) + CONSENT, undefined, BUTTONS, { force: true });
}

/** Нужно ли согласие этому пользователю (владельцу — нет). */
export const needed = async (tgId) => !(await users.hasConsent(tgId));

/** /consent: текст согласия и статус — дано (когда) или кнопки. */
export async function show(tgId) {
  const c = await users.consentInfo(tgId);
  if (c?.current) return notify.send(tgId, `${CONSENT}\n\n✅ Согласие дано ${when(c.at)}. Отозвать: /revoke`, undefined, undefined, { force: true });
  return ask(tgId);
}

/** /revoke: подтверждение — отзыв стирает доступ, как «Выйти». */
export async function askRevoke(tgId) {
  return notify.send(tgId, "Отозвать согласие? Доступ к Moodle и журналу прекратится, Doodle перестанет присылать уведомления, а ваши данные удалятся с сервера: ключ доступа, пароль и сеанс журнала, ФИО и логин, группа и настройки, оценки и пропуски, заметки и лабораторные с перепиской. Из резервных копий они исчезнут в течение 7 дней. Вернуться можно в любой момент: /start.", undefined,
    [[{ text: "Да, отозвать", callback_data: "revoke:yes" }], [{ text: "Отмена", callback_data: "revoke:no" }]], { force: true });
}

/**
 * Нажатие кнопки согласия или отзыва (личный чат). Возвращает { text, granted } — текст, которым заменяется сообщение
 * с кнопкой, и признак «согласие только что дано» (тогда бот присылает приветствие). null — это не наша кнопка.
 */
export async function onCallback(tgId, data) {
  if (data === "consent:yes") {
    const c = await users.giveConsent(tgId);
    return { text: `✅ Согласие записано (${when(c.at)}). Спасибо! Отозвать можно в любой момент: /revoke.`, granted: true };
  }
  if (data === "consent:no") return { text: "Без согласия Doodle не может читать Moodle и журнал, поэтому приложение не будет работать. Передумаете — нажмите /consent. Условия и политика: /terms, /privacy.", granted: false };
  if (data === "revoke:yes") {
    const { onRevoke } = await import("./purge-user.mjs"); // позже загрузки: модуль тянет за собой почти весь сервер
    const failed = await onRevoke(tgId);
    return { text: failed.length
      ? "Согласие отозвано, доступ к Moodle и журналу закрыт. Часть данных удалить сразу не вышло — автор уже предупреждён и удалит остальное вручную. Doodle больше ничего не читает. Вернуться: /start."
      : "Согласие отозвано: доступ к Moodle и журналу закрыт, ваши данные удалены с сервера (из резервных копий они исчезнут в течение 7 дней). Doodle больше ничего не читает. Вернуться: /start.", granted: false };
  }
  if (data === "revoke:no") return { text: "Хорошо, согласие остаётся в силе.", granted: false };
  return null;
}

/**
 * Вошедшие без согласия (после обновления правил): им уходит запрос. Вызывается при запуске сервера и раз в 6 часов.
 * Возвращает, скольким отправлено. Не ушло (бот заблокирован) — всё равно считается попыткой: больше трёх раз не пишем.
 */
export async function askPending() {
  let sent = 0;
  for (const p of await users.consentPending()) {
    if (p.ask && (p.ask.n >= ASK_MAX || Date.now() - p.ask.at < ASK_EVERY_MS)) continue;
    await users.noteConsentAsk(p.tgId).catch(() => {});
    try { if (await ask(p.tgId, { old: true }) === true) sent++; } catch { /* бот заблокирован */ }
  }
  return sent;
}
