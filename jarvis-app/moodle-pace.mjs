// Аккуратное обращение к Moodle и журналу МИСИС: бот должен вести себя как один вежливый клиент (просьба владельца,
// 5 окт 2026: «массовые запросы к Moodle с одного адреса могут привести к блокировке учётной записи или бану адреса»).
// До этого сервер слал около 65 тыс. запросов в сутки на десятерых, пачками по 50, круглосуточно, а при сбое Moodle
// повторял каждый запрос пять раз (3–4 окт — сутки по 1200 попыток соединения в час в неотвечающий сервер).
//
// Что делает модуль (все запросы к сайтам МИСИС идут через users.mfetch, а он — через enter/leave):
//   1. Очередь с паузами: запросы людей (кто-то открыл приложение) идут первыми и быстро; фоновые обходы — по одному
//      и не чаще двух раз в секунду (до 15 окт 2026 — раз в секунду). Пачек в десятки запросов за секунду больше нет.
//   2. Остановка: Moodle ответил отказом (403, 429), стал отдавать страницу вместо данных или перестал отвечать —
//      фоновые обходы встают на паузу (15 мин → 30 → 1 ч → 2 → 6), владельцу приходит сообщение. Запросы людей при
//      этом проходят: человек должен видеть настоящее состояние. Пауза переживает перезапуск сервера.
//   3. Счётчик: сколько запросов за сутки и за час, каких (фон или люди, какие функции), пик в минуту — в
//      usage\moodle-load.json; сводка — stats(). По нему видно настоящую нагрузку и её рост.
// Маскировки здесь нет и не должно быть: цель — меньше и ровнее, а не «незаметнее».
// Для стенда: MOODLE_PACE=0 убирает паузы между запросами (счётчик и остановка работают), MOODLE_PACE_DIR — куда писать.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSync, writeJsonAtomicSync } from "./state-file.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILE = join(process.env.MOODLE_PACE_DIR || join(DIR, "usage"), "moodle-load.json");
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
const FAST = process.env.MOODLE_PACE === "0";
const GAP_USER = FAST ? 0 : num(process.env.MOODLE_USER_GAP_MS, 150);  // между запросами людей: до ~6 в секунду
// Фон: не чаще двух запросов в секунду на сайт (15 окт 2026, решение владельца; было раз в секунду — при 7 людях очередь
// фона была занята наполовину, при ~25 уведомления начинали опаздывать — ops/stand/load-test.mjs).
const GAP_BG = FAST ? 0 : num(process.env.MOODLE_BG_GAP_MS, 500);
const CONC_ALL = FAST ? 64 : num(process.env.MOODLE_CONC, 4), CONC_BG = FAST ? 64 : 1;
// Сетевой сбой — это серия: не меньше NET_FAILS неудач подряд без единого ответа, тянущаяся дольше NET_SPAN_MS.
// Отдельные несостоявшиеся соединения у МИСИС обычны (особенно через зарубежный VPN) и паузы не вызывают.
const NET_FAILS = num(process.env.MOODLE_NET_FAILS, 8);
const NET_SPAN_MS = num(process.env.MOODLE_NET_SPAN_MS, 60e3);
// Серия сбоев устаревает: если с прошлого сбоя прошло больше этого (никто не спрашивал), новый сбой начинает счёт заново.
// Срок больше ночного промежутка между обходами (15 минут): ночью серия копится от обхода к обходу.
const NET_STALE_MS = num(process.env.MOODLE_NET_STALE_MS, 45 * 60e3);
// Пауза ставится, только когда сбои идут прямо сейчас: NET_BURST подряд (не удался весь цикл повторов одного запроса)
// с перерывами не длиннее NET_BURST_GAP_MS. Один потерянный запрос через пять минут после короткого обрыва — не серия.
const NET_BURST_GAP_MS = num(process.env.MOODLE_NET_BURST_GAP_MS, 2 * 60e3), NET_BURST = 3;
const BAD_DATA = 3;                                         // столько раз подряд «страница вместо данных» — пауза
const MIN = 60e3;
// Сколько запрос может ждать своей очереди (Moodle отвечает медленно, все места заняты): дольше — отказ без похода в сеть.
const WAIT_USER = num(process.env.MOODLE_QUEUE_WAIT_MS, 45e3), WAIT_BG = num(process.env.MOODLE_QUEUE_WAIT_BG_MS, 120e3);
/*
 * Порядок в очереди фона (17 окт 2026, нагрузка на VPS: при 300 людях «Новый материал» не дошёл за 5 минут). Очередь была
 * общей «кто раньше пришёл»: проверки тестов и материалов (один запрос на человека, ради уведомлений «в ту же минуту»)
 * стояли за тысячами плановых перечитываний дедлайнов, объявлений и журнала. Теперь срочные (URGENT) идут первыми, а
 * плановый запрос, прождавший BG_AGE_MS, проходит через раз со срочными — ни те, ни другие не голодают (при длинном
 * хвосте давно ждут все плановые, и без чередования очередь снова стала бы «кто раньше»). Темп (GAP_BG) не меняется.
 */
