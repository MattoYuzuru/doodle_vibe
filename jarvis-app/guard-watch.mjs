// Наблюдение за сторожем агента (ops\agent-guard\guard.mjs): жив ли он на самом деле. 4 окт 2026 сторож полдня считался
// подключённым, а в лабах не вызывался (настройки папки OpenClaw не читает) — и ничто об этом не сообщило. Теперь два
// признака, оба идут владельцу от бота:
//   1) запись сторожа пропала из настроек пользователя Claude Code (watchGuard — раз в полчаса);
//   2) ход агента с проверяемыми действиями прошёл, а отметка guard.seen не обновилась (afterTurn — после каждого хода):
//      так выглядит и стёртая запись, и переход OpenClaw в режим без перехватчиков, и «node не найден».
// Сообщения — не чаще раза в сутки на каждый признак (время последнего — в ops\agent-guard\guard.alert, переживает
// перезапуск сервера); недоставленное сообщение отправленным не считается. GUARD_WATCH=0 выключает (стенд).
//
// Агент под своей учётной записью Windows (agent-account.mjs): сторож подключён в настройках Claude Code учётки
// doodle-agent — их сервер и читает (чтение этого файла владельцу даёт ops\migrate\agent-account\1-права.ps1), а
// подключать сторожа заново нужно под той учётной записью.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT, AGENT_SETTINGS } from "./agent-account.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const OFF = process.env.GUARD_WATCH === "0";
const DAY = 24 * 3600e3;
const MARK = "agent-guard/guard.mjs"; // по этой части команды запись сторожа узнаётся в настройках (как в install.mjs)
const STATE = process.env.GUARD_STATE_DIR || join(DIR, "ops", "agent-guard");
const INSTALL = join(DIR, "ops", "agent-guard", "install.mjs");
const AS_AGENT = AGENT ? ` (под учётной записью ${AGENT.user})` : "";
const NO_ACCESS = "нет доступа к настройкам Claude Code учётной записи агента";
const RIGHTS = join(DIR, "ops", "migrate", "agent-account", "1-права.ps1");

/** Запись сторожа в настройках Claude Code (объект с matcher) или null. */
export function entryOf(settings) {
  const list = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  return list.find((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => String(h?.command || "").replace(/\\/g, "/").includes(MARK))) || null;
}

/**
 * Запись сторожа в настройках пользователя: { ok, matcher, why }. why — почему не ok: "нет записи", "перехватчики
 * выключены (disableAllHooks)" или "файл настроек не читается" (занят, испорчен, пойман в момент перезаписи).
 */
export function connected(file = process.env.GUARD_SETTINGS || AGENT_SETTINGS) {
  try {
    let raw;
    try { raw = readFileSync(file, "utf8").replace(/^﻿/, ""); }
    catch (e) {
      if (e.code === "ENOENT") return { ok: false, matcher: "", why: "нет записи" };
      if (e.code === "EACCES" || e.code === "EPERM") return { ok: false, matcher: "", why: NO_ACCESS };
      throw e;
    }
    if (!raw.trim()) return { ok: false, matcher: "", why: "файл настроек не читается" };
    const s = JSON.parse(raw), e = entryOf(s);
    if (!e) return { ok: false, matcher: "", why: "нет записи" };
    if (s.disableAllHooks === true) return { ok: false, matcher: String(e.matcher || ""), why: "перехватчики выключены (disableAllHooks)" };
    return { ok: true, matcher: String(e.matcher || ""), why: "" };
  } catch { return { ok: false, matcher: "", why: "файл настроек не читается" }; }
}

/** Когда сторож последний раз вызывался в сессии агента (мс) или 0. */
export function seenAt(file = join(STATE, "guard.seen")) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/** Ход с действиями, которые сторож обязан был увидеть (matcher — из его записи), а отметка старше начала хода (запас — минута)? */
export function guardMissed(tools, startedAt, seenMs, matcher) {
  if (!Array.isArray(tools) || !tools.length) return false;
  let re = null;
  try { re = matcher ? new RegExp(`^(?:${matcher})$`) : null; } catch { /* matcher не разобрать — считаем, что видит всё */ }
  return tools.some((t) => !re || re.test(String(t))) && !(seenMs >= startedAt - 60e3);
}

