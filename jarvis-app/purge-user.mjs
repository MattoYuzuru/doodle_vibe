// Очистка данных человека (21 окт 2026, по просьбе владельца после разбора, что бот хранит на диске).
//
//  onLogout — «Выйти»: секреты и кэши (токен Moodle, сеанс и пароль журнала, ссылка календаря, кэш дедлайнов, лента
//    календаря, отладочные файлы, отложенные копии записи). ФИО, группа и настройки остаются — человек вернётся и найдёт их.
//  onRevoke — отзыв согласия: то же, и сверх того всё остальное: запись пользователя (ФИО, логин, имя в Telegram, группа),
//    состояние уведомлений (оценки, пропуски, расписание), копия данных приложения, задания и проверки лаб с перепиской,
//    рабочие папки, образцы оформления, замечания в общей базе, привязки бесед, дата первого Start, белый список лаб.
//
// Что остаётся и почему: резервные копии (хранятся недолго, backup.mjs), общий учёт пробного отчёта — только под
// обезличенными ключами (lab-trial.forgetUser), расход агента (usage — лимиты), журналы сессий агента вне этой папки.
// Владельца отзыв не стирает: он оператор, а не пользователь.
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as botStats from "./bot-stats.mjs";
import * as calendar from "./calendar.mjs";
import * as chats from "./chats.mjs";
import * as cloudBackup from "./cloud-backup.mjs";
import * as courseSheets from "./course-sheets.mjs";
import * as ej from "./ej.mjs";
import * as lab from "./lab.mjs";
import * as labTrial from "./lab-trial.mjs";
import * as lessons from "./lessons.mjs";
import * as moodle from "./moodle.mjs";
import * as notify from "./notify.mjs";
import * as users from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Удалить в папке файлы, имя которых подходит под выражение (папки нет — ничего). */
async function removeMatching(dir, re) {
  for (const f of await readdir(dir).catch(() => [])) if (re.test(f)) await rm(join(dir, f), { force: true });
}

/** Отложенные испорченные копии записи пользователя: в них прежний файл целиком (токен, куки журнала, ФИО). */
export const dropUserBadCopies = (tgId) => removeMatching(join(DIR, "users"), new RegExp(`^${Number(tgId)}\\.json\\.bad-`));

/** Выполнить шаги по очереди; сбой одного не мешает остальным. Возвращает названия сбойных шагов. */
async function run(tgId, steps) {
  const failed = [];
  for (const [name, fn] of steps) {
    try { await fn(); }
    catch (e) { failed.push(name); console.error(`purge ${tgId}: «${name}» не выполнено — ${e?.message || e}`); }
  }
  return failed;
}

/** Сеанс человека в памяти и кэш дедлайнов. Токен нужен до выхода (выход его стирает): без него кэш на диске не найти. */
async function dropSession(tgId) {
  ej.forget(tgId);
  const t = await users.moodleToken(tgId).catch(() => null);
  // revoke: токен отзывается — обход, взявший список вошедших до выхода, копию с ним уже не запишет (15 окт 2026).
  await moodle.forgetDeadlines(t, tgId, { revoke: true });
  if (t) courseSheets.forget(t);
}

/** Кэши и отладочные файлы человека, которые не нужны без входа. */
const caches = (tgId) => [
  ["секретная ссылка календаря", () => users.dropCalToken(tgId)],
  ["лента календаря",() => calendar.erase(tgId)],
  ["диагностика приложения", () => rm(join(DIR, "diag", `${Number(tgId)}.json`), { force: true })],
  ["отладочный дамп журнала", () => rm(join(DIR, "ej-debug", `${Number(tgId)}.json`), { force: true })],
  ["копии записи пользователя", () => dropUserBadCopies(tgId)],
];

/** «Выйти». Возвращает { profile, failed }; сам выход (users.logout) при сбое бросает — как раньше. */
export async function onLogout(tgId) {
  tgId = Number(tgId);
  const failed = [];
  await dropSession(tgId).catch((e) => { failed.push("сеанс и кэш дедлайнов"); console.error(`purge ${tgId}: сеанс и кэш дедлайнов — ${e?.message || e}`); });
  const profile = await users.logout(tgId);
  failed.push(...await run(tgId, caches(tgId)));
  return { profile, failed };
}

/** Отзыв согласия. Возвращает названия шагов, которые не удались (пусто — всё стёрто). */
export async function onRevoke(tgId) {
  tgId = Number(tgId);
  if (tgId === users.OWNER_ID) { await users.revokeConsent(tgId); return []; }
  const failed = [];
  await dropSession(tgId).catch((e) => { failed.push("сеанс и кэш дедлайнов"); console.error(`purge ${tgId}: сеанс и кэш дедлайнов — ${e?.message || e}`); });
  await users.revokeConsent(tgId); // доступ закрыт сразу: токен, сеанс и пароль журнала стёрты, согласия нет
  // Учёт пробного отчёта обезличивается ДО удаления заданий и записи: по ним видно, что человек уже пользовался.
  const trial = await run(tgId, [["учёт пробного отчёта", () => labTrial.forgetUser(tgId)]]);
  failed.push(...trial);
  failed.push(...await run(tgId, [
    ...(trial.length ? [] : [["задания и проверки лаб", () => lab.eraseUser(tgId)]]),
    ["замечания в общей базе", () => lessons.purge(tgId)],
    ["состояние уведомлений", () => notify.eraseState(tgId)],
    ["копия данных приложения", () => cloudBackup.erase(tgId)],
    ["привязки бесед", () => chats.eraseUser(tgId)],
    ["статистика бота", async () => { if (!botStats.forget(tgId)) throw new Error("файл статистики не читается"); }],
    ["копии заданий и данных приложения", async () => {
      await removeMatching(join(DIR, "cloud"), new RegExp(`^${tgId}\\.(prev\\.)?json\\.bad-`));
      await removeMatching(join(DIR, "jobs"), new RegExp(`^${tgId}-\\d+\\.json\\.bad-`));
      await removeMatching(join(DIR, "checks"), new RegExp(`^${tgId}-\\d+\\.json\\.bad-`));
    }],
    ...caches(tgId),
  ]));
  // Запись пользователя — последней, и только когда учёт пробного обезличен (иначе номер учётки Moodle потерян).
  if (!trial.length) failed.push(...await run(tgId, [["запись пользователя", () => users.eraseProfile(tgId)]]));
  else failed.push("запись пользователя");
  if (failed.length) {
    console.error(`purge ${tgId}: отзыв согласия — не стёрто: ${failed.join(", ")}`);
    void notify.send(users.OWNER_ID, `⚠️ Doodle: человек ${tgId} отозвал согласие, но не всё удалось стереть: ${failed.join(", ")}. Подробности в server.log. Оставшееся нужно удалить вручную.`).catch(() => {});
  }
  return failed;
}
