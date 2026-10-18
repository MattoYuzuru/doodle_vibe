// Сервер мини-приложения Джарвиса: отдаёт собранное приложение (web/dist) и данные из Moodle для каждого пользователя.
// Пользователь опознаётся по подписанному Telegram initData; его токен Moodle хранится зашифрованным (users.mjs).
// Токен бота (для проверки подписи) читается из bot-token.txt рядом.
// Запуск: node server.mjs (127.0.0.1:8787)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { basename, join, extname, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as admission from "./admission.mjs";
import * as attendance from "./attendance.mjs";
import * as calendar from "./calendar.mjs";
import { tunnelState, watchCalendarTunnel } from "./cal-tunnel.mjs";
import * as campus from "./campus.mjs";
import * as courseSheets from "./course-sheets.mjs";
import * as ej from "./ej.mjs";
import * as lab from "./lab.mjs";
import * as labTrial from "./lab-trial.mjs";
import * as lessons from "./lessons.mjs";
import * as moodle from "./moodle.mjs";
import * as news from "./news.mjs";
import * as notify from "./notify.mjs";
import { groupList, schedule } from "./schedule.mjs";
import { watchGateway } from "./gateway-watch.mjs";
import { watchTunnelUrl } from "./tunnel-url.mjs";
import * as usage from "./usage.mjs";
import * as rate from "./ratelimit.mjs";
import { watchBackup } from "./backup.mjs";
import { watchGuard } from "./guard-watch.mjs";
import * as users from "./users.mjs";
import * as pace from "./moodle-pace.mjs";
import { isStateReadError, onCorrupt } from "./state-file.mjs";
import * as welcome from "./welcome.mjs";
import * as bots from "./bots.mjs";
import * as chats from "./chats.mjs";
import * as botCommands from "./bot-commands.mjs";
import * as terms from "./terms.mjs";
import * as cloudBackup from "./cloud-backup.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(DIR, "web", "dist");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const BOT_TOKEN = bots.hasBot; // есть ли токен основного бота (сам токен — только в bots.mjs)

/*
 * Испорченный файл данных (15 окт 2026, находка ревью #4). state-file.mjs откладывает его в «<имя>.bad-<время>» и дальше
 * считает файл отсутствующим (users/<id>.json — человек «вышел», выбор курсов пропал) или ошибкой (chats.json — беседы
 * стоят до ручной правки). Вся эта политика держится на том, что владелец узнает и поправит руками, а видел он только
 * строку в журнале. Теперь — сообщение от бота: путь относительно папки приложения и имя отложенной копии, без
 * содержимого файла (в нём токены и личные данные). state-file сам пишет не чаще раза в сутки на файл. Копии дедлайнов
 * (deadlines-cache) — кэш: испорченная удаляется сама при старте и чистке, сообщать о ней незачем. Файлы, прочитанные
 * ещё при загрузке модулей (moodle-pace, bot-stats), — раньше этой строки: о них остаётся только журнал.
 */
onCorrupt((path, bad) => {
  if (moodle.isDiskCopyPath(path)) return;
  const rel = relative(DIR, path) || basename(path);
  return notify.send(users.OWNER_ID, `⚠️ Doodle: испорчен файл данных ${rel} — он отложен в ${basename(bad)} и пока считается пустым (или не читается). Чтобы восстановить: остановите сервер (когда не идёт лаба), верните содержимое из копии и запустите снова — правка при работающем сервере будет затёрта.`).catch(() => {});
});
/*
 * Отложенные испорченные копии (*.bad-*) — 15 окт 2026, находка ревью #25. В них целиком прежний файл: в users/ —
 * зашифрованный токен Moodle, куки журнала, ФИО; в lessons/ — замечания человека, отказавшегося делиться. Раньше их
 * никто не удалял: они переживали выход и каждый день уходили в резервную копию. Теперь копия старше 30 дней удаляется
 * (времени владельцу на ручную правку хватает) — при старте и раз в сутки, по времени файла, содержимое не читается.
 * Выход удаляет копии users/<id>.json.bad-* этого человека сразу (см. /api/logout). Папки — те, где state-file
 * читает файлы людей; lessons и usage — с теми же переменными окружения, что у их модулей (стенды).
 */
const BAD_DIRS = ["users", "notify", "jobs", "checks", "cloud", process.env.LESSONS_DIR || "lessons", "course-styles", process.env.USAGE_STORE_DIR || "usage"].map((d) => resolve(DIR, d));
const BAD_KEEP_MS = 30 * 24 * 3600e3;
async function cleanBadCopies() {
  let n = 0;
  for (const dir of BAD_DIRS) {
    for (const f of await readdir(dir).catch(() => [])) {
      if (!f.includes(".bad-")) continue;
      const p = join(dir, f);
      const old = await stat(p).then((s) => s.isFile() && Date.now() - s.mtimeMs > BAD_KEEP_MS, () => false);
      if (old && await unlink(p).then(() => true, () => false)) n++;
    }
  }
  if (n) console.log(`state-file: удалено отложенных испорченных копий старше 30 дней: ${n}`);
  return n;
}
/** Выход: копии users/<id>.json.bad-* этого человека (токен, куки журнала) не должны пережить его выход. */
async function dropUserBadCopies(tgId) {
  const dir = join(DIR, "users"), pre = `${Number(tgId)}.json.bad-`;
  for (const f of await readdir(dir).catch(() => [])) if (f.startsWith(pre)) await unlink(join(dir, f)).catch(() => {});
}
void cleanBadCopies().catch(() => {});
// Последняя страховка (17 окт 2026, ревью): забытый .catch у фонового промиса в Node 15+ завершает весь процесс — со
// всеми идущими лабами и уведомлениями. Такой отказ — ошибка в коде: пишем в журнал со стеком, процесс живёт.
process.on("unhandledRejection", (e) => console.error(`${new Date().toISOString()} необработанная ошибка (unhandledRejection): ${e?.stack || e}`));
setInterval(() => { void cleanBadCopies().catch(() => {}); }, 24 * 3600e3).unref();

// Раз в час: для каждого вошедшего пользователя свежие данные из Moodle → напоминания и новые оценки в Telegram.
// Каждые 15 минут: внезапно появившийся тест должен быть замечен быстро (см. notify.check — «новые работы»).
const NOTIFY_EVERY = Number(process.env.NOTIFY_EVERY_MS) || 10 * 60 * 1000; // общий обход: объявления не чаще его шага (10 мин с 9 окт 2026)
// Обход всех пользователей может занять больше интервала (много людей, медленный Moodle) — следующий запуск тогда
// пропускаем, а не пускаем второй обход поверх первого.
/*
 * Нагрузка на Moodle (просьба владельца, 5 окт 2026: массовые запросы с одного адреса — риск блокировки). Было: каждые
 * 15 минут полное перечитывание дедлайнов каждого пользователя (~50 запросов залпом) и каждые 2 минуты опрос тестов,
 * круглосуточно — около 6,5 тыс. запросов в сутки на человека. Стало:
 *  - дедлайны читаются пакетными вызовами (~5 запросов, moodle.mjs) и только когда устарели: днём раз в полчаса, ночью
 *    раз в два часа, у тех, кто неделю не открывал приложение, — раз в час. Сам обход идёт по-прежнему каждые 15 минут
 *    (напоминания считаются по времени), но чаще всего работает с уже прочитанными данными;
 *  - опрос тестов — раз в 5 минут и только днём (ночью тесты не открывают); с 15 окт 2026 — раз в 45 с, материалы
 *    курсов — общей проверкой на курс раз в минуту (см. QUICK_EVERY, materialsTick);
 *  - пользователи разнесены во времени (у каждого свой постоянный сдвиг), между ними пауза; запросы идут через общую
 *    очередь не чаще раза в секунду (moodle-pace.mjs);
 *  - Moodle отказал или не отвечает — обходы встают на паузу, владельцу сообщение; недействительный токен — этого
 *    пользователя не опрашиваем 6 часов;
 *  - отметки «когда читали» переживают перезапуск сервера: перезапуск больше не означает полный обход всех.
 */