// 18 окт 2026 (владелец: «тесты нужно точно оперативно»): срочные в два ряда — сначала тесты и сигнал по курсу
// (news.probeSignal), потом материалы; плановые — после них.
const BG_RANK = { "quiz-open": 0, quick: 0, signal: 0, materials: 1 };
const URGENT = new Set(Object.keys(BG_RANK));
const BG_AGE_MS = num(process.env.MOODLE_BG_AGE_MS, 30e3);
/** Первый в очереди с самым срочным рядом (-1 — срочных нет). */
function bestUrgent(q) {
  let best = -1;
  for (let k = 0; k < q.length; k++) {
    const r = BG_RANK[q[k].turn.name];
    if (r === undefined) continue;
    if (best < 0 || r < BG_RANK[q[best].turn.name]) best = k;
    if (r === 0) break;
  }
  return best;
}
/** Какой фоновый запрос пустить следующим (индекс в h.qBg); h.agedLast — прошлым пропущен давно ждущий плановый. */
function nextBg(h, now) {
  const q = h.qBg, i = bestUrgent(q);
  const aged = !URGENT.has(q[0].turn.name) && now - q[0].at >= BG_AGE_MS;
  const pick = i < 0 || (aged && !h.agedLast) ? 0 : i;
  h.agedLast = pick === 0 && aged;
  return pick;
}
const STEPS = { block: [15, 30, 60, 120, 360], data: [15, 30, 60, 120], net: [5, 10, 20, 30] }; // минуты паузы по нарастающей
const NET_ALERT_MS = num(process.env.MOODLE_NET_ALERT_MS, 60 * MIN); // не отвечает дольше — сообщить владельцу

/** Откуда запрос: фоновый обход (с названием) или действие человека. Наследуется всеми вызовами внутри fn. */
const origin = new AsyncLocalStorage();
export const background = (name, fn) => origin.run({ bg: true, name }, fn);
export const isBackground = () => !!origin.getStore()?.bg;

/** Фоновый запрос остановлен: Moodle на паузе. Не сетевой сбой — повторять не нужно. */
export class PausedError extends Error {
  constructor(reason, until) { super(`Moodle на паузе до ${new Date(until).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" })}: ${reason}`); this.name = "PausedError"; this.until = until; }
}
/** Запрос не дождался очереди (сайт отвечает медленно). В сеть не уходил; повторять сразу бессмысленно. */
export class QueueError extends Error {
  constructor() { super("Moodle не отвечает (сеть МИСИС): запросы ждут в очереди. Попробуйте ещё раз через минуту."); this.name = "QueueError"; }
}

let alert = () => {};
/** Куда писать владельцу (сервер передаёт отправку в Telegram). */
export const onAlert = (fn) => { alert = fn; };

