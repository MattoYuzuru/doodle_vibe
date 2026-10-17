// Ежедневная копия данных приложения (4 окт 2026, «начнём с защиты»). Код хранит история изменений (git), а данные —
// пользователи (зашифрованные токены Moodle и ключ к ним), задания лаб, состояние уведомлений, расход и лимиты,
// проверки отчётов, база замечаний, образцы оформления — до этого не копировались никуда: одна неудачная запись или
// случайное удаление — и восстановить нечем.
//
// Копия — обычная папка с датой: <место>\<ГГГГ-ММ-ДД>\…; хранятся последние 14. Место по умолчанию — jarvis-app\backups
// (тот же диск: спасает от ошибки программы и случайного удаления, но не от поломки диска). Чтобы копии шли на другой
// диск или в папку облака, владелец кладёт рядом с сервером файл backup.json: { "dir": "D:\\doodle-backup" }.
// Восстановление: остановить сервер и скопировать содержимое нужной даты обратно в jarvis-app.
//
// Токены бота и ngrok в копию не идут: их можно выдать заново, а лишние копии секретов ни к чему. Ключ users.key идёт —
// без него копия пользователей бесполезна; поэтому место копий должно быть не менее закрытым, чем сама папка приложения.
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.BACKUP_SRC || DIR; // переменные — для проверки на временных папках
const ITEMS = ["users", "users.key", "jobs", "notify", "usage", "checks", "lessons", "course-styles", "lab-allowlist.txt", "calendar-base.txt"];
const KEEP = Number(process.env.BACKUP_KEEP) || 14;
const HOUR_FROM = 4; // копия делается после четырёх утра по Москве: в это время лабы идут реже всего

const mskDay = (ms = Date.now()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date(ms));
const mskHour = (ms = Date.now()) => Number(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)));

/** Куда класть копии: из backup.json (dir) или папка backups рядом с сервером. */
export async function backupDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const cfg = await readFile(join(DIR, "backup.json"), "utf8").then((t) => JSON.parse(t.replace(/^\uFEFF/, "")), () => null);
  return typeof cfg?.dir === "string" && cfg.dir.trim() ? cfg.dir.trim() : join(DIR, "backups");
}

async function sizeOf(path) {
  const st = await stat(path).catch(() => null);
  if (!st) return { files: 0, bytes: 0 };
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0, bytes = 0;
  for (const e of await readdir(path, { withFileTypes: true })) { const s = await sizeOf(join(path, e.name)); files += s.files; bytes += s.bytes; }
  return { files, bytes };
}

/**
 * Сделать копию за сегодня (московская дата). Уже есть — ничего не делает (force — переписать). Возвращает
 * { dir, day, files, bytes, skipped }. Сначала пишет во временную папку и только потом переименовывает: оборванная
 * копия не выглядит готовой.
 */
export async function backupNow({ force = false, now = Date.now() } = {}) {
  const root = await backupDir(), day = mskDay(now), dest = join(root, day), tmp = join(root, `${day}.partial`);
  if (!force && await stat(dest).then((s) => s.isDirectory(), () => false)) return { dir: dest, day, skipped: true, ...(await sizeOf(dest)) };
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const item of ITEMS) {
    const from = join(SRC, item);
    if (!(await stat(from).catch(() => null))) continue;
    // Временные файлы незавершённых записей (*.tmp) в копию не берём.
    await cp(from, join(tmp, item), { recursive: true, filter: (src) => !/\.tmp$/.test(src) });
  }
  await rm(dest, { recursive: true, force: true });
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  // Старые копии: оставляем последние KEEP (папки с именем-датой; чужое в этой папке не трогаем).
  const days = (await readdir(root).catch(() => [])).filter((n) => /^\d{4}-\d\d-\d\d$/.test(n)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP))) await rm(join(root, old), { recursive: true, force: true }).catch(() => {});
  return { dir: dest, day, skipped: false, ...(await sizeOf(dest)) };
}

/** Раз в час проверять, сделана ли сегодняшняя копия (после четырёх утра по Москве), и делать её. BACKUP=0 — выключено. */
export function watchBackup({ onError = () => {} } = {}) {
  if (process.env.BACKUP === "0") return;
  const tick = async () => {
    if (mskHour() < HOUR_FROM) return;
    try {
      const r = await backupNow();
      if (!r.skipped) console.log(`backup: копия данных за ${r.day} — ${r.files} файлов, ${Math.max(1, Math.round(r.bytes / 1024))} КБ → ${r.dir}`);
    } catch (e) { console.log(`backup: не получилось — ${e.message || e}`); onError(e); }
  };
  setTimeout(tick, 90e3).unref();
  setInterval(tick, 3600e3).unref();
}
