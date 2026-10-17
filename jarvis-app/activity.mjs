// «Признаки жизни» агента для приложения — без единого токена. Процент агент пишет сам и только на крупных этапах
// (их 8), а замеры между 40 и 60 % идут до часа: студенты думали, что бот встал (просьба владельца, 3 окт 2026).
// Сервер сам смотрит, что происходит, модель не спрашивает:
//   — какие файлы агент пишет в папке лабы (вывод команд, рисунки, отчёт, заметки) — «Сейчас: … · 20 с назад»;
//   — держит ли он замок замеров (.measure.lock) или ждёт его у другого студента;
//   — идёт ли команда этой лабы (в командной строке процесса — папка лабы, проект lab-<ключ> или --key <ключ>);
//     когда агент работает под своей учётной записью Windows (agent-account.mjs), командных строк его процессов сервер
//     не видит — тогда команда берётся из журнала Claude CLI этой лабы: вызов Bash/PowerShell без результата ещё идёт;
//   — давно ли кончился сон сервера, после которого ход продолжился сам.
// Отсюда же — «ползущий» процент: каждый новый результат (файл вывода, рисунок, файл отчёта) после последней записи
// агента даёт +1 %, но не дальше следующей отметки агента. Число движется, только когда работа правда идёт.
import { spawn } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENT, AGENT_TRANSCRIPTS, measureLock } from "./agent-account.mjs";
import { whoIn, whoOf } from "./usage.mjs";

/** Отметки процента из lab-instruction.md: агент пишет одну из них (или промежуточную). */
export const MILESTONES = [5, 15, 25, 40, 60, 75, 90, 100];
const ACTIVE_MS = Number(process.env.LAB_ACTIVE_MS) || 2 * 60e3; // было действие — «работает»
const STUCK_MS = Number(process.env.LAB_STUCK_MS) || 15 * 60e3; // столько без единого признака — «похоже, завис»
const SLEPT_MS = 5 * 60e3; // столько после пробуждения показываем «сервер спал»
const LOCK_FRESH_MS = 30 * 60e3; // замок старше — забытый, не считается
const DIRS = ["work/out", "work/fig", "work/report", "work", "tmp", ""];
// Пишет сам сервер (перед каждым ходом) — это не действие агента.
const SERVER_WRITTEN = /^(tmp\/turn-[^/]*\.md|ТИПИЧНЫЕ ЗАМЕЧАНИЯ\.md)$/;