// --- состояние: по узлам (newlms, ej) очередь и пауза; по дням — счётчики ---
const hosts = new Map(); // узел → { active, activeBg, lastStart, lastBgStart, qUser, qBg, timer, timerAt, netFails, netBurst, netSince, netLast, badData }
const hostState = (host) => {
  if (!hosts.has(host)) hosts.set(host, { active: 0, activeBg: 0, lastStart: 0, lastBgStart: 0, qUser: [], qBg: [], timer: null, timerAt: 0, netFails: 0, netBurst: 0, netSince: 0, netLast: 0, badData: 0 });
  return hosts.get(host);
};
// pause: узел → { until, reason, kind, level, since, at, alerted, over }; over — когда сайт снова ответил (запись остаётся:
// по ней повторный отказ в те же сутки даёт более длинную паузу). marks — отметки времени.
let saved = { days: {}, pause: {}, marks: {} };
const shapeOf = (j) => (j && typeof j === "object" && !Array.isArray(j) ? { days: j.days || {}, pause: j.pause || {}, marks: j.marks || {} } : null);
/*
 * 15 окт 2026: раньше любая ошибка чтения при старте давала пустое состояние, и через секунды (stamp с flush, таймер)
 * файл перезаписывался: пропадали действующая пауза после отказа Moodle и история отказов (фон возобновлялся посреди
 * блокировки, а следующая пауза снова была короткой), отметки полного чтения (после перезапуска — полное чтение у всех)
 * и статистика. Теперь «пусто» — только когда файла нет (испорченный JSON откладывается в .bad-* и тоже «пусто»).
 * Занятый файл — повторы, а не вышло — loadFailed: файл не пишется, пока save не сумеет его прочитать; тогда то, что на
 * диске, сливается с накопленным за это время в памяти (mergeDisk) и записывается.
 */
let loadFailed = false, failTold = false;
const STARTED = Date.now();
try { saved = shapeOf(readJsonSync(FILE)) || saved; }
catch (e) { loadFailed = true; console.error(`moodle-pace: ${FILE} не читается (${e.message || e}) — не пишу его, пока не прочитаю`); }
/*
 * 15 окт 2026 (проверка): пока файл не прочитан, в памяти нет паузы — а на диске может лежать шестичасовая пауза после
 * отказа Moodle. Раньше диск перечитывался только при записи (save), и до неё фоновые обходы шли в сеть, в тот самый
 * заблокировавший нас Moodle, а первый же 403 начинал историю с нуля и слал владельцу повторную тревогу. Теперь:
 *   — файл перечитывается в фоне каждые RELOAD_MS (15 с), пока не прочитается; прочитали — слияние, как в save
 *     (записывает потом обычный save — по отметке или двухминутному таймеру);
 *   — пока состояние неизвестно, фон считается на паузе «состояние паузы Moodle не прочитано» (paused/enter), но не дольше
 *     UNKNOWN_MS (10 мин) от запуска: файл, который не читается дольше (права, сломанный диск), не должен навсегда и
 *     молча остановить уведомления — тогда громкая запись в журнал, и фон идёт как обычно. Запросы людей не держим.
 * Для стенда: MOODLE_PACE_RELOAD_MS и MOODLE_PACE_UNKNOWN_MS.
 */
const RELOAD_MS = num(process.env.MOODLE_PACE_RELOAD_MS, 15e3);
const UNKNOWN_MS = num(process.env.MOODLE_PACE_UNKNOWN_MS, 10 * MIN);
let unknownTold = false;
/** Состояние с диска ещё не прочитано и 10 минут с запуска не прошли — фон держим на паузе. */
function stateUnknown() {
  if (!loadFailed) return false;
  if (Date.now() - STARTED < UNKNOWN_MS) return true;
  if (!unknownTold) {
    unknownTold = true;
    console.error(`moodle-pace: ВНИМАНИЕ — ${FILE} не читается уже ${Math.round((Date.now() - STARTED) / MIN)} мин после запуска. Пауза Moodle с диска неизвестна, фоновые обходы возобновлены без неё (если Moodle нас ограничил, первый же отказ снова поставит паузу). Проверьте файл: права, кто его держит открытым.`);
  }
  return false;
}
if (loadFailed) {
  const reloadTimer = setInterval(() => {
    if (!loadFailed || reloadDisk()) { clearInterval(reloadTimer); return; } // прочитали (здесь или в save) — повторы не нужны
    stateUnknown(); // вышло 10 минут — громкая запись в журнал (один раз)
  }, RELOAD_MS);
  reloadTimer.unref();
}