const MOODLE_HOST = new URL(users.BASE).hostname;
const MIN = 60e3;
// Сроки и оценки — раз в час (18 окт 2026, решение владельца; было раз в полчаса): срочное узнаём раньше по сигналу курса —
// изменился тест или задание (news.workChangedSince), и сроки этого человека перечитываются на ближайшем обходе.
const FULL_EVERY = Number(process.env.MOODLE_FULL_EVERY_MS) || 60 * MIN;
// Опрос тестов — раз в 45 с (15 окт 2026, владелец: «задержка до 1 минуты»; МИСИС на число запросов с одного адреса не
// реагирует). Отказы Moodle (403/429) по-прежнему ставят все фоновые обходы на паузу (moodle-pace).
const QUICK_EVERY = Number(process.env.QUICK_EVERY_MS) || 45e3;
// С 15 окт 2026 (решение владельца) тесты человека спрашиваются, только если в его курсах что-то менялось с прошлого
// настоящего опроса (news.quietSince — по ответам проверки материалов), но не реже раза в QUICK_FULL_EVERY: тест только
// для другой группы курса или ставший доступным по дате изменением модуля не виден.
// 18 окт 2026 (решение владельца): страховочный опрос — раз в 15 минут вместо 5. Тишину теперь стирает только изменение
// работ (news.mjs WORK), а тест другой группы или скрытый тест — это модуль, невидимый человеку, он тишину тоже стирает;
// время открытия известного теста ловят таймеры planOpen.
const QUICK_FULL_EVERY = Math.max(QUICK_EVERY, Number(process.env.QUICK_FULL_EVERY_MS) || 15 * MIN);
const NIGHT = /^(\d{1,2})-(\d{1,2})$/.exec(process.env.MOODLE_NIGHT ?? "0-7"); // часы по Москве; MOODLE_NIGHT=off — без ночного режима
const isNight = () => {
  if (!NIGHT) return false;
  const h = Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/Moscow", hour: "2-digit", hour12: false })) % 24;
  const from = Number(NIGHT[1]), to = Number(NIGHT[2]);
  return from <= to ? h >= from && h < to : h >= from || h < to;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUIET = process.env.MOODLE_PACE === "0"; // стенд: без пауз
// Постоянный множитель интервала для пользователя (0,85…1,15): обходы разных людей не попадают в одну секунду.
const spread = (tgId) => (QUIET ? 1 : 0.85 + (Number(tgId) % 31) / 100);
// Давно не открывал приложение (больше недели) — опрашиваем реже. Пока отметки нет, считаем активным.
const inactive = (tgId) => { const seen = pace.stampAt(`seen:${tgId}`); return !!seen && Date.now() - seen > 7 * 24 * 3600e3; };
// Недействительный токен: tgId → { until, token } — этого пользователя не опрашиваем, пока он не войдёт заново. Отметка
// привязана к самому токену: новый вход даёт новый токен, и опрос возобновляется сразу, а не через 6 часов.
const badTokens = new Map();
const tokenBad = (u) => { const b = badTokens.get(u.tgId); return !!b && b.token === u.token && b.until > Date.now(); };
function noteTickError(u, what, e) {
  if (e?.name === "PausedError") return; // пауза Moodle: о ней уже написано один раз (moodle-pace)
  if (u.token && /invalidtoken|invalid token|token expired|accessexception/i.test(String(e?.message || e)) && !tokenBad(u)) {
    badTokens.set(u.tgId, { until: Date.now() + 6 * 3600e3, token: u.token });
    console.log(`${what} ${u.tgId}: токен Moodle недействителен — фоновый опрос этого пользователя остановлен на 6 часов (нужен новый вход)`);
    return;
  }
  console.log(`${what} ${u.tgId}: ` + (e?.message || e));
}
// Данных в памяти нет (сервер перезапущен, кэш сброшен после отправки работы) — читаем, не дожидаясь планового срока,
// но не чаще этого: серия перезапусков не должна давать серию полных чтений.
const REREAD_MIN = Math.min(10 * MIN, FULL_EVERY);
/**
 * Дедлайны для фонового обхода: из Moodle — только если устарели; иначе уже прочитанные (после перезапуска — копия с
 * диска, moodle.restoreDisk; с ней перечитывание идёт по обычному графику, а не всех разом). { d, read }: d — данные или
 * null (читать ещё рано и нечего показать), read — прочитаны из Moodle в этом обходе (не прежние и не копия с диска).
 */
async function freshDeadlines(u) {
  const key = `full:${u.tgId}`, have = moodle.staleDeadlines(u.token);
  if (tokenBad(u) || pace.paused(MOODLE_HOST)) return { d: have, read: false };
  // Срок чуть меньше FULL_EVERY (часа): обход идёт раз в 10 минут, и чтение приходится на каждый шестой (ночью — раз в
  // четыре часа, у давно не открывавших приложение — раз в два часа).
  const every = (isNight() ? 4 : inactive(u.tgId) ? 2 : 1) * FULL_EVERY * 0.9;
  const last = Math.max(moodle.deadlinesAt(u.token), pace.stampAt(key));
  // В курсе человека изменился тест или задание после прошлого чтения — читаем сейчас, не дожидаясь планового срока.
  const signal = !!have?.courses?.length && news.workChangedSince(have.courses.map((c) => c.id), last);
  if (!signal && Date.now() - last < (have ? every : REREAD_MIN)) return { d: have, read: false };
  let d;
  try { d = await moodle.deadlines(u.token, true); }
  catch (e) {
    // Moodle не ответил (сеть МИСИС, ПК только что проснулся) — напоминания о сроках считаются по времени, для них хватит
    // уже прочитанного: раньше весь обход пользователя пропускался, и «⏰ через 3 ч» опаздывало до ответа Moodle.
    // Отметку чтения не ставим — на следующем обходе снова попробуем прочитать.
    if (!have) throw e;
    noteTickError(u, "notify (по прочитанным ранее данным)", e);
    return { d: have, read: false };
  }
  pace.stamp(key, 0, true); // на диск сразу: отметка должна пережить перезапуск (процесс сервера убивают)
  // Паузы 1,5–4,5 с между людьми здесь больше нет (17 окт 2026, нагрузка на VPS): запросы и так идут через очередь фона
  // (не больше двух в секунду), а пауза только растягивала обход — при 300 людях 11 минут при шаге 10.
  return { d, read: true };
}
/*
 * Дедлайны с диска (moodle.mjs, 15 окт 2026): после перезапуска у всех вошедших данные есть сразу — фоновые обходы,
 * напоминания, бот и «Сессия» работают по копии, а приложение при медленном Moodle получает её с пометкой stale, а не
 * ждёт очереди. До таймеров и listen: первый обход и первый запрос уже видят восстановленные записи. Не вышло (список
 * вошедших не прочитался) — сервер всё равно стартует, просто как раньше, с пустым кэшем.
 */
let restoredCopies = 0;
try { restoredCopies = (await moodle.restoreDisk(await users.allLoggedIn())).restored; }
catch (e) { console.log(`deadlines-disk: копии не восстановлены (${e?.message || e})`); }
const startedAt = Date.now();
let notifyBusy = false, quickBusy = false;
async function notifyTick() {
  if (notifyBusy) return;
  notifyBusy = true;
  try {
    const all = await users.allLoggedIn(), fresh = new Map(), readNow = new Set(); // tgId → дедлайны этого обхода; кого прочитали из Moodle сейчас
    for (const u of all) {
      try {
        moodle.setOverrides(u.token, u.overrides, u.tgId);
        const { d, read } = await pace.background("notify", () => freshDeadlines(u));
        if (!d) continue; // данных ещё нет, а читать рано (недавний перезапуск) или Moodle на паузе
        fresh.set(u.tgId, d);
        if (read) readNow.add(u.tgId);
        const n = await notify.check(u.tgId, d.items, d.courses, d.updated);
        if (n) console.log(`notify ${u.tgId}: отправлено ${n}`);
        const asked = await notify.askCourses(u.tgId, d.pendingCourses);
        if (asked) console.log(`notify ${u.tgId}: вопросов о курсах ${asked}`);
        // Тест с временем открытия впереди мог найти именно этот обход (ночью быстрого опроса нет): таймер на открытие
        // ставим сразу, по списку ожидания, — в Moodle для этого не ходим.
        planOpen(u.tgId, await notify.quizWaiting(u.tgId));
        planReminders(u.tgId, await notify.reminderTimes(u.tgId, d.items));
      } catch (e) { noteTickError(u, "notify", e); }
    }
    // Вторым проходом — то, что не должно задерживать уведомления о работах: база замечаний, изменения расписания,
    // объявления и материалы курсов, журнал (у каждой проверки свой интервал — она сама решает, пора ли).
    for (const u of all) {
      // Объявления и материалы курсов — тоже чтение Moodle: ночью и на паузе не ходим.
      if (fresh.has(u.tgId) && !isNight() && !tokenBad(u) && !pace.paused(MOODLE_HOST)) await pace.background("news", () => watchCourses(u, fresh.get(u.tgId)));
      await pace.background("journal", () => watchJournal(u.tgId, fresh.get(u.tgId) ?? null));
      if (fresh.has(u.tgId)) await collectLessons(u.tgId, fresh.get(u.tgId));
      // Оценённая работа без замечаний к оформлению — образец оформления курса для следующих отчётов (lab.noteGrades).
      // Решение навсегда (job.styleSaved), поэтому только по данным, прочитанным из Moodle в этом обходе: не по копии
      // с диска и не по прежним данным при сбое Moodle.
      if (readNow.has(u.tgId)) await lab.noteGrades(u.tgId, fresh.get(u.tgId)).catch((e) => console.log(`styles ${u.tgId}: ${e.message || e}`));
      await watchSchedule(u.tgId);
    }
    await watchUsage();
  } catch (e) {
    // Обход целиком (например, не прочитался список вошедших): отказ из таймера никто не ловит, и Node завершил бы
    // процесс — поэтому только строка в журнал, следующий обход попробует снова.
    console.log(`notify: обход прерван (${e?.message || e})`);
  } finally { notifyBusy = false; }
}
setTimeout(notifyTick, 30 * 1000);
/*
 * Напоминания о сроках — в ту же минуту (жалоба владельца 15 окт 2026: «приходят с запозданием»). Обход идёт раз в
 * 10 минут, и «⏰ через 3 ч» уходило на 0–10 минут позже, плюс паузы между пользователями. Каждый обход говорит, когда
 * созреют ещё не отправленные напоминания (notify.reminderTimes), и сервер ставит таймер на это время (+2 с). В момент
 * таймера — проверка этого пользователя по уже прочитанным срокам, в Moodle не ходим. Дальние напоминания поставит один
 * из следующих обходов; изменившиеся настройки или отправленное раньше напоминание check учтёт сам.
 */
const remindTimers = new Map(); // `${tgId}:${работа}:${окно}` → { at, timer }
const REMIND_AHEAD = 6 * 3600e3;
function planReminders(tgId, list) {
  for (const r of list || []) {
    const key = `${tgId}:${r.key}`, cur = remindTimers.get(key);
    if (cur && cur.at === r.at) continue;
    if (cur) clearTimeout(cur.timer);
    const delay = r.at - Date.now() + 2000;
    if (delay > REMIND_AHEAD) { remindTimers.delete(key); continue; }
    const timer = setTimeout(() => { remindTimers.delete(key); void remindFire(tgId); }, Math.max(1000, delay));
    timer.unref?.();
    remindTimers.set(key, { at: r.at, timer });
  }
}
const remindBusy = new Set();
async function remindFire(tgId) {
  if (remindBusy.has(tgId)) return;
  remindBusy.add(tgId);
  try {
    const u = (await users.allLoggedIn()).find((x) => x.tgId === tgId);
    const d = u && moodle.staleDeadlines(u.token);
    if (!d) return; // данных нет (вышел из Moodle, перезапуск) — напоминание уйдёт с ближайшим обходом
    const n = await notify.check(tgId, d.items, d.courses, d.updated);
    if (n) console.log(`notify ${tgId}: по таймеру отправлено ${n}`);
  } catch (e) { console.log(`remind ${tgId}: ${e.message || e}`); }
  finally { remindBusy.delete(tgId); }
}
/** Профиль для приложения: к профилю пользователя — сколько процентов месячного лимита отчётов израсходовано (если лимит есть). */
async function me(tgId) {
  const p = await users.profile(tgId);
  const o = await usage.own(tgId).catch(() => null);
  // Пробный отчёт (lab-trial.mjs) — здесь, а не в users.profile: профиль зовут и фоновые обходы, а этому нужны папки заданий.
  // Не прочиталось — null: «не предлагать», а не «доступен».
  const trialView = p.labsAllowed ? null : await labTrial.view(tgId).catch(() => null);
  return { ...p, quota: o && o.limit != null ? { percent: o.percent, level: o.level } : null, labTrial: trialView, ...(labsOff() ? { labsOff: true } : {}) };
}
/*
 * Выключатель лаб (17 окт 2026, переезд на VPS): на сервере без агента (OpenClaw, Claude, LTspice) лаба упала бы с
 * «Служба OpenClaw не отвечает». Файл labs.off рядом с сервером или LABS_OFF=1 — действия, которые зовут агента
 * (начать, исправить, написать, «Кратко о работе», проверка отчёта, установка окружения), получают отказ labs_off,
 * а приложение показывает «Лабы временно недоступны». Готовые отчёты по-прежнему открываются, подтверждаются,
 * прикрепляются и отправляются в Moodle — агент для этого не нужен. Читается на каждом запросе: включается без перезапуска.
 */
const labsOff = () => process.env.LABS_OFF === "1" || existsSync(join(DIR, "labs.off"));
const AGENT_ACTIONS = new Set(["start", "fix", "message", "explain"]);
/** Число токенов для сообщений: «4,2 млн», «350 тыс.», «900». */
const fmtTok = (x) => (x >= 999500 ? `${(x / 1e6).toFixed(1).replace(".", ",").replace(/,0$/, "")} млн` : x >= 1000 ? `${Math.round(x / 1000)} тыс.` : String(Math.round(x)));
/** Лимит в сообщениях — без округления, тем же числом, что на экране владельца: «5 млн», «1,25 млн», «420 тыс.». */
const fmtLim = (x) => (x >= 1e6 ? `${String(x / 1e6).replace(".", ",")} млн` : x >= 1000 ? `${String(x / 1000).replace(".", ",")} тыс.` : String(x));
/** Месячный лимит отчётов: владельцу — сообщение, когда пользователь израсходовал 80 % и 100 % (по разу на порог и месяц). */
async function watchUsage() {
  try {
    const list = await usage.alerts({ mark: false }); // отметку «сообщено» ставим после отправки
    if (!list.length) return;
    const all = await users.listUsers(), app = await appUrl();
    let done = 0;
    for (const a of list) {
      const u = all.find((x) => x.tgId === a.tgId);
      const who = [u?.fullName || u?.tgName, u?.tgUsername ? "@" + u.tgUsername : null].filter(Boolean).join(" · ") || `id ${a.tgId}`;
      const spent = `Израсходовано ${fmtTok(a.used)} из ${fmtLim(a.limit)} токенов за месяц (${a.percent} %).`;
      const sent = await notify.send(users.OWNER_ID, a.level < 100 ? `⚠️ Лимит отчётов на исходе: ${who}\n${spent}`
        : a.closed ? `⛔ Лимит отчётов исчерпан: ${who}\n${spent} Работа с агентом этому пользователю закрыта до 1-го числа (готовый отчёт он может прикрепить и отправить) — или увеличьте лимит.`
          : `⛔ Лимит отчётов исчерпан: ${who}\n${spent} Новый отчёт, исправление и проверка отчёта этому пользователю закрыты до 1-го числа (начатую работу он может дописать, пока расход не дойдёт до 125 %) — или увеличьте лимит.`,
        undefined, app ? [[{ text: "Расход и лимиты", web_app: { url: `${app}/?open=usage` } }]] : undefined);
      // Не ушло (Telegram недоступен) — отметку не ставим: сообщение повторится на следующем обходе.
      if (sent === true) { await usage.markAlerted([a]); done++; }
    }
    if (done) console.log(`usage: предупреждений владельцу ${done}`);
  } catch (e) { console.log(`usage-watch: ${e.message || e}`); }
}
/** Расписание группы пользователя: изменения (перенос, отмена, новая пара, аудитория) — сообщением (notify.checkSchedule). */
async function watchSchedule(tgId) {
  try {
    const p = await users.profile(tgId);
    if (!p.group) return;
    const s = await schedule(p.group);
    const n = await notify.checkSchedule(tgId, p.group, p.subgroup || "1", s.lessons);
    if (n) console.log(`notify ${tgId}: изменений расписания ${n}`);
  } catch (e) { console.log(`schedule-watch ${tgId}: ${e.message || e}`); }
}
/** Объявления преподавателей активных курсов пользователя (news.mjs) — сообщениями бота. Материалы — materialsTick. */
async function watchCourses(u, d) {
  try {
    const prefs = await users.notifyPrefs(u.tgId);
    const n = await news.checkNews(u.tgId, u.token, d.courses, { mute: !prefs.news });
    if (n) console.log(`news ${u.tgId}: объявлений ${n}`);
  } catch (e) { console.log(`news ${u.tgId}: ${e.message || e}`); }
}
/*
 * Новые материалы курсов — в течение минуты (15 окт 2026; было раз в час на общем обходе). Отдельный обход раз в 15 с;
 * сама проверка у каждого пользователя не чаще раза в минуту, а курс, который только что проверил одногруппник, повторно
 * не запрашивается (news.checkMaterials, общая проверка курса). Ночью и на паузе Moodle — не ходим, как и раньше.
 */
const MATERIALS_TICK = Number(process.env.MATERIALS_TICK_MS) || 15e3;
// После старта с копиями дедлайнов с диска у всех разом появляется список курсов, и первая проверка материалов пошла бы
// по всем сразу — всплеск фоновой очереди рядом с чтениями общего обхода. Поэтому первые 2 минуты после такого старта
// проверку не запускаем. Без восстановленных копий всплеска нет (данные появляются по мере чтения) — и паузы нет.
const MATERIALS_START_DELAY_MS = /^\d+$/.test(process.env.MATERIALS_START_DELAY_MS || "") ? Number(process.env.MATERIALS_START_DELAY_MS) : 120e3;
let materialsBusy = false;
async function materialsTick() {
  if (materialsBusy || isNight() || pace.paused(MOODLE_HOST)) return;
  if (restoredCopies && Date.now() - startedAt < MATERIALS_START_DELAY_MS) return;
  materialsBusy = true;
  try {
    // Порядок (17 окт 2026): перед каждым следующим человеком — сначала те, в чьих курсах проверка одногруппника только
    // что нашла изменение, которого они ещё не видели (news.needsCheck). Раньше при 300 людях остальные студенты курса
    // ждали своей очереди в обходе по всем — «Новый материал» опаздывал больше чем на 5 минут.
    const rest = await users.allLoggedIn(), courseIds = (u) => moodle.staleDeadlines(u.token)?.courses?.map((c) => c.id) || [];
    while (rest.length) {
      const i = Math.max(0, rest.findIndex((x) => !tokenBad(x) && news.needsCheck(x.tgId, courseIds(x))));
      const u = rest.splice(i, 1)[0];
      const d = !tokenBad(u) && moodle.staleDeadlines(u.token);
      if (!d) continue; // список курсов ещё не прочитан — его прочитает общий обход
      try {
        const prefs = await users.notifyPrefs(u.tgId);
        // О заданиях и тестах со сроком уже пишет проверка работ — в «новых материалах» их не повторяем.
        const cmids = new Set(d.items.map((x) => { try { return Number(new URL(x.url).searchParams.get("id")); } catch { return 0; } }).filter(Boolean));
        const m = await pace.background("materials", () => news.checkMaterials(u.tgId, u.token, d.courses, { mute: !prefs.news, skipCmids: cmids }));
        if (m) console.log(`news ${u.tgId}: сообщений о материалах ${m}`);
      } catch (e) { if (e?.name === "PausedError") break; console.log(`news ${u.tgId}: ${e.message || e}`); }
    }
  } catch (e) { console.log(`materials: обход прерван (${e?.message || e})`); } // как у notifyTick: не ронять процесс
  finally { materialsBusy = false; }
}
setInterval(materialsTick, MATERIALS_TICK);
/*
 * Сигнал по курсу (18 окт 2026, news.probeSignal): раз в SIGNAL_EVERY каждый курс спрашивается один раз — токеном
 * первого из его студентов, пакетом на все курсы этого студента. По ответам опрос тестов пропускает тихие курсы, а
 * проверка материалов берёт общий ответ вместо своего запроса. Ночью и на паузе Moodle — не ходим, как и остальные.
 */
const SIGNAL_EVERY = Number(process.env.SIGNAL_EVERY_MS) || 30e3;
let signalBusy = false;
async function signalTick() {
  if (signalBusy || isNight() || pace.paused(MOODLE_HOST)) return;
  signalBusy = true;
  try {
    const by = new Map(), taken = new Set(); // пользователь → курсы, которые спрашивает он
    for (const u of await users.allLoggedIn()) {
      const d = !tokenBad(u) && moodle.staleDeadlines(u.token);
      const mine = (d?.courses || []).map((c) => Number(c.id)).filter((id) => !taken.has(id));
      if (!mine.length) continue;
      mine.forEach((id) => taken.add(id));
      by.set(u, mine);
    }
    for (const [u, ids] of by) {
      try {
        await pace.background("signal", () => news.probeSignal(u.token, ids)); // в журнал не пишем: изменения в курсах — каждые несколько минут
      } catch (e) { noteTickError(u, "signal", e); if (e?.name === "PausedError") break; }
    }
  } catch (e) { console.log(`signal: обход прерван (${e?.message || e})`); }
  finally { signalBusy = false; }
}
setInterval(signalTick, SIGNAL_EVERY);
/**
 * Пропуски, посещаемость и оценки ниже порога из электронного журнала (attendance.mjs) — сообщением бота. d — дедлайны
 * этого обхода (курсы Moodle семестра, без нового чтения Moodle): по ним бот спрашивает о дисциплинах журнала без курса.
 */
async function watchJournal(tgId, d) {
  try {
    const prefs = await users.notifyPrefs(tgId);
    const n = await attendance.checkJournal(tgId, { mute: !prefs.journal, app: await appUrl(), deadlines: d, night: isNight() });
    if (n) console.log(`journal-watch ${tgId}: строк о журнале ${n}`);
  } catch (e) { console.log(`journal-watch ${tgId}: ${e.message || e}`); }
}
/**
 * Вкладка «Журнал» (GET api/ej; POST api/ej/mine): посещаемость и успеваемость за текущий семестр (ej.mjs); refresh —
 * мимо 10-минутного запаса. Владельцу рядом пишется снимок сырых данных (ej-debug/, только его записи) — сверять разбор.
 * Таблицы преподавателей в курсах Moodle (course-sheets.mjs, 15 окт 2026): посещения и баллы по дисциплинам, о которых
 * журнал не знает, — и у тех, кто журнал не подключил (sheets — рядом с data, не внутри: data бывает null). Чтение
 * Moodle ждём не дольше 8 с — дальше уже прочитанное.
 * Дисциплины, которые студент назвал не своими (в боте или в «Сессии», admission.journalView, 16 окт 2026), — в
 * data.notMine, средние без них; их таблицы не отдаются (иначе всплыли бы отдельной карточкой). Таблицы сопоставляются
 * с полным журналом: взаимная пара курса и дисциплины считается по всем дисциплинам.
 */
async function ejView(tgId, { refresh = false } = {}) {
  const sheetsOf = (data, off) => admission.journalSheets(tgId, data, { live: true, waitMs: 8e3, fresh: refresh })
    .then((list) => (off?.size ? list.filter((x) => !off.has(String(x.ejId))) : list))
    .catch((e) => { console.log(`sheets ${tgId}: ${e.message || e}`); return []; });
  const view = async (data) => {
    const { data: shown, off } = await admission.journalView(tgId, data).catch((e) => { console.log(`journal-view ${tgId}: ${e.message || e}`); return { data, off: null }; });
    return { data: shown, sheets: await sheetsOf(data, off) };
  };
  let st = await users.ejState(tgId);
  // Сразу после входа в бот журнал подключается в фоне, а приложение уже спрашивает его — без ожидания вкладка
  // просила «введите пароль» у только что вошедшего (находка ревью 16 окт). Ждём подключение до 15 с.
  const pending = !st.connected && ej.connectingOf(tgId);
  if (pending) { await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 15e3))]); st = await users.ejState(tgId); }
  if (!st.connected) return { ...st, data: null, sheets: await sheetsOf(null) };
  try {
    const data = await ej.journal(tgId, { force: refresh, ...(tgId === users.OWNER_ID ? { debugDir: join(DIR, "ej-debug") } : {}) });
    return { ...(await users.ejState(tgId)), ...(await view(data)) };
  } catch (e) {
    if (e.code === "need_password" || e.code === "need_connect") return { ...(await users.ejState(tgId)), connected: false, needPassword: true, data: null, sheets: await sheetsOf(null) };
    console.log(`ej ${tgId}: ${e.message}`);
    // Журнал не ответил — прошлые данные и причина, ответом 200: код 502 Cloudflare подменяет своей страницей,
    // и в приложении вместо причины было «ошибка 502» (2 окт).
    return { ...(await users.ejState(tgId)), ...(await view(ej.lastGood(tgId))), loadError: String(e.message || e) };
  }
}
/** Замечания преподавателя к работам этого пользователя → общая база типичных замечаний (только с его согласия, lessons.mjs). */
async function collectLessons(tgId, d) {
  try {
    const c = await users.remarksConsent(tgId);
    if (!c.share) return;
    const added = await lessons.harvest(tgId, d.items, d.courses, { fullName: c.fullName, agentMade: (id) => lab.agentMade(tgId, id) });
    if (added) console.log(`lessons ${tgId}: +${added}`);
  } catch (e) { console.log(`lessons ${tgId}: ${e.message || e}`); }
}
setInterval(notifyTick, NOTIFY_EVERY);
// Быстрый опрос тестов (один вызов Moodle на пользователя): внезапный короткий тест → уведомление в течение минуты.
// Только днём; у давно не открывавших приложение — втрое реже и со своим сдвигом. Таймер обхода — раз в 10 с, иначе
// между отметкой «пора» и следующим обходом терялось бы до целого шага.
// Начало последнего удачного настоящего опроса тестов человека (мс) — только в памяти: после перезапуска «тихих» курсов
// в памяти нет, и первый опрос всё равно настоящий.
const quickFullAt = new Map();
async function quickTick() {
  if (quickBusy) return;
  quickBusy = true;
  try {
    if (isNight() || pace.paused(MOODLE_HOST)) return;
    for (const u of await users.allLoggedIn()) {
      const key = `quick:${u.tgId}`;
      if (tokenBad(u)) continue;
      // Сигнал по курсу нашёл изменение теста или задания после прошлого опроса этого человека — опрашиваем сразу, не
      // дожидаясь его обычного шага (18 окт 2026: иначе к задержке сигнала добавлялось до 45 с).
      const signalled = news.workChangedSince((moodle.staleDeadlines(u.token)?.courses || []).map((c) => c.id), pace.stampAt(key));
      if (!signalled && Date.now() - pace.stampAt(key) < (inactive(u.tgId) ? 3 * spread(u.tgId) : 1) * QUICK_EVERY) continue;
      // Курсы не менялись с прошлого настоящего опроса — тестов там новых нет, Moodle не спрашиваем (отметка — без записи
      // на диск: после перезапуска «тихих» курсов в памяти нет, и первый опрос всё равно настоящий).
      const lastFull = quickFullAt.get(u.tgId) || 0, d = moodle.staleDeadlines(u.token);
      if (lastFull && Date.now() - lastFull < QUICK_FULL_EVERY && d?.courses?.length && news.quietSince(d.courses.map((c) => c.id), Math.floor(lastFull / 1000) - 60)) { pace.stamp(key); continue; }
      // Отметка «настоящий опрос был» (full) — только после удачного: опрос, не дождавшийся очереди, раньше считался
      // сделанным, и при тихих курсах следующий шёл лишь через QUICK_FULL_EVERY (с 18 окт — 15 минут), а новый тест,
      // найденный сигналом до этого опроса, ждал столько же (стенд 18 окт: 2 из 25 без «Нового теста»).
      const pollAt = Date.now();
      pace.stamp(key, 0, true);
      try { moodle.setOverrides(u.token, u.overrides, u.tgId); const q = await pace.background("quick", () => moodle.quizzesQuick(u.token)); quickFullAt.set(u.tgId, pollAt); await notify.checkNew(u.tgId, q.items, q.courses); await afterQuick(u, q); }
      catch (e) { noteTickError(u, "quick", e); if (e?.name === "PausedError") break; }
      // Паузы 1,5–4,5 с между людьми здесь больше нет (15 окт 2026): очередь фона сама пропускает не больше двух запросов
      // в секунду, а пауза только удлиняла круг — при 50 людях до 3–4 минут вместо обещанных 45 с.
    }
  } catch (e) { console.log(`quick: обход прерван (${e?.message || e})`); } // как у notifyTick: не ронять процесс
  finally { quickBusy = false; }
}
/*
 * «Тест открыт» (просьба владельца, 5 окт 2026): сообщение не когда тест появился в курсе, а когда его действительно можно
 * начать. После каждого опроса тестов notify.checkOpen говорит, каких открытий ждать, и сервер ставит таймер на само время
 * открытия (плюс несколько секунд): сообщение приходит в ту же минуту, а не при следующем опросе. В момент таймера —
 * один опрос тестов этого пользователя и один вопрос Moodle «можно ли начать» (2 запроса). Работает и ночью: время
 * известно заранее. Если тест к этому времени ещё закрыт (преподаватель придержал) — проверка повторяется раз в 2 минуты.
 */
