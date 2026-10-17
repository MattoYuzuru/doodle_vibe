// Чтение и запись файлов состояния (15 окт 2026, баг «ошибка чтения файла = новый пользователь»). На Windows свежий
// файл на миг бывает занят (антивирус, ежедневная копия, чужой rename) — readFile отвечает EBUSY/EPERM/EACCES, и раньше
// во многих модулях это значило «файла нет»: следующая запись затирала настоящий файл (токен Moodle, группу, /stop,
// отметки «отправлено», привязки бесед…). Здесь «файла нет» — только ENOENT. Занятый файл читается повторно (≈1 с),
// а если не вышло — StateReadError: запрос получает 424 «попробуйте ещё раз», обход повторит позже, и НИЧЕГО не пишется.
// Испорченный JSON (обрыв неатомарной записи, ручная правка) откладывается рядом в «<имя>.bad-<время>» и дальше
// считается отсутствующим — или ошибкой, если для этого файла «пусто» опасно (общие файлы: белый список, беседы).
// Запись — через временный файл с уникальным именем и rename с повторами (EPERM/EACCES/EBUSY).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

// Коды, при которых файл, скорее всего, просто занят прямо сейчас: стоит подождать и прочитать ещё раз.
const BUSY = /^(EBUSY|EPERM|EACCES|EMFILE|ENFILE|EAGAIN|EIO|UNKNOWN)$/;
const RENAME_BUSY = /^(EPERM|EACCES|EBUSY)$/;