// История отказа сайта в записи паузы: сама запись вида block или её поле block (см. trip).
const histOf = (p) => (p?.kind === "block" ? { level: p.level || 0, at: p.at || 0 } : p?.block || null);
/** Слить прочитанное с диска с памятью: отметки — позднейшая, пауза — с более поздним сроком (история отказа — обеих), счётчики — сумма. */
function mergeDisk(disk) {
  for (const [k, at] of Object.entries(disk.marks)) if (!(saved.marks[k] >= at)) saved.marks[k] = at;
  for (const [host, dp] of Object.entries(disk.pause)) {
    if (!dp || typeof dp !== "object") continue;
    const mp = saved.pause[host];
    const win = !mp || (dp.until || 0) > (mp.until || 0) ? dp : mp, lose = win === dp ? mp : dp;
    // Уровень отказа не теряем: по нему повторный отказ в те же сутки даёт более длинную паузу.
    const hs = [histOf(win), histOf(lose)].filter(Boolean);
    if (hs.length) {
      const h = { level: Math.max(...hs.map((x) => x.level || 0)), at: Math.max(...hs.map((x) => x.at || 0)) };
      if (win.kind === "block") win.level = h.level; else win.block = h;
    }
    saved.pause[host] = win;
  }
  // В памяти счётчики только с запуска (файл не прочитался — начинали с нуля), поэтому сумма не считает дважды.
  for (const [day, dd] of Object.entries(disk.days)) {
    const md = saved.days[day];
    if (!md) { saved.days[day] = dd; continue; }
    for (const k of ["total", "bg", "user", "fail"]) md[k] = (md[k] || 0) + (dd[k] || 0);
    md.peakMin = Math.max(md.peakMin || 0, dd.peakMin || 0);
    for (const k of ["byHour", "byWhat", "byName", "byHost"]) { const t = (md[k] ||= {}); for (const [n, v] of Object.entries(dd[k] || {})) t[n] = (t[n] || 0) + v; }
  }
}
/** Файл не прочитался при старте: попробовать ещё раз (коротко — save зовётся и из запросов) и слить. true — можно писать. */
function reloadDisk() {
  let disk;
  try { disk = readJsonSync(FILE, { attempts: 2 }); }
  catch (e) { if (!failTold) { failTold = true; console.error(`moodle-pace: ${FILE} всё ещё не читается (${e.message || e}) — счётчик не пишу`); } return false; }
  const d = shapeOf(disk);
  if (d) mergeDisk(d);
  loadFailed = false;
  console.log("moodle-pace: файл счётчика прочитан, слит с накопленным в памяти");
  return true;
}
let dirty = false;
function save() {
  if (!dirty) return;
  if (loadFailed && !reloadDisk()) return; // dirty остаётся — попробуем при следующей записи
  dirty = false;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const days = Object.fromEntries(Object.entries(saved.days).sort().slice(-14)); // две недели
    saved.days = days;
    writeJsonAtomicSync(FILE, saved); // своё имя временного файла, rename с повторами (state-file.mjs)
  } catch (e) { console.error(`moodle-pace: счётчик не записан: ${e.message || e}`); }
}
setInterval(save, 2 * MIN).unref();
process.on("exit", save);

