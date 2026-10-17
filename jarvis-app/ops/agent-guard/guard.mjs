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
// Подключение: настройки ПОЛЬЗОВАТЕЛЯ Claude Code, ~/.claude/settings.json (hooks.PreToolUse) — ставит и убирает
// install.mjs рядом. В настройках папки агента сторож не работал: OpenClaw запускает Claude с «--setting-sources user»,
// настройки папки не читаются (проверено 4 окт 2026). Из настроек пользователя сторож вызывается во ВСЕХ сеансах Claude
// Code этой учётной записи, поэтому действует он только в сессиях агента лаб (isAgentSession), а в остальных сразу
// выходит, ничего не проверяя и не записывая. Сбой самого сторожа (нет node, ошибка в коде) действие НЕ запрещает —
// иначе встали бы все лабы; отказы пишутся в guard.log рядом, отметка «сторож вызывался в лабе» — guard.seen.
//
// Инструменты самого OpenClaw (mcp__openclaw__…) агенту лаб открыты только по списку OC_TOOLS: остальные дают доступ к
// чужим сессиям, сообщениям от имени бота и настройкам шлюза, а лабе не нужны.
import { appendFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = (p) => String(p).replace(/\\+/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const HOME = norm(process.env.GUARD_HOME || homedir());                       // c:/users/user
const APP = norm(process.env.GUARD_APP || resolve(HERE, "..", ".."));         // …/moodle-work/jarvis-app
const OC = `${HOME}/.openclaw`, WS = `${OC}/workspace-files`, CL = `${HOME}/.claude`;
const OWN_PROJECT = `${CL}/projects/${WS.replace(/[^a-z0-9]/g, "-")}`;        // журналы и вспомогательные файлы самого агента
const SECRET_NAMES = /(^|[\/\s"'=`(])(users\.key|moodle[-_]token[\w.-]*|openclaw\.json[\w.-]*|\.credentials\.json|\.claude\.json[\w.-]*|\.git-credentials|credentials\.json|ngrok[-_]token[\w.-]*|ngrok\.yml)(?=$|[\s"'`);|&<>])/;
const BROWSER = ["/appdata/local/google/chrome/user data", "/appdata/roaming/mozilla/firefox", "/appdata/local/microsoft/edge/user data", "/appdata/roaming/opera software", "/appdata/local/yandex/yandexbrowser/user data"];
const under = (p, dir) => p === dir || p.startsWith(dir + "/");
const STATE = process.env.GUARD_STATE_DIR || HERE;                            // где лежат guard.seen и guard.log (в тестах — временная папка)
const OC_PREFIX = "mcp__openclaw__";
const OC_TOOLS = new Set(["web_fetch", "web_search", "browser", "view_image", "ask_user", "structured_output", "progress_card"]);

// Защищённые папки (внутри секреты/чужие данные) и их чувствительные родители. coversSecrets(dir) — папка dir
// содержит защищённое (dir === защищённого или его предок): такую нельзя отдавать под рекурсивный поиск Grep/Glob.
const PROT = [APP, OC, CL, `${HOME}/.ssh`, ...BROWSER.map((b) => HOME + b)];
const coversSecrets = (dir) => !!dir && PROT.some((p) => under(p, dir));
// moodle-work берём от расположения приложения (APP = …/moodle-work/jarvis-app), а НЕ от HOME: под отдельной учёткой
// doodle-agent homedir() = C:\Users\doodle-agent, а moodle-work остаётся у владельца; APP указывает на настоящую папку
// (сторож подключён абсолютным путём к guard.mjs в ней). На одной учётке результат тот же. [[server-migration]]
const MW = norm(resolve(APP, ".."));
// Родительские папки, рекурсия/подстановка по которым раскрывает секреты и данные других студентов (в тексте команды).
const ANCESTORS = [HOME, MW, `${MW}/users`, `${HOME}/appdata`, "c:/users", "c:/"];
const ANCESTORS_W = [HOME, MW, `${MW}/users`, `${HOME}/appdata`];
const OPS = `${MW}/ops`;                           // служебные данные и резервные копии работ — агенту лаб закрыто целиком
// Папка студента для пути abs: «…/moodle-work/users/<tg>» (обычные) или «…/moodle-work/<число>» (старые папки владельца), иначе null.
const studentFolderOf = (abs) => (/^(.*?\/moodle-work\/users\/[^/]+)(?=\/|$)/.exec(abs) || /^(.*?\/moodle-work\/\d+)(?=\/|$)/.exec(abs))?.[1] || null;
const ownLabRoot = (cwd) => studentFolderOf(norm(cwd || ""));   // своя папка студента — из рабочей папки сессии (если это папка лабы)
// Почему путь — чужая папка студента или moodle-work/ops. ownRoot — своя папка студента (из cwd) или null (не определить — тогда
// конкретный чужой путь пропускаем: отличить его от своего без cwd нельзя; массовую рекурсию ловит ANCESTORS, см. NOTES п.153).
function whyStudentPath(abs, ownRoot) {
  if (under(abs, OPS)) return "папка moodle-work\\ops закрыта (служебные данные и резервные копии работ)";
  const sf = studentFolderOf(abs);
  if (sf && ownRoot && sf !== ownRoot) return "папка другого студента закрыта — работай только в своей папке лабы";
  return null;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Массовая операция: рекурсия, архивация, копирование целиком, поиск по дереву.
const BULK = /(?:^|[\s;|&(])(?:tar|robocopy|xcopy|compress-archive)\b|-recurse\b|-include\b|\bselect-string\b|\bfindstr\s+\/\S*s|\b(?:grep|rg)\s+-\S*[ru]|\bcp\s+-\S*r/;
// Переменные окружения и «~», которыми можно спрятать защищённый путь. c уже приведён norm (нижний регистр, прямые слэши).
const EXPAND = { userprofile: HOME, home: HOME, homepath: HOME, localappdata: `${HOME}/appdata/local`, appdata: `${HOME}/appdata/roaming`, programdata: "c:/programdata" };
function expandVars(c) {
  return c
    .replace(/(^|[\s"'`;|&(=])\/([a-z])\//g, "$1$2:/")                               // форма Git Bash: /c/users → c:/users
    .replace(/%(\w+)%/g, (_, k) => EXPAND[k.toLowerCase()] ?? `%${k}%`)
    .replace(/\$(?:env:|\{env:)(\w+)\}?/gi, (_, k) => EXPAND[k.toLowerCase()] ?? `$env:${k}`)
    .replace(/(^|[\s"'`;|&(=])~(?=[\s/\\;|&)"']|$)/g, (_, p) => `${p}${HOME}`);
}
// Корень поиска из шаблона Glob: часть до первой подстановки, обрезанная до последней папки.
function globBase(pat) {
  const s = String(pat), i = s.search(/[*?[{]/), head = i === -1 ? s : s.slice(0, i);
  const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  return cut === -1 ? (i === -1 ? head : "") : head.slice(0, cut);
}

/**
 * Сессия агента лаб? Журнал сессии лежит в папке проекта агента или рабочая папка действия — внутри его рабочей папки.
 * Признак — только папка: сеанс Claude Code, который владелец сам откроет в рабочей папке агента, тоже считается
 * агентом (будут отказы и записи в guard.log) — с приложением работать из другой папки. Имя папки проекта Claude Code
 * получает заменой знаков на «-», поэтому папок вида .openclaw\workspace\files или workspace.files не заводить.
 */
export function isAgentSession(input) {
  const t = norm(input?.transcript_path || ""), c = norm(input?.cwd || "");
  return (!!t && under(t, OWN_PROJECT)) || (!!c && under(c, WS));
}

/** Абсолютный путь в общем виде: «/c/Users/…» (Git Bash), «~», относительный от рабочей папки действия. */
export function absPath(p, cwd) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (s.startsWith("@")) s = s.slice(1).trim();          // view_image принимает и «@путь»
  if (/^(https?|data):/i.test(s)) return "";            // ссылка, а не путь на диске
  if (/^file:/i.test(s)) { try { s = fileURLToPath(s); } catch { s = s.replace(/^file:\/+/i, ""); } }
  if (!s) return "";
  s = s.replace(/^~(?=$|[\\/])/, HOME).replace(/^\/([a-zA-Z])\//, "$1:/").replace(/^\/\/([a-zA-Z])\//, "$1:/");
  // Windows отбрасывает хвостовые точки и пробелы в именах («jarvis-app.\…» = «jarvis-app\…») — убираем, иначе уловка обходит under().
  return norm(isAbsolute(s) ? resolve(s) : resolve(cwd || ".", s)).replace(/[ .]+(?=\/|$)/g, "");
}

/** Почему путь закрыт (строка) или null. write — действие меняет файл. ownRoot — своя папка студента (чужие закрыты). */
export function whyPath(abs, write, ownRoot) {
  if (!abs) return null;
  const st = whyStudentPath(abs, ownRoot);
  if (st) return st;
  if (under(abs, APP)) {
    const inAssets = under(abs, `${APP}/assets`); // готовые скрипты и образцы: читать и смотреть список можно, менять — нет
    if (inAssets && !write) return null;
    return inAssets ? "готовые скрипты приложения менять нельзя" : "папка приложения закрыта (в ней ключи и данные пользователей)";
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

// Закодированный запуск PowerShell: -EncodedCommand и любое его сокращение (-e, -ec, -en, -enc, -encod…), также через «/»
// и длинное тире. Сокращения ищем только среди ключей самого powershell/pwsh — до -Command/-File и до «;», «|», «&&»:
// у других программ свой -enc (pdftotext -enc UTF-8 — без него теряется кириллица; 5 ложных отказов в лабе 31667, 16 окт),
// и текст после -Command — уже команда, а не ключи PowerShell. Полное «-encodedc…» закрыто везде.
const ENC_FULL = /(?:^|[\s"'`(,])[-/–—]encodedc/;
const PS_EXE = /(?:^|[\s"'`;|&(=/])(?:powershell|pwsh)(?:\.exe)?(?=[\s"'`;|&),]|$)/g;
const PS_SCRIPT = /^(?:c|co|com|comm|comma|comman|command|commandwithargs|cwa|f|fi|fil|file)$/;  // дальше — текст команды/скрипта
function encodedPs(c) {
  if (ENC_FULL.test(c)) return true;
  for (const m of c.matchAll(PS_EXE)) {
    const rest = c.slice(m.index + m[0].length).split(/[;|\n]|&&/)[0];
    for (const raw of rest.split(/[\s,]+/)) {
      const t = raw.replace(/^[\s"'`(@]+|["'`)]+$/g, "");
      if (!/^[-/–—]/.test(t)) continue;
      const k = t.slice(1);
      if (PS_SCRIPT.test(k)) break;
      if (k === "ec" || (k.length >= 1 && "encodedcommand".startsWith(k))) return true;
    }
  }
  return false;
}

/** Почему команда оболочки закрыта (строка) или null. Команда разбирается как текст — см. оговорку в начале файла. */
export function whyCommand(command, cwd) {
  const c = expandVars(norm(command));
  // Чужие папки студентов и moodle-work\ops (служебные данные, резервные копии работ).
  if (/\/moodle-work\/ops(?![\w-])/.test(c)) return "папка moodle-work\\ops закрыта (служебные данные и резервные копии работ)";
  const ownRoot = ownLabRoot(cwd);
  if (ownRoot) {
    const ownTg = /\/moodle-work\/users\/([^/]+)$/.exec(ownRoot)?.[1], ownNum = /\/moodle-work\/(\d+)$/.exec(ownRoot)?.[1];
    for (const m of c.matchAll(/\/moodle-work\/users\/([^/\s"'`;|&<>)]+)/g)) if (m[1] !== ownTg) return "папка другого студента закрыта — работай только в своей папке лабы";
    for (const m of c.matchAll(/\/moodle-work\/(\d+)(?![\w-])/g)) if (m[1] !== ownNum) return "папка другого студента закрыта — работай только в своей папке лабы";
  }
  // 8.3-короткие имена (ИМЯ~1): под ними прячут moodle-work, jarvis-app, .openclaw, .claude — полным путём их не узнать.
  if (/(?:^|[\s"'`;|&(=/\\])[a-z0-9]{1,8}~\d/.test(c)) return "короткие имена (8.3, вида ИМЯ~1) закрыты — используй полный путь";
  // Сетевые пути (UNC, \\сервер\ресурс, админ-шары C$) — ими обходят проверку локальных путей.
  if (/\/(?:localhost|127\.0\.0\.1|[a-z]\$)\//.test(c)) return "сетевые пути (UNC, \\\\сервер\\ресурс) закрыты";
  // Косвенный и закодированный запуск, ссылки-соединения, хранилища учётных данных и дамп окружения — лабе не нужны.
  if (encodedPs(c)) return "запуск закодированной команды закрыт";
  if (/\biex\b|invoke-expression/.test(c)) return "непрямой запуск (iex/Invoke-Expression) закрыт";
  if (/\bmklink\b|-itemtype\s+(?:junction|symboliclink|hardlink)/.test(c)) return "создание ссылок и соединений (mklink/junction) закрыто";
  if (/\bcmdkey\b/.test(c)) return "диспетчер учётных данных Windows (cmdkey) закрыт";
  if (/get-childitem\s+env:|\bgci\s+env:|\bdir\s+env:|\[environment\]::getenvironmentvariable|\bprintenv\b/.test(c)) return "перечисление переменных окружения закрыто (в них бывают токены)";
  // Рекурсия/архивация/копирование родительской папки целиком — раскрывает секреты и данные других студентов.
  if (BULK.test(c) && ANCESTORS.some((a) => new RegExp(`${esc(a)}(?:/\\*{0,2})?(?=[\\s"'\`;|&)]|$|[*?\\[])`).test(c)))
    return "массовое чтение или копирование родительской папки закрыто (в ней секреты и данные других студентов)";
  // Рекурсия вверх по дереву (..) из рабочей папки агента уводит в домашнюю папку с секретами — полного пути в тексте нет, закрываем.
  if (BULK.test(c) && /(?:^|[\s"'`;|&(=/\\])\.\.(?=[/\\])/.test(c)) return "рекурсия вверх по дереву («..») закрыта — указывай полный путь";
  // Подстановка (*, ?, []) прямо в имени папки внутри родительской — «jarvis-*», «.open*», «jarvis-[a]pp».
  if (ANCESTORS_W.some((a) => new RegExp(`${esc(a)}/[^/\\s"'\`;|&<>)]*[*?\\[]`).test(c)))
    return "подстановка в именах защищённых папок закрыта — используй полный путь";
  const home = `(?:${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/c/users/[^/\\s"']+|~|\\$home|\\$\\{home\\}|\\$env:userprofile|%userprofile%|\\$userprofile)`;
  // Папка приложения: упоминать можно только …/jarvis-app/assets и файлы в ней (запуск готовых скриптов, подключение
  // lt_asc.py через sys.path), без «..».
  for (const m of c.matchAll(/jarvis-app(?![\w-])([^\s"'`;|&<>)]*)/g)) {
    if (!/^\/assets(\/|$)/.test(m[1]) || m[1].includes("..")) return "папка приложения закрыта (в ней ключи и данные пользователей); доступны только готовые скрипты из jarvis-app\\assets";
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
  const ownRoot = ownLabRoot(cwd);                       // своя папка студента — из рабочей папки сессии (чужие закрыты)
  if (tool === "Bash" || tool === "PowerShell") {
    const why = whyCommand(ti.command || "", cwd);
    return why ? { deny: why } : {};
  }
  if (tool.startsWith(OC_PREFIX) && !OC_TOOLS.has(tool.slice(OC_PREFIX.length))) return { deny: "этот инструмент OpenClaw агенту лаб закрыт (чужие сессии, сообщения от имени бота, настройки шлюза)" };
  // Ссылки: file:// на секрет (браузер, web_fetch, WebFetch) и панель управления шлюзом.
  for (const key of ["url", "targetUrl"]) {
    const u = ti[key];
    if (typeof u !== "string" || !u) continue;
    if (/^\s*file:/i.test(u)) { const why = whyPath(absPath(u, cwd), false, ownRoot); if (why) return { deny: why }; }
    if (/^\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):18789\b/i.test(u)) return { deny: "панель управления шлюзом (localhost:18789) агенту закрыта" };
  }
  const write = WRITERS.has(tool);
  // Уловки в именах путей, которые resolve/under() не распознают: 8.3-имена и сетевые пути.
  for (const raw of [ti.file_path, ti.path, ti.notebook_path, ...(Array.isArray(ti.paths) ? ti.paths : [])]) {
    if (typeof raw !== "string" || !raw) continue;
    if (/(?:^|[/\\])[a-z0-9]{1,8}~\d/i.test(raw)) return { deny: "короткие имена (8.3, вида ИМЯ~1) закрыты — используй полный путь" };
    if (/^\s*["']?\\\\/.test(raw)) return { deny: "сетевые пути (UNC, \\\\сервер\\ресурс) закрыты" };
  }
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof ti[key] !== "string" || !ti[key]) continue;
    const why = whyPath(absPath(ti[key], cwd), write, ownRoot);
    if (why) return { deny: why };
  }
  for (const p of Array.isArray(ti.paths) ? ti.paths : []) { // view_image: несколько картинок разом
    const why = typeof p === "string" && p ? whyPath(absPath(p, cwd), false, ownRoot) : null;
    if (why) return { deny: why };
  }
  // Grep/Glob: корень поиска не должен быть внутри защищённого, ни быть родителем защищённого (рекурсия раскроет секреты).
  if (tool === "Grep" || tool === "Glob") {
    let root = typeof ti.path === "string" && ti.path ? absPath(ti.path, cwd) : "";
    if (tool === "Glob" && typeof ti.pattern === "string" && ti.pattern) {
      const gb = globBase(ti.pattern);
      if (gb) root = absPath(gb, ti.path || cwd);
      else if (!root) root = absPath(".", cwd);
    }
    if (root) {
      root = root.replace(/\/+$/, "") || root;                 // «c:/» → «c:», иначе under() с «c://» промахивается по корню диска
      const why = whyPath(root, false, ownRoot) || (coversSecrets(root) ? "поиск по папке с секретами или данными других студентов закрыт" : null);
      if (why) return { deny: why };
    }
  }
  // Шаблон поиска файлов сам может содержать путь («C:/…/jarvis-app/**»).
  for (const key of ["pattern", "glob"]) {
    if (typeof ti[key] !== "string" || !/[\\/]/.test(ti[key])) continue;
    const why = whyCommand(ti[key], cwd) || (tool === "Glob" ? whyPath(absPath(ti[key].replace(/[*?[{].*$/, ""), ti.path || cwd), false, ownRoot) : null);
    if (why) return { deny: why };
  }
  return {};
}

// --- запуск перехватчиком: описание действия приходит в стандартный ввод ---
// Путь запуска сравнивается развёрнутым: при запуске через ссылку на папку Node даёт модулю настоящий путь.
const invoked = (() => { try { return norm(realpathSync.native(process.argv[1])); } catch { return norm(process.argv[1] || ""); } })();
if (invoked && invoked === norm(fileURLToPath(import.meta.url))) {
  if (process.stdin.isTTY) process.exit(0);          // запущен руками, ввода не будет
  setTimeout(() => process.exit(0), 4000).unref();   // ввод не закрыли — не держим чужой сеанс, действие не запрещаем
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw.replace(/^\uFEFF/, "") || "{}");
      if (!isAgentSession(input)) process.exit(0);   // не агент лаб (свои сеансы владельца, чат бота) — не вмешиваемся
      const seen = join(STATE, "guard.seen");        // отметка «сторож вызывался в лабе» — по времени файла видно, что он подключён
      try { utimesSync(seen, new Date(), new Date()); } catch { try { writeFileSync(seen, ""); } catch { /* не важно */ } }
      const r = decide(input);
      if (r.deny) {
        const what = input.tool_name === "Bash" || input.tool_name === "PowerShell" ? String(input.tool_input?.command || "") : String(input.tool_input?.file_path || input.tool_input?.path || input.tool_input?.pattern || "");
        try { appendFileSync(join(STATE, "guard.log"), `${new Date().toISOString()} отказ ${input.tool_name}: ${r.deny} | ${what.replace(/\s+/g, " ").slice(0, 200)} | сессия ${String(input.session_id || "").slice(0, 8)}\n`); } catch { /* журнал не обязателен */ }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `Отказано защитой сервера: ${r.deny}. Секреты и служебные файлы приложения агенту недоступны; работай в папке лабораторной. Если без этого лабораторную не выполнить — скажи студенту, что доступ закрыт, и продолжай без этого.` } }));
      }
    } catch { /* сбой сторожа действие не запрещает */ }
    process.exit(0);
  });
}
