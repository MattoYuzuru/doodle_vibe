// Сторож агента лаб (4 окт 2026, «начнём с защиты»). Перехватчик Claude Code (PreToolUse): перед каждым действием агента
// получает на вход описание действия и отказывает, если оно касается секретов сервера.
//
// Зачем. Агент с командной строкой работает под той же учётной записью Windows, что и сервер приложения, а рядом лежат
// ключ шифрования и токены Moodle всех студентов, токен бота, вход в Claude. Правила агента («секреты не открывай») —
// это текст; обманутый чужим текстом агент может их нарушить. Сторож — первый настоящий рубеж: отказ приходит от
// программы, а не от самого агента.
//
// Что закрыто: папка приложения jarvis-app (кроме чтения готовых скриптов и образцов из assets), папка .openclaw
// (кроме рабочей папки агента; его настройки .claude там — только чтение), вход и журналы Claude (~/.claude, кроме
// собственных «tool-results» и «memory» агента), ключи .ssh, хранилища паролей браузеров, а также файлы секретов по имени.
//
// Чего сторож НЕ умеет: команду оболочки он видит как текст и ловит по упоминанию защищённых путей и имён. Путь,
// собранный по частям или зашифрованный, он не распознает. Это рубеж от простых случаев, а не изоляция: настоящая
// изоляция — отдельная учётная запись Windows для агента (см. ops\migrate\ПЕРЕНОС.md).
//
// Подключение: C:\Users\User\.openclaw\workspace-files\.claude\settings.json (hooks.PreToolUse). Сбой самого сторожа
// (нет node, ошибка в коде) действие НЕ запрещает — иначе встали бы все лабы; отказы пишутся в guard.log рядом.
import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = (p) => String(p).replace(/\\+/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const HOME = norm(process.env.GUARD_HOME || homedir());                       // c:/users/user
const APP = norm(process.env.GUARD_APP || resolve(HERE, "..", ".."));         // …/moodle-work/jarvis-app
const OC = `${HOME}/.openclaw`, WS = `${OC}/workspace-files`, CL = `${HOME}/.claude`;
const OWN_PROJECT = `${CL}/projects/${WS.replace(/[^a-z0-9]/g, "-")}`;        // журналы и вспомогательные файлы самого агента
const SECRET_NAMES = /(^|[\/\s"'=`(])(users\.key|moodle-token[\w.-]*|openclaw\.json[\w.-]*|\.credentials\.json|ngrok-token[\w.-]*)(?=$|[\s"'`);|&<>])/;
const BROWSER = ["/appdata/local/google/chrome/user data", "/appdata/roaming/mozilla/firefox", "/appdata/local/microsoft/edge/user data", "/appdata/roaming/opera software", "/appdata/local/yandex/yandexbrowser/user data"];
const under = (p, dir) => p === dir || p.startsWith(dir + "/");

/** Абсолютный путь в общем виде: «/c/Users/…» (Git Bash), «~», относительный от рабочей папки действия. */
export function absPath(p, cwd) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  s = s.replace(/^~(?=$|[\\/])/, HOME).replace(/^\/([a-zA-Z])\//, "$1:/").replace(/^\/\/([a-zA-Z])\//, "$1:/");
  return norm(isAbsolute(s) ? resolve(s) : resolve(cwd || ".", s));
}

/** Почему путь закрыт (строка) или null. write — действие меняет файл. */
export function whyPath(abs, write) {
  if (!abs) return null;
  if (under(abs, APP)) {
    if (under(abs, `${APP}/assets`) && abs !== `${APP}/assets` ? !write : false) return null;
    return under(abs, `${APP}/assets`) ? "готовые скрипты приложения менять нельзя" : "папка приложения закрыта (в ней ключи и данные пользователей)";
  }
  if (under(abs, OC)) {
    if (!under(abs, WS)) return "папка .openclaw закрыта (в ней токены)";
    if (write && under(abs, `${WS}/.claude`)) return "настройки защиты агента менять нельзя";
    return null;
  }
  if (under(abs, CL)) {
    if (under(abs, OWN_PROJECT) && /\/(tool-results|memory)(\/|$)/.test(abs)) return null;
    return "папка .claude закрыта (вход в Claude и чужие журналы)";
  }
  if (under(abs, `${HOME}/.ssh`)) return "ключи .ssh закрыты";
  if (BROWSER.some((b) => abs.includes(b))) return "хранилище браузера закрыто";
  if (SECRET_NAMES.test(abs)) return "файл секретов закрыт";
  return null;
}

/** Почему команда оболочки закрыта (строка) или null. Команда разбирается как текст — см. оговорку в начале файла. */
export function whyCommand(command) {
  const c = norm(command);
  const home = `(?:${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/c/users/[^/\\s"']+|~|\\$home|\\$\\{home\\}|\\$env:userprofile|%userprofile%|\\$userprofile)`;
  // Папка приложения: упоминать можно только …/jarvis-app/assets/<файл> (запуск готовых скриптов), без «..».
  for (const m of c.matchAll(/jarvis-app(?![\w-])([^\s"'`;|&<>)]*)/g)) {
    if (!/^\/assets\/[^\s]/.test(m[1]) || m[1].includes("..")) return "папка приложения закрыта (в ней ключи и данные пользователей); доступны только готовые скрипты из jarvis-app\\assets";
  }
  for (const m of c.matchAll(/\.openclaw(?![\w-])([^\s"'`;|&<>)]*)/g)) {
    if (!/^\/workspace-files(\/|$)/.test(m[1]) || m[1].includes("..")) return "папка .openclaw закрыта (в ней токены)";
    if (/^\/workspace-files\/\.claude(\/|$)/.test(m[1])) return "настройки защиты агента закрыты";
  }
  for (const m of c.matchAll(new RegExp(`${home}/\\.claude([^\\s"'\`;|&<>)]*)`, "g"))) {
    const rest = `${CL}${m[1]}`;
    if (!(under(rest, OWN_PROJECT) && /\/(tool-results|memory)(\/|$)/.test(rest)) || m[1].includes("..")) return "папка .claude закрыта (вход в Claude и чужие журналы)";
  }
  if (new RegExp(`${home}/\\.ssh(/|\\s|$|["'])`).test(c)) return "ключи .ssh закрыты";
  if (BROWSER.some((b) => c.includes(b))) return "хранилище браузера закрыто";
  if (SECRET_NAMES.test(c)) return "файл секретов закрыт";
  return null;
}

const WRITERS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Решение по действию агента: { deny: "причина" } или {}. Чистая функция. */
export function decide(input) {
  const tool = String(input?.tool_name || ""), ti = input?.tool_input || {}, cwd = input?.cwd || WS;
  if (tool === "Bash" || tool === "PowerShell") {
    const why = whyCommand(ti.command || "");
    return why ? { deny: why } : {};
  }
  const write = WRITERS.has(tool);
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof ti[key] !== "string" || !ti[key]) continue;
    const why = whyPath(absPath(ti[key], cwd), write);
    if (why) return { deny: why };
  }
  // Шаблон поиска файлов сам может содержать путь («C:/…/jarvis-app/**»).
  for (const key of ["pattern", "glob"]) {
    if (typeof ti[key] !== "string" || !/[\\/]/.test(ti[key])) continue;
    const why = whyCommand(ti[key]) || (tool === "Glob" ? whyPath(absPath(ti[key].replace(/[*?[{].*$/, ""), ti.path || cwd), false) : null);
    if (why) return { deny: why };
  }
  return {};
}

// --- запуск перехватчиком: описание действия приходит в стандартный ввод ---
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const seen = join(HERE, "guard.seen"); // отметка «сторож вызывается» — по времени файла видно, что он подключён
      try { utimesSync(seen, new Date(), new Date()); } catch { try { writeFileSync(seen, ""); } catch { /* не важно */ } }
      const input = JSON.parse(raw.replace(/^\uFEFF/, "") || "{}");
      const r = decide(input);
      if (r.deny) {
        const what = input.tool_name === "Bash" || input.tool_name === "PowerShell" ? String(input.tool_input?.command || "") : String(input.tool_input?.file_path || input.tool_input?.path || input.tool_input?.pattern || "");
        try { appendFileSync(join(HERE, "guard.log"), `${new Date().toISOString()} отказ ${input.tool_name}: ${r.deny} | ${what.replace(/\s+/g, " ").slice(0, 200)} | сессия ${String(input.session_id || "").slice(0, 8)}\n`); } catch { /* журнал не обязателен */ }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `Отказано защитой сервера: ${r.deny}. Секреты и служебные файлы приложения агенту недоступны; работай в папке лабораторной. Если без этого лабораторную не выполнить — скажи студенту, что доступ закрыт, и продолжай без этого.` } }));
      }
    } catch { /* сбой сторожа действие не запрещает */ }
    process.exit(0);
  });
}