const dayKey = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10); // сутки по Москве
const hourKey = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(11, 13);
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };
let minute = { key: 0, n: 0 };
function count(host, turn, failed) {
  const d = (saved.days[dayKey()] ||= { total: 0, bg: 0, user: 0, fail: 0, peakMin: 0, byHour: {}, byWhat: {}, byName: {}, byHost: {} });
  d.total++; d[turn.bg ? "bg" : "user"]++;
  if (failed) d.fail++;
  d.byHour[hourKey()] = (d.byHour[hourKey()] || 0) + 1;
  d.byWhat[turn.what] = (d.byWhat[turn.what] || 0) + 1;
  d.byName[turn.name] = (d.byName[turn.name] || 0) + 1;
  d.byHost[host] = (d.byHost[host] || 0) + 1;
  const m = Math.floor(Date.now() / MIN);
  if (minute.key !== m) minute = { key: m, n: 0 };
  if (++minute.n > d.peakMin) d.peakMin = minute.n;
  dirty = true;
}

// --- пауза ---
/**
 * Пауза фоновых обходов для узла: { until, reason, kind } или null. Файл с паузами ещё не прочитан (stateUnknown) —
 * временная осторожная пауза kind "unknown" для любого узла; until — до следующей попытки чтения (не позже 10 минут с
 * запуска): по нему сервер планирует повтор (openFire), и ждать все 10 минут, если файл прочитается через 15 с, незачем.
 */