/** Файл есть, но прочитать его сейчас не удалось. status 424 — так сервер отвечает о сбоях (502/504 подменяет Cloudflare). */
export class StateReadError extends Error {
  constructor(path, cause) {
    super(`Данные сейчас не читаются (${cause?.code || cause?.message || cause}) — попробуйте ещё раз через минуту`);
    this.name = "StateReadError"; this.code = "STATE_UNREADABLE"; this.status = 424; this.path = path; this.cause = cause;
  }
}
export const isStateReadError = (e) => e?.name === "StateReadError";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* без паузы */ } };
const backoff = (i) => 50 * 2 ** i * (0.75 + Math.random() * 0.5); // ≈ 0,05 / 0,1 / 0,2 / 0,4 с
const badName = (path) => `${path}.bad-${new Date(Date.now() + 3 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
const missingOf = (m) => (typeof m === "function" ? m() : m);

// Кому сообщить об испорченном файле (сервер передаёт сообщение владельцу); не чаще раза в сутки на файл.
let corruptHook = null;
const corruptTold = new Map();
// Уже отложенное испорченное содержимое: файл → хеш текста. Пока файл не переписан, его читают снова и снова (состояние
// уведомлений — каждые 15 с) — та же порча второй раз не копируется и не ждёт перечитывания (проверка 15 окт 2026).
const quarantined = new Map();
const digest = (text) => createHash("sha1").update(text).digest("hex");
const knownBad = (path, text) => quarantined.get(path) === digest(text);
function rememberBad(path, text) { if (quarantined.size > 1000) quarantined.clear(); quarantined.set(path, digest(text)); }
/** fn(path, badPath) — вызывается, когда испорченный файл отложен в .bad-*. */
export const onCorrupt = (fn) => { corruptHook = fn; };
function tellCorrupt(path, bad, err) {
  console.error(`state-file: ${path} испорчен (${String(err?.message || err).slice(0, 120)}) — отложен в ${bad}`);
  if (Date.now() - (corruptTold.get(path) || 0) < 86400e3) return;
  corruptTold.set(path, Date.now());
  try { void Promise.resolve(corruptHook?.(path, bad)).catch(() => {}); } catch { /* сообщение не обязательно */ }
}

/** Текст файла без BOM; null — файла нет (ENOENT/ENOTDIR); занят — повторы; не вышло — StateReadError. */
export async function readText(path, { attempts = 5 } = {}) {
  for (let i = 0; ; i++) {
    try { return (await readFile(path, "utf8")).replace(/^﻿/, ""); }
    catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
      if (i + 1 >= attempts || !BUSY.test(String(e?.code || ""))) throw new StateReadError(path, e);
      await sleep(backoff(i));
    }
  }
}
/** То же синхронно — для чтения при загрузке модуля (moodle-pace, bot-stats). */
export function readTextSync(path, { attempts = 5 } = {}) {
  for (let i = 0; ; i++) {
    try { return readFileSync(path, "utf8").replace(/^﻿/, ""); }
    catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
      if (i + 1 >= attempts || !BUSY.test(String(e?.code || ""))) throw new StateReadError(path, e);
      sleepSync(backoff(i));
    }
  }
}

/**
 * JSON-файл состояния. missing — значение (или функция) на случай «файла нет»; corrupt: "missing" — испорченный JSON
 * отложить в .bad-* и вернуть missing; "throw" — отложить и бросить StateReadError. Не удалось отложить копию —
 * StateReadError в любом случае: иначе следующая запись уничтожила бы единственный экземпляр.
 */
export async function readJson(path, { missing = null, corrupt = "missing", attempts = 5 } = {}) {
  let text = await readText(path, { attempts });
  for (let again = 0; ; again++) {
    if (text === null) return missingOf(missing);
    try { return JSON.parse(text); }
    catch (e) {
      // Та же порча уже отложена — без новой копии и без ожидания.
      if (knownBad(path, text)) { if (corrupt === "throw") throw new StateReadError(path, e); return missingOf(missing); }
      // Неатомарный писатель мог как раз дописывать файл: один раз перечитать.
      if (again === 0) { await sleep(100); text = await readText(path, { attempts }); continue; }
      const bad = badName(path);
      try { await writeFile(bad, text, { flag: "wx" }).catch((we) => (we?.code === "EEXIST" ? undefined : Promise.reject(we))); } catch (ce) { throw new StateReadError(path, ce); }
      rememberBad(path, text);
      tellCorrupt(path, bad, e);
      if (corrupt === "throw") throw new StateReadError(path, e);
      return missingOf(missing);
    }
  }
}
/** То же синхронно. */
export function readJsonSync(path, { missing = null, corrupt = "missing", attempts = 5 } = {}) {
  let text = readTextSync(path, { attempts });
  for (let again = 0; ; again++) {
    if (text === null) return missingOf(missing);
    try { return JSON.parse(text); }
    catch (e) {
      if (knownBad(path, text)) { if (corrupt === "throw") throw new StateReadError(path, e); return missingOf(missing); }
      if (again === 0) { sleepSync(100); text = readTextSync(path, { attempts }); continue; }
      const bad = badName(path);
      try { writeFileSync(bad, text, { flag: "wx" }); } catch (ce) { if (ce?.code !== "EEXIST") throw new StateReadError(path, ce); }
      rememberBad(path, text);
      tellCorrupt(path, bad, e);
      if (corrupt === "throw") throw new StateReadError(path, e);
      return missingOf(missing);
    }
  }
}

/** Записать текст атомарно: временный файл со своим именем → rename с повторами. Не вышло — временный файл удаляется, ошибка наверх. */
export async function writeTextAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text);
  for (let i = 0; ; i++) {
    try { await rename(tmp, path); return; }
    catch (e) {
      if (i >= 5 || !RENAME_BUSY.test(String(e?.code || ""))) { await unlink(tmp).catch(() => {}); throw e; }
      await sleep(40 * (i + 1));
    }
  }
}
export function writeTextAtomicSync(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      if (i >= 2 || !RENAME_BUSY.test(String(e?.code || ""))) { try { unlinkSync(tmp); } catch { /* уже нет */ } throw e; } // синхронно — не больше ~0,1 с: цикл событий стоит
      sleepSync(40 * (i + 1));
    }
  }
}
/** JSON атомарно; space — отступ (2 — читаемый файл, как раньше). */
export const writeJsonAtomic = (path, data, { space } = {}) => writeTextAtomic(path, JSON.stringify(data, null, space));
export const writeJsonAtomicSync = (path, data, { space } = {}) => writeTextAtomicSync(path, JSON.stringify(data, null, space));