const openTimers = new Map(); // `${tgId}:${id теста}` → { at, timer }
function planOpen(tgId, waiting) {
  for (const w of waiting || []) {
    const key = `${tgId}:${w.id}`, cur = openTimers.get(key);
    // Таймер уже стоит не позже нужного — оставляем (повторные вызовы не отодвигают проверку); нужен раньше — переставляем.
    if (cur && cur.at <= w.at + 1000) continue;
    if (cur) clearTimeout(cur.timer);
    const delay = w.at - Date.now() + 4000;
    if (delay > 7 * 24 * 3600e3) continue; // дальние открытия поставит один из следующих опросов
    const timer = setTimeout(() => { openTimers.delete(key); void openFire(tgId); }, Math.max(1000, delay));
    timer.unref?.();
    openTimers.set(key, { at: w.at, timer });
  }
}
async function afterQuick(u, q) {
  const r = await notify.checkOpen(u.tgId, q.items, q.courses, (ids) => pace.background("quiz-open", () => moodle.quizAccess(u.token, ids)));
  if (r.sent) console.log(`notify ${u.tgId}: открывшихся тестов ${r.sent}`);
  planOpen(u.tgId, r.waiting);
}
const openBusy = new Set(), openFails = new Map(); // openFails: tgId → сколько проверок открытия подряд не удалось
async function openFire(tgId) {
  if (openBusy.has(tgId)) return;
  openBusy.add(tgId);
  let again = 0, u = null; // again — через сколько мс повторить, если сейчас проверить не получилось
  try {
    u = (await users.allLoggedIn()).find((x) => x.tgId === tgId);
    if (!u || tokenBad(u)) return;
    const p = pace.paused(MOODLE_HOST);
    if (p) { again = p.until - Date.now() + 5000; return; }
    moodle.setOverrides(u.token, u.overrides, u.tgId);
    const q = await pace.background("quiz-open", () => moodle.quizzesQuick(u.token));
    await notify.checkNew(u.tgId, q.items, q.courses);
    await afterQuick(u, q);
    openFails.delete(tgId);
  } catch (e) {
    noteTickError(u || { tgId }, "quiz-open", e);
    again = e?.name === "PausedError" && e.until ? e.until - Date.now() + 5000 : 2 * MIN;
  } finally {
    openBusy.delete(tgId);
    // Проверить не получилось (сеть, пауза) — повторяем сами, не дожидаясь обычного опроса: ночью его нет до утра.
    // Не больше пяти раз подряд: при долгом сбое остаётся обычный опрос.
    if (again > 0) {
      const n = (openFails.get(tgId) || 0) + 1;
      openFails.set(tgId, n);
      if (n <= 5) planOpen(tgId, [{ id: "retry", at: Date.now() + again }]);
    }
  }
}
// После перезапуска таймеры ставятся заново по сохранённому списку ожидаемых открытий (в Moodle для этого не ходим).
// Ошибка у одного человека (не прочитался его файл уведомлений) не должна оставить без таймеров остальных.
setTimeout(async () => {
  let all = [];
  try { all = await users.allLoggedIn(); } catch (e) { return console.log(`quiz-open: ${e.message || e}`); }
  for (const u of all) {
    try { planOpen(u.tgId, await notify.quizWaiting(u.tgId)); }
    catch (e) { console.log(`quiz-open ${u.tgId}: ${e.message || e}`); }
  }
}, 15e3).unref?.();
// Отказы Moodle и долгие сбои — владельцу от бота; раз в час — строка в журнал: сколько запросов ушло к сайтам МИСИС.
pace.onAlert((text) => notify.send(users.OWNER_ID, text));
setInterval(() => {
  const d = pace.stats().today;
  if (d) console.log(`moodle-load: за сегодня ${d.total} запросов к сайтам МИСИС (фон ${d.bg}, люди ${d.user}, сбоев ${d.fail}), пик ${d.peakMin} в минуту`);
}, 60 * MIN).unref();
// Вход: не больше 5 отклонённых Moodle попыток за 5 минут на пользователя Telegram — сервер открыт всем, а перебор
// паролей через него кончился бы блокировкой учётной записи или адреса этого ПК в Moodle. Сетевые сбои не считаются.
const loginFails = new Map(); // tgId → [время неудачных попыток]
const recentFails = (tgId) => (loginFails.get(tgId) || []).filter((t) => Date.now() - t < 5 * 60e3);
setTimeout(quickTick, 45 * 1000);
setInterval(quickTick, Math.min(10e3, QUICK_EVERY));
watchTunnelUrl();
// Постоянный адрес для подписки на календарь (второй туннель, только путь /cal/) — см. cal-tunnel.mjs.
watchCalendarTunnel(PORT);
// Ежедневная копия данных (пользователи, задания, лимиты…) — backup.mjs; о сбое копии владелец узнаёт от бота (не чаще раза в сутки).
let backupAlertAt = 0;
// Отправку «бросаем» (void), поэтому .catch: отказ, который никто не ждёт, Node считает необработанным и завершает процесс.
watchBackup({ onError: (e) => { if (Date.now() - backupAlertAt < 86400e3) return; backupAlertAt = Date.now(); void notify.send(users.OWNER_ID, `⚠️ Ежедневная копия данных Doodle не получилась: ${String(e.message || e).slice(0, 200)}`).catch(() => {}); } });
// Зависший Gateway OpenClaw (порт открыт, ответа нет) перезапускается сам; владельцу — сообщение от бота.
watchGateway({ notify: (text) => notify.send(users.OWNER_ID, text) });
// Сторож агента (ops\agent-guard) должен оставаться подключённым в настройках Claude Code; пропал — владельцу сообщение.
watchGuard({ notify: (text) => notify.send(users.OWNER_ID, text) });
// Ответ бота на /start и карточки «Что умеет Doodle» — только когда сообщения бота получает этот сервер (welcome.mjs).
welcome.watchUpdates({ onCommand: botCommands.answer, onCallback: botCommands.callback, onFirstStart: botCommands.started, menu: botCommands.LIST });
// Общие беседы, привязанные к группе (chats.mjs): изменения расписания — сообщением в беседу, обход раз в 15 минут.
setInterval(() => { void chats.tick().then((n) => { if (n) console.log(`беседы: изменений расписания ${n}`); }, (e) => console.log(`беседы: ${e.message || e}`)); }, Number(process.env.CHATS_TICK_MS) || 15 * MIN).unref();
// Уведомления по курсам в беседах (chats.relayTick): напоминания за сутки, экзамены группы, повтор не ушедшего — раз в минуту.
// Данные — уже прочитанные сервером (дедлайны источника, файлы сессии), в Moodle этот обход не ходит.
setInterval(() => { void chats.relayTick().then((n) => { if (n) console.log(`беседы: уведомлений по курсам ${n}`); }, (e) => console.log(`беседы: ${e.message || e}`)); }, Number(process.env.CHATS_RELAY_MS) || MIN).unref();
// Утренняя сводка тем, кто её включил (/digest): проверка раз в 5 минут, каждому — раз в день в его час.
setInterval(() => { void botCommands.digestTick().then((n) => { if (n) console.log(`сводка: отправлено ${n}`); }, (e) => console.log(`сводка: ${e.message || e}`)); }, Number(process.env.DIGEST_TICK_MS) || 5 * MIN).unref();
// Сессия: сводка за 14 и 3 дня до неё, напоминания накануне и в день экзамена (admission.mjs; о новом расписании
// экзаменов admission узнаёт сам от session.mjs).
setInterval(() => { void admission.tick().then((n) => { if (n) console.log(`сессия: отправлено ${n}`); }, (e) => console.log(`сессия: ${e.message || e}`)); }, Number(process.env.SESSION_TICK_MS) || 5 * MIN).unref();
// Сводка владельцу раз в неделю — в понедельник после 10:00 мск (то же по команде /stats): люди, активность, нагрузка.
setInterval(async () => {
  try {
    const now = new Date(Date.now() + 3 * 3600e3); // время по Москве
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 10 || Date.now() - pace.stampAt("weekly-report") < 6 * 24 * 3600e3) return;
    if (await notify.send(users.OWNER_ID, await botCommands.ownerReport()) === true) pace.stamp("weekly-report", 0, true);
  } catch (e) { console.log(`weekly-report: ${e.message || e}`); }
}, 30 * MIN).unref();
// После пробуждения ПК быстрый туннель обычно уже мёртв (Cloudflare удаляет его за время долгого сна), а сторож по
// расписанию приходит раз в 30 минут: 1 окт 2026 приложение после пробуждения было недоступно 12 минут, пока туннель
// не перезапустили вручную. Поэтому после сна сторож запускается сразу: через минуту и ещё раз через пять.
lab.onWake(() => {
  for (const ms of [60e3, 5 * 60e3]) setTimeout(() => {
    spawn(process.execPath, [join(DIR, "..", "ops", "app-watchdog.mjs")], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  }, ms);
  // Напоминания, которые должны были уйти, пока ПК спал, — сразу после пробуждения, а не на очередном шаге обхода (до
  // 10 минут). Полминуты — сети подняться; Moodle всё равно не ответит — напоминания уйдут по прочитанным ранее срокам.
  setTimeout(() => void notifyTick(), 30e3).unref?.();
});

const INIT_MAX_AGE_S = Number(process.env.INIT_MAX_AGE_S) || 2 * 86400;
// Проверка initData по алгоритму Telegram: HMAC-SHA256 с ключом HMAC("WebAppData", BOT_TOKEN). Возвращает Telegram id,
// null (подписи нет или она неверная) или "expired" (подпись верная, но старая).
function telegramId(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  if (!bots.signedBy(dataCheck, hash)) return null;
  // Подпись выдаётся при открытии мини-приложения. Два дня (было семь): перехваченной подписью нельзя пользоваться долго,
  // а приложение, не закрывавшееся дольше, просит открыть его заново.
  if (Date.now() / 1000 - Number(params.get("auth_date")) > INIT_MAX_AGE_S) return "expired";
  try { const id = Number(JSON.parse(params.get("user")).id); return Number.isFinite(id) ? id : null; } catch { return null; }
}

/*
 * Вход без подписи Telegram («это владелец, он на этом же ПК») закрыт, пока явно не включён: переменной LOCAL_OWNER=1
 * (так запускаются стенды) или пустым файлом local-owner.flag рядом с сервером. Раньше владельцем считался любой запрос
 * без подписи и без заголовков Cloudflare/ngrok: сервер слушает 127.0.0.1, туннели работают на этом же ПК, поэтому адрес
 * соединения всегда местный — и с другим туннелем или обратным прокси владельцем стал бы кто угодно из интернета.
 * Даже во включённом режиме: только соединение с этого ПК, обращение по местному адресу и ни одного заголовка пересылки.
 */
const LOCAL_OWNER = process.env.LOCAL_OWNER === "1" || existsSync(join(DIR, "local-owner.flag"));
const FORWARDED = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via"];
const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(ip || "");
/** Кто спрашивает: Telegram id по подписи. Подпись устарела — req.authExpired (приложение попросит открыть его заново). */
function whoIs(req) {
  const initData = req.headers["x-telegram-init-data"];
  const id = telegramId(initData);
  if (id === "expired") { req.authExpired = true; return null; }
  if (id) return id;
  if (initData) return null; // подпись есть, но неверная (подделка или чужой бот) — не подменяем владельцем даже с этого ПК
  if (!LOCAL_OWNER) return null;
  if (FORWARDED.some((h) => req.headers[h]) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || "")) return null;
  return isLoopback(req.socket.remoteAddress) ? users.OWNER_ID : null;
}