export function paused(host) {
  const p = saved.pause[host];
  if (p && Date.now() < p.until) return p;
  if (stateUnknown()) return { until: Math.min(STARTED + UNKNOWN_MS, Date.now() + RELOAD_MS), reason: "состояние паузы Moodle не прочитано", kind: "unknown" };
  return null;
}
const RANK = { net: 1, data: 2, block: 3 }; // что важнее: отказ сайта > страница вместо данных > сбой сети
function trip(host, kind, reason, { retryAfterMs = 0 } = {}) {
  // Файл с паузами ещё не прочитан (15 окт 2026) — сначала попробовать слить диск: иначе уровень и «владельцу сообщено»
  // считались бы с нуля — повторная тревога и короткая пауза вместо записанной шестичасовой.
  if (loadFailed) reloadDisk();
  const now = Date.now(), prev = saved.pause[host];
  const active = !!prev && now < prev.until;
  // Пауза уже действует. Один сбойный эпизод — одна пауза: запросы людей при паузе идут в сеть и получают те же отказы,
  // но уровень от этого не растёт и владельцу новых сообщений нет. Менее важная причина действующую паузу не заменяет
  // (иначе серия сетевых сбоев превратила бы шестичасовую паузу после отказа в пятиминутную).
  if (active && RANK[kind] <= RANK[prev.kind]) {
    if (kind === prev.kind && retryAfterMs && now + retryAfterMs > prev.until) { prev.until = now + retryAfterMs; dirty = true; save(); }
    return;
  }
  const DAY = 24 * 3600e3;
  const fresh = !!prev && prev.kind === kind && now - prev.at < DAY;
  // Отказ сайта помним сутки — и после «снова отвечает», и когда поверх него записалась пауза другого вида (сеть,
  // «страница вместо данных»): запись на узел одна, поэтому история отказа переносится в ней отдельным полем block.
  const hist = prev?.kind === "block" ? { level: prev.level, at: prev.at } : prev?.block || null;
  const blockFresh = !!hist && now - hist.at < DAY;
  // Уровень растёт, пока сбои идут подряд. Отказ: ограничение вернулось в те же сутки — следующая пауза длиннее.
  // Сбой сети и техработы — пока длятся: сайт ответил — счёт заново.
  const level = kind === "block" ? (blockFresh ? Math.min(hist.level + 1, STEPS.block.length - 1) : 0)
    : fresh && !prev.over ? Math.min(prev.level + 1, STEPS[kind].length - 1) : 0;
  const ms = Math.max(STEPS[kind][level] * MIN, retryAfterMs);
  // Тот же непрерывный сбой (сайт между паузами так и не ответил): начало и отметка «владельцу сообщено» — прежние.
  const cont = fresh && !prev.over && now - prev.at < 2 * STEPS[kind][STEPS[kind].length - 1] * MIN;
  const since = cont && prev.since ? prev.since : now;
  // Пауза другого вида сменила незакрытую (сайт так и не ответил): владелец уже предупреждён и получит «снова отвечает».
  const carry = cont || (!!prev && !prev.over && prev.kind !== kind && now - prev.at < DAY);
  const p = { until: Math.max(now + ms, active ? prev.until : 0), reason, kind, level, since, at: now, alerted: carry ? !!prev.alerted : false, over: 0 };
  if (kind !== "block" && blockFresh) p.block = hist;
  saved.pause[host] = p; dirty = true;
  const till = new Date(p.until).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
  console.error(`moodle-pace: ${host} — фоновые обходы на паузе до ${till} мск (${reason})`);
  // Отказ — владельцу сразу и при каждой более длинной паузе; «страница вместо данных» — сразу и при удлинении; сеть —
  // когда не отвечает дольше часа (короткие сбои у МИСИС обычны).
  const tell = kind === "block" ? !p.alerted || level > (blockFresh ? hist.level : -1)
    : kind === "data" ? !p.alerted || (cont && level > prev.level)
      : !p.alerted && now - since >= NET_ALERT_MS;
  if (tell) {
    p.alerted = true;
    const what = kind === "block" ? "Moodle отклоняет запросы бота — возможно, адрес или учётные записи ограничены."
      : kind === "data" ? "Moodle отдаёт страницу вместо данных: техработы или защита перед сайтом."
        : "Сайт вуза не отвечает больше часа: сбой у МИСИС или наш адрес ограничен.";
    void Promise.resolve().then(() => alert(`⚠️ ${host}: ${what}\nПричина: ${reason}.\nФоновый опрос остановлен до ${till} мск, потом бот попробует снова (каждая следующая пауза длиннее). Студенты по-прежнему могут открыть приложение — оно покажет последние данные.\nЕсли сайт открывается у вас в браузере с этого же ПК, а у бота нет — похоже на ограничение бота.`)).catch(() => {});
  }
  save();
  // Фоновые запросы, уже стоящие в очереди, в сеть не идут: они прошли проверку паузы раньше, чем она началась.
  const h = hosts.get(host);
  if (h) for (const w of h.qBg.splice(0)) { clearTimeout(w.timer); w.reject(new PausedError(p.reason, p.until)); }
}
/** Сайт снова отвечает: пауза закончена (запись остаётся с отметкой over — см. trip). Записывается сразу. */
function recovered(host) {
  const p = saved.pause[host];
  if (!p || p.over) return;
  p.over = Date.now();
  if (p.until > p.over) p.until = p.over; // пауза по сети снимается первым же ответом, не дожидаясь срока
  dirty = true;
  if (p.alerted) void Promise.resolve().then(() => alert(`✅ ${host} снова отвечает, фоновый опрос возобновлён.`)).catch(() => {});
  save();
}

// --- очередь ---
function pump(host) {
  const h = hostState(host);
  for (;;) {
    const now = Date.now();
    const wait = Math.max(0, h.lastStart + GAP_USER - now);
    let w = null;
    if (h.active < CONC_ALL && !wait) {
      if (h.qUser.length) w = h.qUser.shift();
      else if (h.qBg.length && h.activeBg < CONC_BG && now - h.lastBgStart >= GAP_BG) w = h.qBg.splice(nextBg(h, now), 1)[0];
    }
    if (!w) break;
    h.active++; h.lastStart = now;
    if (w.turn.bg) { h.activeBg++; h.lastBgStart = now; }
    clearTimeout(w.timer);
    w.resolve(w.turn);
  }
  // Таймер нужен, только если ждущему мешает пауза между запросами; если мешает занятое место — разбудит leave().
  if (h.active >= CONC_ALL) return;
  const now = Date.now();
  let at = 0;
  if (h.qUser.length) at = h.lastStart + GAP_USER;
  else if (h.qBg.length && h.activeBg < CONC_BG) at = Math.max(h.lastStart + GAP_USER, h.lastBgStart + GAP_BG);
  if (!at) return;
  at = Math.max(at, now + 1);
  // Таймер уже стоит не позже нужного — оставляем; стоит позже (ставился под секундную паузу фона, а пришёл запрос
  // человека) — переставляем, чтобы человек не ждал чужую паузу.
  if (h.timer && h.timerAt <= at) return;
  clearTimeout(h.timer);
  h.timerAt = at;
  h.timer = setTimeout(() => { h.timer = null; h.timerAt = 0; pump(host); }, at - now); // не unref: в очереди ждут запросы
}

