// Копия личных данных приложения на сервере: свои дедлайны, предметы, задачи, заметки и настройки студента.
//
// Сами данные живут в облачном хранилище Telegram, а оно у каждого бота своё: при переезде на нового бота (5 окт 2026)
// они бы пропали. Поэтому приложение при запуске и после изменений присылает копию сюда, а открывшись в новом боте
// с пустым хранилищем — забирает её. Копия лежит в cloud\<tgId>.json, доступна только самому человеку (по подписи
// Telegram) и попадает в ежедневную резервную копию.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeTextAtomic } from "./state-file.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "cloud");
const LISTS = ["subjects", "deadlines", "tasks", "notes"];
const MAX_BYTES = 600 * 1024;
const file = (tgId) => join(DIR, `${Number(tgId)}.json`);

/** Сохранить копию: принимаются только известные коллекции (списки и объект настроек). Возвращает время записи. */
export async function save(tgId, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Нужны данные приложения");
  const clean = {};
  for (const c of LISTS) if (Array.isArray(data[c])) clean[c] = data[c];
  if (data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)) clean.settings = data.settings;
  if (!Object.keys(clean).length) throw new Error("Нужны данные приложения");
  const body = JSON.stringify({ at: Date.now(), data: clean });
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Слишком много данных для копии");
  await mkdir(DIR, { recursive: true });
  // Предыдущая копия остаётся рядом (<tgId>.prev.json): если приложение по ошибке пришлёт обеднённые данные, прежние не пропадут.
  // Страховка обновляется не чаще раза в сутки: копия уходит при каждом запуске, и иначе плохая копия за два запуска вытеснила бы хорошую.
  const prev = file(tgId).replace(/\.json$/, ".prev.json");
  const age = await stat(prev).then((s) => Date.now() - s.mtimeMs, () => Infinity);
  if (age > 24 * 3600e3) await copyFile(file(tgId), prev).catch((e) => { if (e?.code !== "ENOENT") console.log(`cloud ${Number(tgId)}: страховочная копия не сделана — ${e.code || e.message}`); });
  // Временный файл — своё имя на каждую запись (15 окт 2026: было общее на процесс, и два одновременных POST одного
  // человека писали в один файл), rename — с повторами (state-file.mjs).
  await writeTextAtomic(file(tgId), body);
  return JSON.parse(body).at;
}

/**
 * Последняя копия: { at, data } или null — только если копии нет (или файл испорчен: он отложен в .bad-*). Файл занят
 * или не читается — ошибка, запрос получит 424 (15 окт 2026). Раньше это тоже было «копии нет» с кодом 200: приложение,
 * открывшееся в новом боте, считало копию сверенной и присылало свои почти пустые данные поверх настоящих.
 */
export async function load(tgId) {
  const j = await readJson(file(tgId), { missing: null });
  return j && typeof j === "object" && j.data ? { at: Number(j.at) || 0, data: j.data } : null;
}