/*
 * Пределы частоты запросов (ratelimit.mjs). Значения с запасом для обычной работы: приложение опрашивает сервер раз
 * в 3–15 секунд (до ~50 запросов в минуту на человека), а за одним адресом может сидеть целая аудитория на вузовском
 * Wi-Fi. Переменные окружения — для стенда.
 */
const RL = {
  ip: Number(process.env.RATE_IP_PER_MIN) || 1500,            // все запросы с одного адреса, в минуту
  user: Number(process.env.RATE_USER_PER_MIN) || 300,         // запросы API одного пользователя Telegram, в минуту
  refresh: Number(process.env.RATE_REFRESH_PER_MIN) || 2,    // принудительное обновление из Moodle и журнала, в минуту
  upload: Number(process.env.RATE_UPLOAD_PER_10MIN) || 15,    // загрузки файлов одного пользователя, за 10 минут
  miss: Number(process.env.RATE_MISS_PER_10MIN) || 30,        // промахи с одного адреса: неверная подпись, чужой секрет ссылки
  diag: 6,                                                    // записи диагностики одного пользователя, за 10 минут
};

// Тело запроса — JSON не больше 1 МБ: сервер открыт всем, кто вошёл в бота, без предела один клиент мог бы занять всю память.
// Лишнее дочитываем и выбрасываем, а запрос отклоняем (413) — обработчик дальше не идёт и ничего не перезаписывает пустым телом.
const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
  // Куски собираются байтами и превращаются в текст один раз: иначе русская буква на стыке кусков портилась бы.
  let parts = [], size = 0, tooBig = false;
  req.on("data", (d) => { if (tooBig) return; parts.push(d); size += d.length; if (size > limit) { tooBig = true; parts = []; } });
  req.on("end", () => {
    if (tooBig) return reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 }));
    try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { resolve({}); }
  });
  req.on("error", (e) => reject(e));
});