/**
 * Занять очередь перед запросом. what — что запрашивается (имя функции веб-сервиса, «login», «file», «page»);
 * api — это обращение к веб-сервису Moodle или вход (отказ 403 на них считается признаком блокировки).
 * Фоновый запрос при паузе узла не уходит в сеть вовсе: бросается PausedError. Возвращает «ход» для leave().
 */
export function enter(url, what = "page", api = false) {
  const host = hostOf(url), o = origin.getStore();
  const turn = { host, bg: !!o?.bg, name: o?.name || "человек", what, api: !!api }; // api — запрос к веб-сервису Moodle
  if (turn.bg) { const p = paused(host); if (p) throw new PausedError(p.reason, p.until); }
  const h = hostState(host);
  return new Promise((resolve, reject) => {
    const q = turn.bg ? h.qBg : h.qUser, w = { turn, resolve, reject, timer: null, at: Date.now() };
    const limit = turn.bg ? WAIT_BG : WAIT_USER;
    // Не дождался очереди — выходит из неё сразу (место и секундную паузу фона не занимает) и получает отказ.
    if (limit > 0) w.timer = setTimeout(() => { const i = q.indexOf(w); if (i >= 0) { q.splice(i, 1); reject(new QueueError()); } }, limit);
    q.push(w); pump(host);
  });
}

/** Запрос закончен: status — код ответа, error — сетевая ошибка. Считает, следит за признаками блокировки. */
export function leave(turn, { status = 0, error = null, retryAfter = null } = {}) {
  const h = hostState(turn.host);
  h.active--; if (turn.bg) h.activeBg--;
  const network = !!error;
  count(turn.host, turn, network || status >= 400);
  if (network) {
    const now = Date.now();
    // Давняя серия (после неё никто не спрашивал) не продолжается: иначе один сбой спустя час после короткого обрыва дал бы паузу.
    if (!h.netFails || now - h.netLast > NET_STALE_MS) { h.netFails = 0; h.netSince = now; }
    if (now - h.netLast > NET_BURST_GAP_MS) h.netBurst = 0;
    h.netFails++; h.netBurst++; h.netLast = now;
    if (h.netFails >= NET_FAILS && now - h.netSince >= NET_SPAN_MS && h.netBurst >= NET_BURST) { h.netFails = 0; h.netBurst = 0; trip(turn.host, "net", "сайт не отвечает: нет ни одного ответа больше минуты"); }
  } else if (status === 429 || (status === 403 && turn.api)) {
    // 403 на веб-сервисе — отказ перед Moodle (защита, список адресов). У журнала и файлов 403 бывает и в обычной работе
    // (сессия истекла, файл закрыт) — там это паузу не вызывает.
    h.netFails = 0; h.netBurst = 0;
    const s = Number(retryAfter);
    trip(turn.host, "block", `ответ HTTP ${status}`, { retryAfterMs: Number.isFinite(s) && s > 0 ? Math.min(s, 6 * 3600) * 1000 : 0 });
  } else if (status && status < 500) {
    h.netFails = 0; h.netBurst = 0;
    const p = saved.pause[turn.host];
    // Сеть ответила — пауза по сети снимается сразу. Пауза после отказа у журнала и MISIS ID — когда её срок вышел и
    // сайт ответил нормально (другого признака там нет). У веб-сервиса Moodle паузу после отказа и «страницу вместо
    // данных» снимает только dataSeen: код 200 бывает и у страницы-заглушки.
    if (p && !p.over && (p.kind === "net" || (p.kind === "block" && !turn.api && status < 400 && Date.now() >= p.until))) recovered(turn.host);
  }
  pump(turn.host);
}