const scans = new Map(); // папка лабы → { at, files: [{ rel, mtime }] } — не чаще раза в 3 с
export async function recentFiles(dir) {
  const c = scans.get(dir);
  if (c && Date.now() - c.at < 3000) return c.files;
  const files = [];
  for (const sub of DIRS) {
    const entries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (SERVER_WRITTEN.test(rel)) continue;
      const st = await stat(join(dir, sub, e.name)).catch(() => null);
      if (st) files.push({ rel, mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  scans.set(dir, { at: Date.now(), files });
  return files;
}

const stemOf = (name) => name.replace(/(\.meta\.json|\.ansi|\.txt|\.log|\.csv|\.json|\.png|\.jpe?g|\.svg|\.docx|\.pdf|\.md|\.py|\.ps1|\.sh|\.m?js|\.ts|\.html)$/i, "");
/** Что значит запись этого файла — словами для студента. */
export function describe(rel) {
  const name = rel.split("/").pop(), stem = stemOf(name);
  if (rel.startsWith("work/out/")) return `команда на стенде: ${stem}`;
  if (/\.(png|jpe?g|svg)$/i.test(name)) return `рисунок: ${stem}`;
  if (rel.startsWith("work/report/")) return /\.pdf$/i.test(name) ? "PDF отчёта" : /\.docx$/i.test(name) ? "собирает отчёт" : "готовит сборку отчёта";
  if (name === "NOTES.md") return "записывает заметки";
  if (name === "JOB.json") return "обновляет ход работы";
  if (rel.startsWith("tmp/")) return "читает материалы";
  if (/\.(py|ps1|sh|m?js|ts)$/i.test(name)) return `пишет скрипт ${name}`;
  return "работает с файлами";
}

/** Сколько новых результатов (вывод команды, рисунок, файл отчёта — по имени, без расширения) появилось после since. */
export function resultsSince(files, since) {
  const seen = new Set();
  for (const f of files) {
    if (f.mtime <= since) continue;
    const m = /^work\/(out|fig|report)\/(.+)$/.exec(f.rel);
    if (m) seen.add(`${m[1]}/${stemOf(m[2])}`);
  }
  return seen.size;
}

/** Процент агента плюс 1 % за каждый новый результат, но меньше следующей отметки агента. */
export function creep(base, results) {
  const next = MILESTONES.find((m) => m > base) ?? 100;
  return Math.max(base, Math.min(next - 1, base + results));
}

async function lockInfo() {
  const lock = measureLock(); // LAB_LOCK_FILE — только для тестов
  const st = await stat(lock).catch(() => null);
  if (!st || Date.now() - st.mtimeMs > LOCK_FRESH_MS) return null;
  const buf = await readFile(lock).catch(() => Buffer.alloc(0));
  // Замок пишет агент: PowerShell мог сохранить его в UTF-16 или с меткой BOM.
  const text = (buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8")).replace(/^﻿/, "").trim();
  return { key: text, at: st.mtimeMs };
}

// Командные строки всех процессов — одним запросом раз в 30 с (нужны, только когда агент давно ничего не писал).
const PROC_CACHE_MS = Number(process.env.LAB_PROC_CACHE_MS ?? 30e3); // переменная — только для тестов
let procs = { at: 0, lines: [], pending: null };
function processLines() {
  if (Date.now() - procs.at < PROC_CACHE_MS) return Promise.resolve(procs.lines);
  if (procs.pending) return procs.pending;
  procs.pending = new Promise((resolve) => {
    let out = "";
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property CommandLine | ForEach-Object { $_.CommandLine } | Where-Object { $_ }"], { windowsHide: true });
    const done = () => { procs = { at: Date.now(), lines: out.split(/\r?\n/).filter(Boolean), pending: null }; resolve(procs.lines); };
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d));
    p.on("close", done);
    p.on("error", done);
    setTimeout(() => { try { p.kill(); } catch { /* уже закончился */ } }, 20e3).unref();
  });
  return procs.pending;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Идёт ли сейчас команда этой лабы — и какая (словами). Процесс самого агента (openclaw) не считается. */
export function busyCommand(lines, job) {
  const dir = job.dir.toLowerCase();
  const re = new RegExp(`(${esc(dir)}|${esc(dir.replace(/\\/g, "/"))})(?![\\w])|lab-${esc(String(job.key).toLowerCase())}(?![\\w])|--key ${esc(String(job.key).toLowerCase())}(?![\\w])`);
  const hit = lines.find((l) => { const s = l.toLowerCase(); return !s.includes("openclaw") && !s.includes("get-ciminstance") && re.test(s); });
  if (!hit) return null;
  return commandWhat(hit);
}
const commandWhat = (cmd) => (/\bk6\b/i.test(cmd) ? "идёт нагрузочный тест" : /docker/i.test(cmd) ? "выполняется команда docker на стенде" : "выполняется долгая команда");

/**
 * Вызовы инструментов в тексте журнала Claude CLI, на которые ещё нет результата: [{ name, text }] — text — команда
 * Bash/PowerShell (или входные данные другого инструмента). Учитываются только вызовы не раньше since (начало хода):
 * оборванный прошлый ход не должен выглядеть идущей командой. Неполная первая строка хвоста просто пропускается.
 */
export function pendingTools(text, since = 0) {
  const calls = new Map();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_use" && c.id && (Date.parse(e.timestamp || "") || 0) >= since) calls.set(c.id, { name: String(c.name || ""), text: String(c.input?.command ?? JSON.stringify(c.input ?? {})) });
      else if (c?.type === "tool_result" && c.tool_use_id) calls.delete(c.tool_use_id);
    }
  }
  return [...calls.values()];
}

// Журналы агента лаб (папка в профиле его учётной записи; LAB_TRANSCRIPTS_DIR — только для тестов).
const JOURNALS = process.env.LAB_TRANSCRIPTS_DIR || AGENT_TRANSCRIPTS;
// Начало журнала — с запасом: первая инструкция сервера (правила лабы целиком) в журнале занимает 40–50 КБ.
const HEAD = 256 * 1024, TAIL = 256 * 1024;
async function readPart(path, start, len) {
  const fh = await open(path, "r");
  try { const buf = Buffer.alloc(len); const { bytesRead } = await fh.read(buf, 0, len, start); return buf.subarray(0, bytesRead).toString("utf8"); }
  finally { await fh.close(); }
}
const owners = new Map(); // журнал → чья это работа (по началу журнала; начало файла не меняется)
async function ownerOf(path) {
  if (owners.has(path)) return owners.get(path);
  const head = await readPart(path, 0, HEAD).catch(() => "");
  // Как в учёте расхода: по подписи «Рабочая папка» в первой инструкции сервера, иначе — по папке в действиях модели.
  let first = null;
  const own = [];
  for (const line of head.split("\n")) {
    let x;
    try { x = JSON.parse(line); } catch { continue; }
    if (first === null && x.type === "user") { const c = x.message?.content; first = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("\n") : ""; }
    if (x.type === "assistant") own.push(line);
  }
  const w = whoOf(first);
  if (!w.tgId) return whoIn(own); // по действиям модели — не запоминаем: журнал ещё растёт
  if (owners.size > 500) owners.clear();
  owners.set(path, w);
  return w;
}
/**
 * Какая команда сейчас идёт в журнале этой лабы (агент под своей учётной записью — процессов его серверу не видно).
 * Смотрим журналы, менявшиеся с начала хода и относящиеся к этой работе, — последнее незавершённое действие.
 */
export async function journalBusy(job, since, dir = JOURNALS) {
  const check = String(job.key || "").startsWith("check-");
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const path = join(dir, e.name);
    const st = await stat(path).catch(() => null);
    if (!st || st.mtimeMs < since - 60e3) continue;
    const who = await ownerOf(path);
    if (!who?.tgId || who.tgId !== Number(job.tgId) || String(who.id) !== String(job.id) || (who.kind === "check") !== check) continue;
    const tail = await readPart(path, Math.max(0, st.size - TAIL), Math.min(st.size, TAIL)).catch(() => "");
    const call = pendingTools(tail, since - 60e3).pop();
    if (call) return /^(Task|Agent)$/.test(call.name) ? "работает помощник агента" : commandWhat(call.text);
  }
  return null;
}
const journalCache = new Map(); // ключ лабы → { at, what }: журналы перечитываем не чаще раза в 30 с
async function journalCommand(job, since) {
  const c = journalCache.get(job.key);
  if (c && Date.now() - c.at < PROC_CACHE_MS) return c.what;
  const what = await journalBusy(job, since).catch(() => null);
  journalCache.set(job.key, { at: Date.now(), what });
  return what;
}