// Тело запроса как есть (файл, который студент прикрепляет из приложения), не больше limit. Лишнее дочитывается и
// выбрасывается, запрос отклоняется с 413.
const MAX_UPLOAD = 20 << 20;
const readRaw = (req, limit = MAX_UPLOAD) => new Promise((resolve, reject) => {
  const parts = []; let size = 0, tooBig = false;
  req.on("data", (d) => { if (tooBig) return; size += d.length; if (size > limit) { tooBig = true; parts.length = 0; } else parts.push(d); });
  req.on("end", () => (tooBig ? reject(Object.assign(new Error(`Файл слишком большой (больше ${limit >> 20} МБ)`), { status: 413 })) : resolve(Buffer.concat(parts))));
  req.on("error", (e) => reject(e));
});
// Имя прикрепляемого файла из заголовка: без путей и служебных символов, всегда .pdf.
function uploadName(header) {
  let n = "";
  try { n = decodeURIComponent(String(header || "")); } catch { n = ""; }
  n = n.split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, "_").trim().slice(0, 120);
  if (!n || n === ".pdf") n = "Отчёт.pdf";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

// Страница-прокладка «в Moodle»: кнопки Telegram принимают только http(s), а приложение Moodle открывается по
// moodlemobile://<wwwroot>?redirect=<url> (формат с версии 3.7). Пробуем приложение; если через 1,5 с всё ещё здесь (приложения нет) — идём на сайт.
const esc = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// Строка для встроенного <script>: JSON.stringify не экранирует «<», а «</script>» внутри адреса оборвал бы скрипт (XSS).
const js = (t) => JSON.stringify(t).replace(/</g, "\\u003c").replace(new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16));
const goMoodlePage = (u) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Открываю Moodle…</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}
a{display:block;margin:10px auto;max-width:320px;padding:14px 18px;border-radius:14px;background:#2f7bf6;color:#fff;text-decoration:none;font-weight:600}a.web{background:#1c1c1e}</style></head>
<body><div><p>Открываю Moodle…</p><a href="moodlemobile://https://newlms.misis.ru?redirect=${esc(u)}">Открыть в приложении Moodle</a><a class="web" href="${esc(u)}">Открыть на сайте</a></div>
<script>(function(){var app="moodlemobile://https://newlms.misis.ru?redirect="+${js(u)},web=${js(u)},left=false;
function hide(){if(document.visibilityState==="hidden")left=true}document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",function(){left=true});
setTimeout(function(){if(!left&&document.visibilityState==="visible")location.replace(web)},1500);location.href=app;})();</script></body></html>`;

/** Текущий адрес приложения (быстрый туннель; пишет tunnel-url.mjs). */
const appUrl = () => readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim().replace(/[/]+$/, ""), () => "");
// Страница-переходник для подписки на календарь: открывается в браузере телефона и сразу ведёт в календарь (iPhone —
// по ссылке webcal://, Google — на страницу «Добавить календарь по URL»); ниже — та же ссылка кнопкой и текстом.
const goCalendarPage = (to, l) => {
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(l.webcal)}`;
  const target = to === "google" ? google : l.webcal;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Календарь Doodle</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}
