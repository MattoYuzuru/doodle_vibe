// Простая статистика бота для владельца (5 окт 2026): сколько сообщений ушло людям, сколько команд пришло, кто когда
// впервые нажал Start и по чьему приглашению. Файл usage\bot-stats.json; личных данных, кроме идентификаторов Telegram, нет.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSync, writeJsonAtomicSync } from "./state-file.mjs";

const FILE = join(process.env.BOT_STATS_DIR || join(dirname(fileURLToPath(import.meta.url)), "usage"), "bot-stats.json");
const shapeOf = (j) => (j && typeof j === "object" && !Array.isArray(j) ? { days: j.days || {}, started: j.started || {}, invitedBy: j.invitedBy || {} } : null);
let data = { days: {}, started: {}, invitedBy: {} };
/*
 * 15 окт 2026: раньше любая ошибка чтения при старте давала пустую статистику, и первое же note('sent') через 3 с
 * перезаписывало файл — пропадали даты первого Start (firstStart снова «первый» у всех), кто кого пригласил и счётчики
 * за 60 дней. Теперь «пусто» — только когда файла нет (испорченный JSON откладывается в .bad-*). Занятый файл —
 * loadFailed: не пишем, пока не прочитаем; прочитали — сливаем с накопленным в памяти (mergeDisk) и пишем.
 */
let loadFailed = false, failTold = false;
try { data = shapeOf(readJsonSync(FILE)) || data; }
catch (e) { loadFailed = true; console.error(`bot-stats: ${FILE} не читается (${e.message || e}) — не пишу его, пока не прочитаю`); }
/** Слить диск с памятью: первый Start — раньший, приглашение — с диска (из памяти — только если там нет), счётчики — сумма. */
function mergeDisk(disk) {
  for (const [id, at] of Object.entries(data.started)) if (!disk.started[id] || at < disk.started[id]) disk.started[id] = at;
  for (const [id, by] of Object.entries(data.invitedBy)) if (!(id in disk.invitedBy)) disk.invitedBy[id] = by;
  // В памяти счётчики только с запуска (начинали с нуля), поэтому сумма не считает дважды.
  for (const [day, d] of Object.entries(data.days)) { const t = (disk.days[day] ||= {}); for (const [k, n] of Object.entries(d)) t[k] = (t[k] || 0) + n; }
  data = disk;
}
/** Файл не прочитался при старте — попробовать ещё раз и слить. true — можно писать (и data уже с диска). */
function reloadDisk() {
  if (!loadFailed) return true;
  let disk;
  try { disk = readJsonSync(FILE, { attempts: 2 }); }
  catch (e) { if (!failTold) { failTold = true; console.error(`bot-stats: ${FILE} всё ещё не читается (${e.message || e}) — не пишу`); } return false; }
  const d = shapeOf(disk);
  if (d) mergeDisk(d);
  loadFailed = false;
  return true;
}
/*
 * Таймер записи один на модуль: отложенная запись (later, 3 с) или повтор после неудачного чтения (60 с). 15 окт 2026
 * (проверка): save() раньше только обнулял ссылку на таймер, не снимая его, а firstStart зовёт save() напрямую — при
 * долго нечитаемом файле каждый новый /start запускал ещё одну вечную минутную цепочку повторов (каждая с синхронным
 * чтением и паузой ~50 мс). Теперь save() сначала снимает стоящий таймер: повтор всегда один; после удачного чтения
 * новый не ставится — цепочка кончается.
 */
let timer = null;
function save() {
  if (timer) clearTimeout(timer);
  timer = null;
  // Не прочитали файл — не пишем; через минуту попробуем снова (новые счётчики копятся в памяти).
  if (!reloadDisk()) { timer = setTimeout(save, 60e3); timer.unref?.(); return; }
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    data.days = Object.fromEntries(Object.entries(data.days).sort().slice(-60));
    writeJsonAtomicSync(FILE, data); // своё имя временного файла, rename с повторами (state-file.mjs)
  } catch (e) { console.error(`bot-stats: не записано: ${e.message || e}`); }
}
const later = () => { if (!timer) { timer = setTimeout(save, 3000); timer.unref?.(); } };
process.on("exit", () => { if (timer) save(); });
const dayKey = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10); // сутки по Москве

/** Счётчик за сегодня: sent — сообщения людям, commands — команды в чате. */
export function note(kind, n = 1) { const d = (data.days[dayKey()] ||= {}); d[kind] = (d[kind] || 0) + n; later(); }
/**
 * Первое нажатие Start: запоминается время и, если человек пришёл по приглашению (ref — идентификатор пригласившего),
 * кто его позвал. Повторный Start ничего не меняет. Возвращает true, если это первый Start.
 */
export function firstStart(tgId, ref = null) {
  const id = String(tgId);
  reloadDisk(); // файл при старте не прочитался — сначала попробовать: иначе «первый Start» у того, кто давно нажимал
  if (data.started[id]) return false;
  data.started[id] = Date.now();
  if (ref && String(ref) !== id) data.invitedBy[id] = Number(ref);
  save();
  return true;
}
/** Скольких человек пригласил этот пользователь. */
export const invitedCount = (tgId) => Object.values(data.invitedBy).filter((by) => by === Number(tgId)).length;
/** Сводка за последние days суток: суммы счётчиков, новые люди, пришедшие по приглашениям. */
export function summary(days = 7) {
  const since = Date.now() - days * 86400e3, from = dayKey(since);
  const sum = {};
  for (const [k, d] of Object.entries(data.days)) if (k > from) for (const [name, n] of Object.entries(d)) sum[name] = (sum[name] || 0) + n;
  const fresh = Object.entries(data.started).filter(([, at]) => at >= since).map(([id]) => id);
  return { sent: sum.sent || 0, commands: sum.commands || 0, started: fresh.length, invited: fresh.filter((id) => data.invitedBy[id]).length, totalInvited: Object.keys(data.invitedBy).length };
}