// Время последних сообщений владельцу по каждому признаку — в файле, чтобы перезапуск сервера не повторял тревогу.
const ALERTS = join(STATE, "guard.alert");
const lastAlert = (kind) => { try { return Number(JSON.parse(readFileSync(ALERTS, "utf8"))[kind]) || 0; } catch { return 0; } };
const markAlert = (kind) => {
  try {
    let all = {}; try { all = JSON.parse(readFileSync(ALERTS, "utf8")) || {}; } catch { /* файла ещё нет */ }
    writeFileSync(ALERTS, JSON.stringify({ ...all, [kind]: Date.now() }));
  } catch { /* не записалось — тревога просто повторится */ }
};
const sending = new Set();
/** Отправить владельцу не чаще раза в сутки; отправленным считается только доставленное (notify не вернул false). */
function alertOnce(kind, text, notify) {
  if (sending.has(kind) || Date.now() - lastAlert(kind) < DAY) return false;
  sending.add(kind);
  void Promise.resolve().then(() => notify(text)).then((ok) => { if (ok !== false) markAlert(kind); }).catch(() => {}).finally(() => sending.delete(kind));
  return true;
}

/** Текст тревоги «сторож не вызывался за ход»: совет зависит от того, на месте ли запись. */
export function missedText(c) {
  const head = "⚠️ Сторож агента не сработал: агент выполнял действия, а сторож ни разу не вызывался. Секреты сейчас защищены только правилами агента.";
  if (c.ok) return `${head}\nЗапись в настройках Claude Code на месте — значит, перехватчик не запускается: OpenClaw мог сменить способ запуска Claude (нужен «--setting-sources user»), либо node не находится, либо папка приложения переехала${AGENT ? `, либо у учётной записи ${AGENT.user} нет права записи в guard.seen` : ""}. Проверка${AS_AGENT}: node "${INSTALL}" --check, затем пробный ход агента и время файла guard.seen рядом с install.mjs.`;
  return `${head}\nПричина: ${c.why}.\n${fixHint(c.why)}`;
}
/** Что делать владельцу при такой причине. */
const fixHint = (why) => (why === "нет записи" ? `Подключить заново${AS_AGENT}: node "${INSTALL}"`
  : why === NO_ACCESS ? `Серверу нужно чтение этого файла (разрешение пропадает, когда файл перезаписывают): запустите ещё раз от администратора powershell -ExecutionPolicy Bypass -File "${RIGHTS}"`
    : `Проверка${AS_AGENT}: node "${INSTALL}" --check`);

/** После хода агента: tools — имена инструментов хода (toolSummary.tools), startedAt — начало хода, notify(text) — владельцу. */
export function afterTurn(tools, startedAt, notify) {
  if (OFF) return false;
  const c = connected();
  if (!guardMissed(tools, startedAt, seenAt(), c.ok ? c.matcher : "")) return false;
  console.error(`сторож агента не вызывался за ход с действиями (запись в настройках: ${c.ok ? "есть" : c.why})`);
  alertOnce("missed", missedText(c), notify);
  return true;
}

/** Раз в полчаса: запись сторожа на месте? Нет — сообщение владельцу (раз в сутки). Возвращает функцию проверки. */
export function watchGuard({ notify, everyMs = 30 * 60e3 } = {}) {
  if (OFF) return null;
  let unreadable = 0;
  const tick = () => {
    const c = connected();
    if (c.ok) { unreadable = 0; return true; }
    // Файл мог попасться в момент перезаписи — тревога только если не читается два раза подряд.
    if (c.why === "файл настроек не читается" && ++unreadable < 2) return false;
    console.error(`сторож агента: ${c.why}`);
    // Нет доступа — не значит «отключён»: запись может быть на месте, серверу просто не видно (отдельная тревога).
    if (c.why === NO_ACCESS) alertOnce("noaccess", `⚠️ Сервер не может проверить, подключён ли сторож агента: ${c.why}.\n${fixHint(c.why)}`, notify);
    else alertOnce("missing", `⚠️ Сторож агента отключён: ${c.why}. Секреты в лабах сейчас защищены только правилами агента.\n${fixHint(c.why)}`, notify);
    return false;
  };
  setInterval(tick, everyMs).unref?.();
  setTimeout(tick, 60e3).unref?.(); // первая проверка — через минуту после старта сервера
  return tick;
}
