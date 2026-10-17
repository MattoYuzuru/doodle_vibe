// Подключение сторожа агента (guard.mjs) в настройках ПОЛЬЗОВАТЕЛЯ Claude Code: ~/.claude/settings.json.
//
// Почему не в настройках папки агента: OpenClaw запускает Claude с флагом «--setting-sources user» (другое значение он
// отвергает), и настройки папки (.claude/settings.json в рабочей папке агента) не читаются вовсе — проверено 4 окт 2026.
// Перехватчик из настроек пользователя вызывается во всех сеансах Claude Code этой учётной записи, поэтому сам сторож
// действует только в сессиях агента лаб, а в остальных сразу выходит (см. isAgentSession в guard.mjs).
//
// Запуск:  node install.mjs            — подключить или обновить запись
//          node install.mjs --remove   — убрать запись
//          node install.mjs --check    — только показать, подключён ли
// Остальные настройки и чужие перехватчики не трогаются и не печатаются; перед первой правкой рядом остаётся копия
// settings.json.bak-guard. Для проверок: GUARD_SETTINGS=<путь к файлу настроек>.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.GUARD_SETTINGS || join(homedir(), ".claude", "settings.json");
const GUARD = join(HERE, "guard.mjs").replace(/\\/g, "/");
// Инструменты, которые сторож проверяет: работа с файлами и командами и инструменты самого OpenClaw (mcp__openclaw__…).
export const MATCHER = "Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep|Bash|PowerShell|mcp__openclaw__.*";
export const COMMAND = `node "${GUARD}"`; // прямые слеши и кавычки: одинаково понимают Git Bash, cmd и PowerShell
const MARK = "agent-guard/guard.mjs"; // по этой части команды узнаём свой перехватчик
const isMine = (h) => String(h?.command || "").replace(/\\/g, "/").includes(MARK);
const mine = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(isMine);
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** Настройки такого вида править можно? Корень и hooks — объекты, hooks.PreToolUse — список (либо их нет). */
export function shapeOk(settings) {
  return isObj(settings) && (settings.hooks === undefined || isObj(settings.hooks)) && (settings.hooks?.PreToolUse === undefined || Array.isArray(settings.hooks.PreToolUse));
}

/** Новое содержимое настроек: перехватчик сторожа добавлен, обновлён или убран. Остальное — как было. */
export function apply(settings, { remove = false } = {}) {
  const s = { ...settings }, hooks = { ...(s.hooks || {}) };
  // Из записей убирается только свой перехватчик; запись удаляется, когда в ней больше ничего не осталось.
  const pre = [];
  for (const e of hooks.PreToolUse || []) {
    if (!mine(e)) { pre.push(e); continue; }
    const rest = e.hooks.filter((h) => !isMine(h));
    if (rest.length) pre.push({ ...e, hooks: rest });
  }
  if (!remove) pre.push({ matcher: MATCHER, hooks: [{ type: "command", command: COMMAND, timeout: 15 }] });
  if (pre.length) hooks.PreToolUse = pre; else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
  return s;
}

/** Подключён ли сторож в этих настройках и той ли записью: «подключён», «устарел» или «нет». */
export function state(settings) {
  const e = (Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : []).find(mine);
  if (!e) return "нет";
  return e.matcher === MATCHER && e.hooks.length === 1 && e.hooks[0].command === COMMAND ? "подключён" : "устарел";
}

// Путь запуска сравнивается развёрнутым: при запуске через ссылку на папку Node даёт модулю настоящий путь.
const invoked = (() => { try { return realpathSync.native(process.argv[1]).toLowerCase(); } catch { return String(process.argv[1] || "").toLowerCase(); } })();
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove"), check = args.includes("--check");
  if (args.some((a) => a !== "--remove" && a !== "--check") || (remove && check)) {
    console.error("Запуск: node install.mjs (подключить или обновить) | node install.mjs --remove (убрать) | node install.mjs --check (только показать)");
    process.exit(2);
  }
  let raw = "", settings = {};
  if (existsSync(FILE)) {
    raw = readFileSync(FILE, "utf8");
    try { settings = JSON.parse(raw.replace(/^﻿/, "") || "{}"); }
    catch (e) { console.error(`Файл настроек не разобрать (${e.message}) — ничего не менялось: ${FILE}`); process.exit(1); }
  }
  if (!shapeOk(settings)) { console.error(`Неожиданный вид настроек (корень, hooks или hooks.PreToolUse не того типа) — ничего не менялось: ${FILE}`); process.exit(1); }
  const before = state(settings);
  const off = settings.disableAllHooks === true ? " ВНИМАНИЕ: в настройках стоит disableAllHooks — перехватчики выключены все, сторож не вызывается." : "";
  if (check) { console.log(`сторож в настройках пользователя: ${before} (${FILE}).${off}`); process.exit(before === "подключён" && !off ? 0 : 1); }
  if (remove ? before === "нет" : before === "подключён") { console.log(`без изменений: сторож ${before}.${off}`); process.exit(0); }
  const next = apply(settings, { remove });
  const text = JSON.stringify(next, null, 2) + "\n";
  mkdirSync(dirname(FILE), { recursive: true });
  const bak = FILE + ".bak-guard";
  if (raw && !existsSync(bak)) copyFileSync(FILE, bak);
  const tmp = FILE + ".tmp-guard"; // запись через временный файл: читающие не увидят половину файла
  writeFileSync(tmp, raw.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  renameSync(tmp, FILE);
  console.log(`${remove ? "убрано" : before === "нет" ? "подключено" : "обновлено"}: ${FILE} (было: ${before}, стало: ${state(next)}); остальные настройки и чужие перехватчики не тронуты.${off}`);
}