div{max-width:340px;padding:0 20px}a{display:block;margin:12px auto;padding:14px 18px;border-radius:14px;background:#2f7bf6;color:#fff;text-decoration:none;font-weight:600}
p.s{color:#9a9aa0;font-size:13px;word-break:break-all}</style></head>
<body><div><p>${to === "google" ? "Открываю Google Календарь…" : "Открываю календарь…"}</p><a href="${esc(target)}">${to === "google" ? "Добавить в Google Календарь" : "Подписаться на календарь"}</a>
<p class="s">${to === "google" ? "Если страница Google не открылась: на компьютере откройте calendar.google.com → «Другие календари» → «Добавить по URL» и вставьте ссылку:" : "Если календарь не открылся, добавьте подписку вручную по ссылке:"}<br>${esc(l.url)}</p></div>
<script>setTimeout(function(){location.href=${js(target)}},300);</script></body></html>`;
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff" };
// Сжатые копии файлов сборки (имена с хешем → можно кэшировать надолго); index.html и API — без кэша.
const gzCache = new Map();

createServer(async (req, res) => {
  // Разбор адреса — до общего try: путь «//», «///» new URL не принимает, и исключение роняло весь процесс — любой мог
  // остановить сервер одним запросом через туннель (проверка 15 окт).
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); return res.end("bad request"); }
  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const send = (code, body, type = "application/json; charset=utf-8", extra = {}) => {
    // Заголовки уже ушли (ошибка посреди ответа) — второй writeHead бросил бы исключение и уронил процесс: закрываем соединение.
    if (res.headersSent) { res.destroy(); return; }
    const headers = { "content-type": type, "cache-control": "no-store", ...extra };
    let out = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (acceptsGzip && code === 200 && !extra["content-encoding"] && Buffer.byteLength(out) > 1024 && /json|text|javascript|svg/.test(type)) {
      out = gzipSync(out); headers["content-encoding"] = "gzip";
    }
    res.writeHead(code, headers);
    res.end(out);
    // Журнал только для API (статика не нужна): время, кто, метод, путь, код — чтобы с телефона было понятно, что дошло до сервера.
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") console.log(`${new Date().toISOString()} ${req.tgId ?? "-"} ${req.method} ${url.pathname} ${code}${code >= 400 ? " " + String(typeof body === "object" && body?.error || "").slice(0, 80) : ""}`);
  };
  // Ограничение частоты (ratelimit.mjs). ip — адрес клиента по заголовку туннеля; «local» — запрос с этого же ПК.
  const ip = rate.clientIp(req);
  const tooMany = (r, what) => {
    if (r.first) console.log(`${new Date().toISOString()} rate: ${what} — предел превышен, отказы следующие ${r.wait} с`); // одна строка на окно, а не на каждый отказ
    res.writeHead(429, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(r.wait) });
    res.end(JSON.stringify({ error: "Слишком много запросов — подождите немного" }));
  };
  // Промах — неверная подпись Telegram или чужой секрет в ссылке (календарь, отчёт). Много промахов с одного адреса —
  // это перебор: дальше такие запросы с этого адреса отклоняются сразу, без чтения диска.
  const missKey = `miss:${ip}`;
  const missBlocked = () => ip !== "local" && rate.count(missKey) >= RL.miss;
  const miss = () => { if (ip !== "local") rate.hit(missKey, RL.miss, 600e3); };
  try {
    if (ip !== "local") { const r = rate.hit(`ip:${ip}`, RL.ip, 60e3); if (r) return tooMany(r, `адрес ${ip}`); }
    // Условия использования — страницей (ссылка с экрана входа); тот же текст бот присылает по команде /terms.
    if (url.pathname === "/terms") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); return res.end(terms.page()); }
    if (url.pathname === "/privacy") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); return res.end(terms.page(terms.PRIVACY)); }
    if (url.pathname === "/go/moodle") {
      const u = url.searchParams.get("u") || "";
      if (!u.startsWith("https://newlms.misis.ru/")) return send(400, "Неверная ссылка", "text/plain; charset=utf-8");
      return send(200, goMoodlePage(u), "text/html; charset=utf-8");
    }
    // Календарь в телефоне (calendar.mjs): лента подписки по секрету из ссылки — подписи Telegram у календарных программ нет.
    // Не прочитался чей-то файл пользователя (StateReadError) — это не «чужой секрет»: 424 без промаха, иначе опрос
    // календаря раз в час копил бы промахи и закрыл адрес для всех календарей за ним.
    const calWho = (t) => users.byCalToken(t).catch((e) => { if (isStateReadError(e)) return "unreadable"; throw e; });
    const cal = url.pathname.match(/^\/cal\/([\w-]{20,40})\.ics$/);
    if (cal) {
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const who = await calWho(cal[1]);
      if (who === "unreadable") return send(424, "temporarily unavailable", "text/plain");
      if (!who) { miss(); return send(404, "not found", "text/plain"); }
      const body = await calendar.feed(who);
      console.log(`${new Date().toISOString()} ${who} GET /cal/….ics 200 (${Buffer.byteLength(body)} б; ${String(req.headers["user-agent"] || "-").slice(0, 50)})`);
      return send(200, body, "text/calendar; charset=utf-8", url.searchParams.has("download") ? { "content-disposition": 'attachment; filename="doodle.ics"' } : {});
    }
    if (url.pathname.startsWith("/cal/")) return send(404, "not found", "text/plain");
    // Страница-переходник «подписаться на календарь»: ссылку webcal:// Telegram сам не открывает, а обычную страницу — да.
    if (url.pathname === "/go/calendar") {
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const who = await calWho(url.searchParams.get("t") || "");
      if (who === "unreadable") return send(424, "Данные сейчас не читаются — попробуйте ещё раз через минуту", "text/plain; charset=utf-8");
      if (!who) { miss(); return send(404, "Ссылка устарела — откройте «Календарь в телефоне» в Doodle ещё раз", "text/plain; charset=utf-8"); }
      const l = await calendar.links(who, await appUrl());
      return send(200, goCalendarPage(url.searchParams.get("to") === "google" ? "google" : "apple", l), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/health") return send(200, { ok: true, botToken: !!BOT_TOKEN, moodle: users.moodleRoute() });
      // «Открыть PDF» уходит в системный браузер (openLink), где нет подписи Telegram, — поэтому отчёт отдаётся до общей
      // проверки, по секрету работы ?t= (случайный, его знает только тот, кому сервер отдал состояние этой лабы).
      const rep = url.pathname.match(/^\/api\/lab\/(\d+)\/report$/);
      if (rep) {
        if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
        const f = await lab.reportFile(rep[1], url.searchParams.get("t"));
        if (f) console.log(`${new Date().toISOString()} - GET ${url.pathname} 200 pdf`); // 403 запишет send()
        if (!f) { miss(); return send(403, { error: "Ссылка на отчёт устарела — откройте отчёт из приложения ещё раз" }); }
        // Файл читается до заголовков: не прочитался (удалён, занят) — понятный отказ, а не исключение после writeHead.
        const pdf = await readFile(f.path).catch(() => null);
        if (!pdf) return send(404, { error: "Файл отчёта не найден — откройте отчёт из приложения ещё раз" });
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(f.name)}`, "cache-control": "no-store" });
        return res.end(pdf);
      }
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const tgId = whoIs(req); req.tgId = tgId;
      if (typeof tgId === "number") pace.stamp(`seen:${tgId}`, 10 * MIN); // активные пользователи опрашиваются чаще давно молчащих
      if (!tgId) {
        if (!req.authExpired) miss();
        return send(403, { error: req.authExpired ? "Вход устарел — закройте приложение и откройте его из Telegram заново" : BOT_TOKEN ? "forbidden" : "На сервере нет bot-token.txt, доступ из Telegram закрыт" });
      }
      const path = url.pathname.slice(5);
      { const r = rate.hit(`u:${tgId}`, RL.user, 60e3); if (r) return tooMany(r, `пользователь ${tgId}`); }
      // Принудительное обновление (?refresh) заставляет сервер идти в Moodle и журнал с домашнего адреса: чаще предела
      // запрос выполняется как обычный, из уже загруженного.
      // Счёт — отдельно по каждому виду данных (дедлайны, журнал, расписание): один жест «потянуть вниз» обновляет сразу
      // дедлайны и расписание и раньше один исчерпывал общий предел — второе обновление молча отдавало старое.
      if (url.searchParams.has("refresh") && rate.hit(`rf:${path.split("/")[0]}:${tgId}`, RL.refresh, 60e3)) url.searchParams.delete("refresh");
      // Загрузки файлов (до 20 МБ каждая): свой PDF в Moodle, файл в чат лабы, отчёт на проверку.
      if (req.method === "POST" && /^(upload\/\d+|lab\/\d+\/upload|check\/\d+)$/.test(path)) {
        const r = rate.hit(`up:${tgId}`, RL.upload, 600e3);
        if (r) { req.resume(); return tooMany(r, `загрузки пользователя ${tgId}`); }
      }

      // Профиль и вход.
      if (path === "me") {
        try { const u = JSON.parse(new URLSearchParams(req.headers["x-telegram-init-data"] || "").get("user") || "null"); if (u && Number(u.id) === tgId) await users.touchTelegram(tgId, u); } catch { /* без имени */ }
        return send(200, await me(tgId));
      }
      // Копия личных данных приложения (свои дедлайны, задачи, настройки): хранилище Telegram у каждого бота своё,
      // поэтому приложение держит копию на сервере и восстанавливает её, открывшись в новом боте (cloud-backup.mjs).
      if (path === "cloud") {
        if (req.method === "POST") {
          try { return send(200, { ok: true, at: await cloudBackup.save(tgId, await readBody(req)) }); }
          catch (e) { return send(400, { error: String(e.message || e) }); }
        }
        return send(200, { backup: await cloudBackup.load(tgId) });
      }
      // Запрос доступа к отчётам: пользователь нажал кнопку в карточке работы → владельцу сообщение с кнопкой «Открыть запросы».
      if (path === "lab/request" && req.method === "POST") {
        const p = await users.profile(tgId);
        if (p.labsAllowed) return send(200, { ok: true, allowed: true });
        // Повторное нажатие (или повтор запроса в обход приложения) владельцу второе сообщение не шлёт — не чаще раза в сутки.
        if (p.labRequest && Date.now() - Number(p.labRequest) < 86400e3) return send(200, { ok: true, allowed: false });
        await users.requestLabAccess(tgId);
        // Имя — только украшение сообщения: не прочитался список (занят белый список) — шлём без имени, а не теряем запрос.
        const me = (await users.listUsers().catch(() => [])).find((x) => x.tgId === tgId);
        const who = [me?.tgName, me?.tgUsername ? "@" + me.tgUsername : null, me?.fullName, me?.group].filter(Boolean).join(" · ");
        const app = await readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
        void notify.send(users.OWNER_ID, `👤 Просит доступ к отчётам с агентом:
${who || "без имени"} · id ${tgId}
Откройте Doodle → Профиль → «Доступ к отчётам» и включите переключатель.`,
          undefined, app ? [[{ text: "Открыть запросы", web_app: { url: `${app}/?open=access` } }]] : undefined).catch(() => {});
        return send(200, { ok: true, allowed: false });
      }
      // Экран владельца «Запросы на установку»: что агент окружения не стал ставить без подтверждения (lab.mjs envRequests/decideEnv).
      if (path === "env-requests") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          if (labsOff()) return send(403, { error: "labs_off" }); // одобренное ставит агент окружения
          const b = await readBody(req);
          await lab.decideEnv(Number(b.tgId), String(b.id || ""), Array.isArray(b.approve) ? b.approve.map(String) : []);
        }
        return send(200, { requests: await lab.envRequests() });
      }
      // Экран владельца «Расход и лимиты»: расход агента по пользователям и работам, месячные лимиты (usage.mjs).
      // Лимит — в токенах с весом (usage.WEIGHTS); доллары в ответе — справочная оценка по ценам API.
      if (path === "usage") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          const b = await readBody(req);
          const target = b.tgId == null ? null : Number(b.tgId);
          if (target !== null && (!target || target === users.OWNER_ID)) return send(400, { error: "Неверный пользователь" });
          try { await usage.setLimit(target, b.limit); } catch (e) { return send(400, { error: String(e.message || e) }); }
        }
        const [s, labs, all] = [await usage.summary(), await usage.byLab(), await users.listUsers()];
        const name = (id) => { const u = all.find((x) => x.tgId === id); return { name: u?.fullName || u?.tgName || null, username: u?.tgUsername || null, group: u?.group || null }; };
        const titles = new Map((await lab.titles().catch(() => [])).map((x) => [`${x.tgId}:${x.id}`, x]));
        // Пробные лабы (lab-trial.mjs) — отдельной строкой и пометкой у каждой: сколько стоит первый отчёт на Opus.
        const trialKeys = await labTrial.trialKeys().catch(() => new Set());
        const trialLabs = labs.filter((l) => trialKeys.has(`${l.tgId}:${l.id}`));
        return send(200, {
          ...s,
          trials: { count: trialLabs.length, tok: trialLabs.reduce((a, l) => a + l.tok, 0), usd: Math.round(trialLabs.reduce((a, l) => a + l.usd, 0) * 100) / 100,
            monthTok: trialLabs.filter((l) => (l.days.at(-1) || "").startsWith(s.month)).reduce((a, l) => a + l.tok, 0), budgetMTok: (await labTrial.config()).budgetMTok },
          labsCount: labs.length, avgLab: labs.length ? Math.round((labs.reduce((a, l) => a + l.usd, 0) / labs.length) * 100) / 100 : null,
          avgLabTok: labs.length ? Math.round(labs.reduce((a, l) => a + l.tok, 0) / labs.length) : null,
          users: s.users.map((u) => ({ ...u, ...name(u.tgId), isOwner: u.tgId === users.OWNER_ID })),
          labs: labs.slice(0, 40).map((l) => ({ tgId: l.tgId, id: l.id, tok: l.tok, raw: l.raw, usd: l.usd, calls: l.calls, kinds: l.kinds, kindsTok: l.kindsTok, last: l.days.at(-1) || null, title: titles.get(`${l.tgId}:${l.id}`)?.title || null, course: titles.get(`${l.tgId}:${l.id}`)?.course || null, name: name(l.tgId).name, trial: trialKeys.has(`${l.tgId}:${l.id}`) })),
        });
      }
      // Экран владельца «Доступ к отчётам»: список пользователей и переключатели.
      if (path === "access") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          const b = await readBody(req);
          const target = Number(b.tgId);
          if (!target || target === users.OWNER_ID) return send(400, { error: "Неверный пользователь" });
          if (b.closeTrial) {
            // Закрыть пробный отчёт (неначатый или идущий), не трогая белый список. Сообщение — только если было что закрывать.
            if (await labTrial.close(target)) void notify.send(target, "🚫 Пробный отчёт с агентом в Doodle закрыт.").catch(() => {});
          } else {
            await users.setLabAccess(target, !!b.allowed);
            void notify.send(target, b.allowed ? "✅ Вам открыты отчёты с агентом в Doodle: в карточке лабораторной появилась кнопка «Сделать отчёт»." : "🚫 Доступ к отчётам с агентом в Doodle закрыт.").catch(() => {});
          }
        }
        const list = await users.listUsers();
        const trials = await labTrial.ownerView(list.filter((u) => !u.allowed).map((u) => u.tgId)).catch(() => ({}));
        return send(200, { users: list.map((u) => ({ ...u, trial: trials[u.tgId] ?? null })) });
      }
      if (path === "login" && req.method === "POST") {
        const { username, password } = await readBody(req);
        if (!username || !password) return send(400, { error: "Введите логин и пароль" });
        if (recentFails(tgId).length >= 5) return send(429, { error: "Слишком много неудачных попыток входа. Подождите 5 минут." });
        try {
          const old = await users.moodleToken(tgId).catch(() => null); // прежний токен — до входа: вход его заменит
          const p = await users.login(tgId, String(username).trim(), String(password)); loginFails.delete(tgId);
          // Новый вход — дедлайны заново: под тем же Telegram могла войти другая учётная запись, а Moodle часто выдаёт
          // прежний токен. Записи прежнего токена в памяти и копия на диске забываются, прежние токены отзываются (обход
          // по старому списку вошедших копию с ними уже не запишет), а с нового отзыв снимается — даже если это тот же
          // токен, что был до выхода (15 окт 2026). Не прочитался новый токен — копия просто не пишется до перезапуска.
          const fresh = await users.moodleToken(tgId).catch(() => null);
          await moodle.forgetUserDeadlines(tgId, old, fresh);
          welcome.noteLogin(tgId); // после первого чтения дедлайнов бот пришлёт личное приветствие
          // Тот же логин и пароль подходят к электронному журналу (MISIS ID): подключаем его сразу, в фоне — вход в бот
          // этим не задерживается. Пароль запоминается зашифрованно (решение владельца, 16 окт 2026): вход MISIS ID живёт
          // 48 ч, дальше журнал входит им сам. Moodle пароль принял (trusted) — он запоминается и если журнал сейчас не
          // ответил. Прежние данные журнала в памяти забываются сразу: могла войти другая учётная запись.
          ej.forget(tgId);
          void ej.connect(tgId, String(username).trim(), String(password), { trusted: true }).then(() => { ej.forget(tgId); console.log(`ej ${tgId}: журнал подключён`); }, (e) => console.log(`ej ${tgId}: ${e.message}`));
          // Полный профиль, как у /api/me (лимит, пробный отчёт): клиент заменяет им свой, и без этих полей после входа
          // пропадало предложение пробного (ревью 16 окт). Не собрался — хотя бы профиль входа.
          return send(200, await me(tgId).catch(() => p));
        }
        catch (e) {
          const msg = String(e.message || e), network = /Moodle не отвечает/.test(msg);
          // Наш файл не прочитался (users/<id>.json или users.key заняты — StateReadError): это не неверный пароль.
          // 424, как у остальных сбоев, и в счёт неудачных попыток не идёт — иначе после пяти таких попыток человек
          // с верным паролем получал бы «подождите 5 минут» (15 окт 2026, находка ревью #21).
          if (isStateReadError(e)) return send(424, { error: msg });
          if (!network) loginFails.set(tgId, [...recentFails(tgId), Date.now()]);
          return send(network ? 503 : 401, { error: msg });
        }
      }
      if (path === "logout" && req.method === "POST") {
        ej.forget(tgId);
        // Токен — до выхода (выход его стирает): дедлайны с оценками и замечаниями не остаются ни в памяти, ни на диске.
        // revoke (15 окт 2026): токен отзывается — обход, взявший список вошедших до выхода, копию с ним уже не запишет.
        const t = await users.moodleToken(tgId).catch(() => null);
        await moodle.forgetDeadlines(t, tgId, { revoke: true });
        if (t) courseSheets.forget(t);
        const r = await users.logout(tgId);
        await dropUserBadCopies(tgId); // отложенные испорченные копии его файла (в них токен и куки журнала) — тоже
        return send(200, r);
      }

      const token = await users.moodleToken(tgId);
      const needLogin = () => send(401, { error: "login_required" });
      if (token) moodle.setOverrides(token, await users.courseOverrides(tgId), tgId); // tgId — для копии дедлайнов на диске

      // «Делиться замечаниями преподавателя»: включить — замечания к работам попадут в общую базу (сразу, из уже загруженных
      // дедлайнов, и дальше при каждой проверке); выключить — замечания этого человека из базы удаляются.
      if (path === "share-remarks" && req.method === "POST") {
        const b = await readBody(req);
        await users.setShareRemarks(tgId, !!b.on);
        if (!b.on) await lessons.purge(tgId);
        else if (token) void moodle.deadlines(token, false, { allowDisk: true }).then((d) => collectLessons(tgId, d)).catch(() => {}); // старые замечания годятся
        return send(200, await me(tgId));
      }

      // «Уведомления бота» в профиле: объявления и материалы курсов (news), пропуски и посещаемость (journal).
      if (path === "notify-prefs" && req.method === "POST") {
        const b = await readBody(req);
        try { await users.setNotifyPref(tgId, String(b.key || ""), !!b.on); } catch (e) { return send(400, { error: String(e.message || e) }); }
        return send(200, await me(tgId));
      }

      // Курсы пользователя: автоматическое решение «актуален/нет» + ручной выбор (Профиль → Курсы).
      if (path === "courses") {
        if (!token) return needLogin();
        if (req.method === "POST") {
          const b = await readBody(req);
          const id = Number(b.id);
          if (!id) return send(400, { error: "Нужен id курса" });
          moodle.setOverrides(token, await users.setCourse(tgId, id, b.active), tgId); // смена выбора стирает и копию на диске
          calendar.forget(tgId); // список курсов изменился — ленту календаря собрать заново
          // Работы включённого курса — не «новые»: запоминаем их молча, чтобы не пришла пачка уведомлений.
          try { const [d, q] = await Promise.all([moodle.deadlines(token, true), moodle.quizzesQuick(token)]); await notify.reseed(tgId, [...d.items, ...q.items]); } catch { /* уведомим позже */ }
        }
        return send(200, { semester: moodle.currentSemester(), courses: await moodle.allCourses(token) });
      }

      // Работает ли Moodle (для плашки «Moodle сейчас не работает»): сервер знает это по своим же запросам, Moodle тут не опрашивается.
      if (path === "status") return send(200, { moodle: moodle.health() });

      // «Календарь в телефоне»: ссылки подписки этого пользователя; POST { reset: true } — выдать новую ссылку (старая отключается).
      // stable — постоянный адрес есть и отвечает: подписка будет обновляться сама; иначе только разовый файл.
      if (path === "calendar") {
        const b = req.method === "POST" ? await readBody(req) : {};
        const l = await calendar.links(tgId, await appUrl(), { reset: !!b.reset });
        return send(200, { ...l, stable: l.stable && tunnelState().ok });
      }

      if (path === "deadlines") {
        if (!token) return needLogin();
        // Moodle не отвечает (сеть МИСИС, техработы) или отклоняет запросы бота (403, 429): отдаём последние загруженные
        // данные с пометкой, а не ошибку — приложение работает как раньше и показывает плашку.
        // С 15 окт 2026: если показать есть что (копия с диска после перезапуска, прежние данные в памяти), а Moodle или наша
        // очередь не успели за ~6 с — прежние данные с stale: true и source, но БЕЗ moodle.down (deadlinesForApp): Moodle
        // не упал, плашка «сбой на стороне университета» и её ежеминутные «Обновить» были бы неправдой и лишней нагрузкой.
        // Приложение тогда показывает «обновлено <время данных>»; чтение тем временем дозаполняет кэш.
        let d;
        try { d = await moodle.deadlinesForApp(token, { refresh: url.searchParams.has("refresh") }); }
        catch (e) {
          const stale = moodle.isOutage(e) || e?.name === "PausedError" ? moodle.staleDeadlines(token) : null;
          if (!stale) throw e;
          const h = moodle.health();
          d = { ...stale, stale: true, moodle: h.down ? h : { down: true, since: null, reason: /отклонил/.test(e.message) ? "blocked" : /не данными/.test(e.message) ? "maintenance" : "network", okAt: h.okAt } };
        }
        // Без плашки — только пока сервер не знает о сбое. Настоящий сбой сети МИСИС (повторы по 1,5 с) длится дольше
        // 6 с, и чтение не успевает отказать; если же сбой уже виден по другим запросам (серия отказов сети, 403/429,
        // страница техработ — moodle.health), приложение должно показать плашку, как раньше.
        if (d.stale && !d.moodle) { const h = moodle.health(); if (h.down) d = { ...d, moodle: h }; }
        // Первое удачное чтение после входа — личное приветствие от бота (один раз, по уже прочитанным данным).
        if (!d.stale) void welcome.afterLogin(tgId, d, async () => { const p = await users.profile(tgId); return { fullName: p.moodle?.userId ? p.moodle.fullName : null }; }).catch((e) => console.log(`welcome ${tgId}: ${e.message || e}`));
        // Пометки замечаний («новое» / «у агента» / «учтено») — по лабе этого пользователя. Кэш Moodle общий, поэтому копия.
        const items = await Promise.all(d.items.map(async (x) => (x.remarks?.length && x.id.startsWith("moodle:assign:")
          ? { ...x, remarks: await lab.markRemarks(tgId, x.id.slice(14), x.remarks) } : x)));
        return send(200, { ...d, items });
      }
      // Диагностика с телефона: клиент присылает, что у него в сторе не сходится (например, дедлайны без предмета).
      if (path === "diag" && req.method === "POST") {
        // Пишет на диск по запросу любого, кто открыл бота (даже без входа в Moodle), — поэтому редко и понемногу.
        { const r = rate.hit(`diag:${tgId}`, RL.diag, 600e3); if (r) { req.resume(); return tooMany(r, `диагностика пользователя ${tgId}`); } }
        const body = await readBody(req, 64 << 10);
        await mkdir(join(DIR, "diag"), { recursive: true });
        await writeFile(join(DIR, "diag", `${tgId}.json`), JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2));
        return send(200, { ok: true });
      }
      // Преподаватели курса (контакты курса в Moodle): ?course=<id>.
      if (path === "teachers") {
        if (!token) return needLogin();
        const courseId = Number(url.searchParams.get("course"));
        if (!courseId) return send(400, { error: "Нужен course" });
        const { teachers: list, course } = await moodle.courseInfo(token, courseId);
        // К каждому — оценка из «Кампуса» (публичная), если преподаватель там есть. course — описание курса для экрана «Курс».
        const campusData = await Promise.all(list.map((t) => campus.teacher(t.name)));
        return send(200, { teachers: list.map((t, i) => ({ ...t, campus: campusData[i] })), course });
      }
      // Настройки напоминаний: { "<deadlineId>": "day" | "3h" | "none" }.
      if (path === "reminders") {
        if (req.method === "GET") return send(200, await notify.loadPrefs(tgId));
        if (req.method === "POST") {
          const body = await readBody(req);
          const prefs = Object.fromEntries(Object.entries(body).filter(([k, v]) => /^moodle:/.test(k) && ["day", "3h", "none"].includes(v)));
          await notify.savePrefs(tgId, prefs);
          return send(200, prefs);
        }
        return send(405, { error: "method" });
      }
      // Группа для расписания: автоопределение по группам курсов Moodle; POST { group, subgroup } — выбор вручную.
      if (path === "group") {
        if (req.method === "POST") {
          const b = await readBody(req);
          calendar.forget(tgId);
          let p;
          try { p = await users.setGroup(tgId, b.group, b.subgroup, b.variant); } catch (e) { return send(400, { error: String(e.message || e) }); }
          return send(200, await me(tgId).catch(() => p)); // полный профиль, как у /api/me (см. login)
        }
        const prof = await users.profile(tgId);
        if (prof.group || !token) return send(200, { group: prof.group, candidates: prof.groupCandidates, subgroup: prof.subgroup });
        const [names, all] = await Promise.all([moodle.userGroupNames(token), groupList()]);
        const det = await users.detectGroup(tgId, names, all);
        return send(200, { ...det, subgroup: prof.subgroup, moodleGroups: names });
      }
      if (path === "groups") return send(200, await groupList(url.searchParams.has("refresh")));
      // Расписание пар группы пользователя (dnevuch.ru).
      if (path === "schedule") {
        const prof = await users.profile(tgId);
        const group = url.searchParams.get("group") || prof.group;
        if (!group) return send(200, { at: Date.now(), group: null, lessons: [], needGroup: true });
        return send(200, { ...(await schedule(group, url.searchParams.has("refresh"))), subgroup: prof.subgroup });
      }

      // Отзыв преподавателя по работе (замечания, состояние ответа, файлы) — свежим запросом в Moodle; доступен всем вошедшим.
      const fbm = path.match(/^feedback\/(\d+)$/);
      if (fbm) {
        if (!token) return needLogin();
        const f = await moodle.assignFeedback(token, fbm[1]);
        return send(200, { ...f, remarks: await lab.markRemarks(tgId, fbm[1], f.remarks) });
      }

      // «Прикрепить PDF» в карточке работы: свой файл студента → в его ответ Moodle (доступно всем вошедшим: агент тут
      // не участвует). Только по нажатию и подтверждению в приложении; тело запроса — сам PDF, имя — в X-File-Name.
      const upm = path.match(/^upload\/(\d+)$/);
      if (upm && req.method === "POST") {
        if (!token) return needLogin();
        const data = await readRaw(req);
        if (!data.length) return send(400, { error: "Пустой файл" });
        if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return send(400, { error: "Это не PDF-файл" });
        try { return send(200, await moodle.attachOwnFile(token, upm[1], { name: uploadName(req.headers["x-file-name"]), data })); }
        catch (e) { if (/invalidtoken/.test(e.message)) throw e; return send(e.status || 400, { error: String(e.message || e) }); }
      }
      // «Отправить на проверку» в карточке работы (у заданий с черновиком) — отдельным нажатием и подтверждением.
      const sbm = path.match(/^submit\/(\d+)$/);
      if (sbm && req.method === "POST") {
        if (!token) return needLogin();
        try { return send(200, await moodle.submitOwn(token, sbm[1])); }
        catch (e) { if (/invalidtoken/.test(e.message)) throw e; return send(e.status || 400, { error: String(e.message || e) }); }
      }
      // «Сессия»: учебный план группы (даты сессии, формы контроля), расписание экзаменов, долги по журналу и Moodle —
      // из уже загруженного, в Moodle и журнал отсюда не ходим (admission.mjs).
      if (path === "session" && req.method === "GET") {
        if (!token) return needLogin();
        return send(200, await admission.overview(tgId));
      }
      // Уточнение самого студента: какую дисциплину по выбору взял, записан ли на факультатив, что «не моё»
      // (перевёлся, перезачли). Ответ — новая сводка.
      if (path === "session/choice" && req.method === "POST") {
        if (!token) return needLogin();
        const b = await readBody(req);
        // «Вернуть» скрытое снимает и ответ «не моя» в боте у пары из журнала (admission.choose, 16 окт 2026).
        try { await admission.choose(tgId, String(b.kind || ""), b.key, b.value ?? null); }
        catch (e) { return send(400, { error: String(e.message || e) }); }
        return send(200, await admission.overview(tgId));
      }
      // Электронный журнал (ej.misis.ru) и таблицы преподавателей — ejView.
      if (path === "ej" && req.method === "GET") {
        if (!token) return needLogin();
        return send(200, await ejView(tgId, { refresh: url.searchParams.has("refresh") }));
      }
      // «Вернуть» дисциплину журнала, которую студент назвал не своей (в боте или в «Сессии»; 16 окт 2026): снимаются обе
      // отметки (attendance.restoreMine). Ответ — журнал заново (без похода в ej.misis.ru мимо 10-минутного запаса).
      if (path === "ej/mine" && req.method === "POST") {
        if (!token) return needLogin();
        const b = await readBody(req);
        const id = String(b.id ?? "");
        if (!/^\d{1,15}$/.test(id)) return send(400, { error: "Неверная дисциплина" });
        await attendance.restoreMine(tgId, id);
        return send(200, await ejView(tgId));
      }
      // Подключить журнал вручную (кто вошёл в бот до 16 окт 2026, когда пароль ещё не запоминался, или когда MISIS ID не
      // принял сохранённый пароль): пароль от Moodle/MISIS ID, почта — из входа в Moodle. Принятый пароль запоминается.
      if (path === "ej/connect" && req.method === "POST") {
        if (!token) return needLogin();
        const b = await readBody(req);
        const email = String(b.email || (await users.profile(tgId)).moodle?.username || "").trim();
        if (!email || !b.password) return send(400, { error: "Введите пароль" });
        if (recentFails(tgId).length >= 5) return send(429, { error: "Слишком много неудачных попыток. Подождите 5 минут." });
        try { await ej.connect(tgId, email, String(b.password)); ej.forget(tgId); loginFails.delete(tgId); }
        catch (e) {
          if (e.code === "bad_credentials") { loginFails.set(tgId, [...recentFails(tgId), Date.now()]); return send(401, { error: e.message }); }
          // 429 MISIS ID — тоже в счёт попыток: иначе нажатия «Подключить» шли бы в MISIS ID без предела.
          if (e.code === "rate_limited") loginFails.set(tgId, [...recentFails(tgId), Date.now()]);
          return send(424, { error: String(e.message || e) }); // не 502: его Cloudflare подменяет своей страницей
        }
        return send(200, await users.ejState(tgId));
      }
      // Лабы пользователя, где что-то идёт или ждут его ответа, — для плашки на Главной (без доступа к отчётам — пусто).
      // Пробный отчёт (lab-trial.mjs) — только его лаба.
      if (path === "labs") {
        const s = await labTrial.stateOf(tgId);
        if (s.via === "full") return send(200, await lab.list(tgId));
        if (s.via === "trial") return send(200, (await lab.list(tgId)).filter((l) => String(l.id) === s.trial.id));
        return send(200, []);
      }
      // Лабораторная с агентом: белый список или пробный отчёт, /api/lab/<assignId>[/start|/message|/attach|/submit|/fix] (report — выше)
      const m = path.match(/^lab\/(\d+)(?:\/(start|message|approve|attach|submit|fix|upload|explain|dismiss))?$/);
      if (m) {
        const [, id, action] = m;
        // allowed — полный доступ или своя пробная лаба; claim — эту работу можно начать как пробную (только GET и start).
        // Окончательно доступ к запуску проверяет lab.start внутри очереди пользователя.
        const acc = await labTrial.access(tgId, id);
        const startable = acc.claim && (req.method === "GET" || action === "start");
        if (!acc.allowed && !startable) return send(403, { error: acc.claim ? "trial_start_first" : acc.reason || "labs_not_allowed" });
        // Лаба — своя у каждого пользователя по каждой работе (lab.mjs: ключ <tgId>-<id>): чужую переписку не увидеть и чужой отчёт не прикрепить.
        if (req.method === "GET") return send(200, (await lab.get(tgId, id)) ?? { id, status: "idle", messages: [], report: null, moodle: null, agent: null });
        if (req.method !== "POST") return send(405, { error: "method" });
        if (AGENT_ACTIONS.has(action) && labsOff()) return send(403, { error: "labs_off" });
        // Скрепка в чате лабы: файл студента (снимок экрана, вывод программы) — тело запроса как есть, имя в X-File-Name.
        if (action === "upload") {
          try { return send(200, await lab.fromStudent(tgId, id, req.headers["x-file-name"], await readRaw(req))); }
          catch (e) { return send(e.status || 400, { error: String(e.message || e) }); }
        }
        const body = await readBody(req);
        try {
          if (action === "start") {
            const p = await users.profile(tgId);
            if (!token) return needLogin();
            // token — только чтобы сервер скачал условие и вложения от имени этого пользователя; в задание и к агенту он не попадает.
            return send(200, await lab.start(id, { ...body, tgId, token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }));
          }
          if (action === "fix") {
            // «Исправить отчёт»: замечания преподавателя сервер сам берёт из Moodle и передаёт агенту; в Moodle ничего не меняется.
            if (!token) return needLogin();
            const p = await users.profile(tgId);
            return send(200, await lab.fix(id, { ...body, tgId, token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }));
          }
          if (action === "message") return send(200, await lab.message(tgId, id, body.text));
          // «Всё хорошо» под отчётом: только после этого отчёт можно прикрепить в Moodle.
          if (action === "approve") return send(200, await lab.approve(tgId, id));
          // «Кратко о работе» под готовым отчётом: короткое объяснение сути работы (состояние лабы не меняется).
          if (action === "explain") return send(200, await lab.explain(tgId, id));
          // «Убрать с Главной»: плашка лабы скрывается; сама лаба и отчёт остаются, в Moodle ничего не меняется.
          if (action === "dismiss") return send(200, await lab.dismiss(tgId, id));
          if (action === "attach") return send(200, await lab.attach(tgId, id, token));
          if (action === "submit") return send(200, await lab.submit(tgId, id, token));
        } catch (e) {
          // 403 (коды пробного: trial_used, labs_not_allowed…), 424 (файл занят), 429 — как есть; остальное — 400.
          // Не 502/504: их Cloudflare (туннель) подменяет своей страницей.
          return send([403, 424, 429].includes(e.status) ? e.status : isStateReadError(e) ? 424 : 400, { error: String(e.message || e) });
        }
        return send(404, { error: "unknown action" });
      }
      // Проверка своего отчёта (lab.mjs checkReport): GET — состояние; POST — файл отчёта (тело запроса как есть, имя в X-File-Name).
      const ck = path.match(/^check\/(\d+)$/);
      if (ck) {
        if (!(await users.labsAllowed(tgId))) return send(403, { error: "labs_not_allowed" });
        if (req.method === "GET") return send(200, (await lab.checkState(tgId, ck[1])) ?? { id: ck[1], status: "idle" });
        if (req.method !== "POST") return send(405, { error: "method" });
        if (labsOff()) return send(403, { error: "labs_off" });
        if (!token) return needLogin();
        try {
          const data = await readRaw(req);
          const p = await users.profile(tgId);
          return send(200, await lab.checkReport(tgId, ck[1], { token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }, req.headers["x-file-name"], data));
        } catch (e) { return send(e.status || 400, { error: String(e.message || e) }); }
      }
      return send(404, { error: "unknown api" });
    }

    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return send(400, "bad path", "text/plain");
    const hashed = /^assets\/.+-[\w-]{8,}\.\w+$/.test(file);
    if (hashed && acceptsGzip && /\.(js|css|svg)$/.test(file)) {
      // Файлы сборки с хешем в имени: сжимаем один раз, кэшируем в браузере на год.
      let gz = gzCache.get(file);
      if (!gz) { const raw = await readFile(join(DIST, file)).catch(() => null); if (raw) { gz = gzipSync(raw, { level: 9 }); gzCache.set(file, gz); } }
      if (gz) return send(200, gz, TYPES[extname(file)], { "content-encoding": "gzip", "cache-control": "public, max-age=31536000, immutable" });
    }
    let body = await readFile(join(DIST, file)).catch(() => null);
    if (!body && !extname(file)) { file = "index.html"; body = await readFile(join(DIST, file)).catch(() => null); }
    // Кэш клиента просит файл прежней сборки (index-<старый хеш>.js/.css), которого уже нет: отдаём текущий того же типа.
    if (!body && /^assets\/index-[\w-]+\.(js|css)$/.test(file)) {
      const ext = extname(file);
      const current = (await readdir(join(DIST, "assets")).catch(() => [])).find((f) => f.startsWith("index-") && f.endsWith(ext));
      if (current) { file = `assets/${current}`; body = await readFile(join(DIST, file)).catch(() => null); }
    }
    if (!body) return send(404, "not found", "text/plain");
    const isHtml = extname(file) === ".html";
    send(200, body, TYPES[extname(file)] || "application/octet-stream",
      isHtml ? { "cache-control": "no-cache, no-store, must-revalidate", pragma: "no-cache", expires: "0" } : hashed ? { "cache-control": "public, max-age=31536000, immutable" } : {});
  } catch (e) {
    const msg = String(e.message || e);
    // Токен Moodle перестал действовать (смена пароля, отзыв админом): снимаем вход, приложение покажет форму входа.
    // Без этого пользователь оставался «вошедшим», а каждый запрос падал с «invalidtoken».
    // Как при выходе: токен — до logout, дедлайны мёртвого токена забываются и в памяти, и на диске.
    if (/^invalidtoken\b/.test(msg) && req.tgId) {
      const t = await users.moodleToken(req.tgId).catch(() => null);
      await moodle.forgetDeadlines(t, req.tgId, { revoke: true }); // мёртвый токен отзывается, как при выходе (15 окт 2026)
      if (t) courseSheets.forget(t);
      await users.logout(req.tgId).catch(() => {}); // и пароль журнала: logout стирает его
      ej.forget(req.tgId);
      return send(401, { error: "login_required" });
    }
    // Сбой внешнего сервиса — 424, не 502: ответ 502 Cloudflare (туннель) подменяет своей страницей, и вместо причины
    // («Moodle не отвечает…») приложение показывало «ошибка 502».
    send(e.status && e.status !== 502 && e.status !== 504 ? e.status : 424, { error: msg });
  }
}).listen(PORT, HOST, () => console.log(`Jarvis app: http://${HOST}:${PORT}  (bot-token: ${BOT_TOKEN ? "есть" : "нет"})`));