/**
 * Признаки жизни лабы, у которой идёт ход агента: { state, what, at, alerted }.
 *   active — за последние 2 мин агент что-то записал (what — что именно, at — когда);
 *   long   — файлов давно нет, но идёт долгое: замеры, ожидание замка, команда стенда — или просто тишина меньше 15 мин;
 *   slept  — сервер недавно спал, ход продолжается сам;
 *   stuck  — 15 мин и больше без единого признака (alerted — владельцу уже написали).
 */
export async function activityOf(job, { now = Date.now() } = {}) {
  if (job.sleptWake && now - job.sleptWake.to < SLEPT_MS) {
    return { state: "slept", what: `Сервер уходил в сон (${job.sleptWake.text}) — продолжаю с того же места`, at: job.sleptWake.to, alerted: false };
  }
  const since = job.turnAt || job.updatedAt || now;
  const files = await recentFiles(job.dir);
  const last = files.find((f) => f.mtime >= since - 1000);
  const at = last ? last.mtime : since;
  if (now - at < ACTIVE_MS) return { state: "active", what: last ? describe(last.rel) : "начинает работу", at, alerted: false };
  const lock = await lockInfo();
  if (lock?.key === job.key) return { state: "long", what: "идут замеры нагрузки", at, alerted: false };
  if (lock?.key) return { state: "long", what: "ждёт очереди на замеры: их сейчас делает другой студент", at, alerted: false };
  const cmd = AGENT ? await journalCommand(job, since) : busyCommand(await processLines(), job);
  if (cmd) return { state: "long", what: cmd, at, alerted: false };
  if (now - at < STUCK_MS) return { state: "long", what: "думает или выполняет долгую команду", at, alerted: false };
  return { state: "stuck", what: last ? describe(last.rel) : null, at, alerted: job.stuckAlert === job.turnAt };
}