/** Запрос отменён до отправки (истёк срок, пока ждал очереди): место освобождается, в счётчик не идёт. */
export function cancel(turn) {
  const h = hostState(turn.host);
  h.active--; if (turn.bg) h.activeBg--;
  pump(turn.host);
}

/** Moodle ответил страницей вместо данных (ok=false) или нормальными данными (ok=true) — из moodle.call. */
export function dataSeen(host, ok, status = 0) {
  const h = hostState(host);
  if (ok) {
    h.badData = 0;
    const p = saved.pause[host];
    if (p && !p.over && Date.now() >= p.until) recovered(host); // пауза истекла и данные пошли — всё в порядке
    return;
  }
  if (++h.badData >= BAD_DATA) { h.badData = 0; trip(host, "data", `страница вместо данных (HTTP ${status}) ${BAD_DATA} раза подряд`); }
}

/** Сводка для владельца: сегодня и вчера (по Москве), текущие паузы. */
export function stats() {
  const today = dayKey(), yesterday = dayKey(Date.now() - 24 * 3600e3);
  const top = (o, n = 6) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, n: v }));
  const one = (k) => { const d = saved.days[k]; return d ? { day: k, total: d.total, bg: d.bg, user: d.user, fail: d.fail, peakMin: d.peakMin, byHour: d.byHour, top: top(d.byWhat), byName: top(d.byName, 10), byHost: d.byHost } : null; };
  return { today: one(today), yesterday: one(yesterday), pauses: Object.entries(saved.pause).filter(([, p]) => Date.now() < p.until).map(([host, p]) => ({ host, until: p.until, reason: p.reason, kind: p.kind })) };
}

/** Запросов к сайтам МИСИС за последние n суток (по Москве): всего и сбоев — для недельной сводки владельцу. */
export function lastDays(n = 7) {
  const from = dayKey(Date.now() - n * 24 * 3600e3);
  const list = Object.entries(saved.days).filter(([k]) => k > from).map(([, d]) => d);
  return { days: list.length, total: list.reduce((a, d) => a + d.total, 0), fail: list.reduce((a, d) => a + d.fail, 0), peakMin: Math.max(0, ...list.map((d) => d.peakMin || 0)) };
}
/** Отметки с данным началом ключа: [ключ, время] — например, «seen:» (кто когда открывал приложение). */
export const stampsOf = (prefix) => Object.entries(saved.marks).filter(([k]) => k.startsWith(prefix));

/**
 * Отметки времени, переживающие перезапуск сервера: когда по пользователю последний раз читались дедлайны, когда он
 * открывал приложение. Без них каждый перезапуск (их бывает десятки в день) начинался бы с полного обхода всех.
 */
export function stamp(key, minGapMs = 0, flush = false) {
  const now = Date.now();
  if (minGapMs && now - (saved.marks[key] || 0) < minGapMs) return;
  saved.marks[key] = now; dirty = true;
  // flush — записать сразу: сервер перезапускают, убивая процесс, и отметка, ждущая двухминутного таймера, терялась бы.
  if (flush) save();
}
export const stampAt = (key) => saved.marks[key] || 0;

/** Для тестов: забыть всё состояние в памяти; _expire — считать, что срок паузы узла уже вышел. */
export function _reset() { hosts.clear(); saved = { days: {}, pause: {}, marks: {} }; dirty = false; minute = { key: 0, n: 0 }; }
export function _expire(host) { const p = saved.pause[host]; if (p) p.until = Date.now() - 1; }
