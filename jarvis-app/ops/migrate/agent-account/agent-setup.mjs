// Первый вход под учётной записью агента лаб (doodle-agent), УЧЁТКА-АГЕНТА.md, шаг 4. Запускается из 2-агент.cmd.
//
// Ставит для этой учётной записи OpenClaw и Claude Code, Python-пакеты и библиотеку LTspice; заводит агента files по
// выгрузке, которую сделал 1-права.ps1 (export\setup.json: модель, запреты инструментов, файлы рабочей папки — токенов
// владельца там нет); настраивает Gateway (127.0.0.1:18789, вход по ключу) и его задачу «при входе»; подключает сторожа
// (ops\agent-guard\install.mjs) в настройках Claude Code этой учётной записи. Ключ Gateway кладёт в
// moodle-work\agent-shared\gateway-key.handoff (читать может только эта учётная запись и владелец) — его заберёт
// 3-ключ.cmd под учётной записью владельца. Сам ключ не печатается. Ничего не удаляет; повторный запуск безопасен.
//
// Вход в подписку Claude делает владелец сам (команды печатаются в конце).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
const LOCAL = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
const OC = join(APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs");
const CMD = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
let warnings = 0;
const say = (s = "") => console.log(s);
const warn = (s) => { warnings++; console.log(`  ВНИМАНИЕ: ${s}`); };
const stop = (s) => { console.log(`\nОСТАНОВЛЕНО: ${s}`); process.exit(1); };
/** Запуск программы с аргументами списком (без оболочки — кавычки и JSON передаются как есть). */
const run = (exe, args, { show = false, env } = {}) => {
  const r = spawnSync(exe, args, { encoding: "utf8", stdio: show ? "inherit" : "pipe", env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || (r.error ? String(r.error.message) : "") };
};
const viaCmd = (args, opts) => run(CMD, ["/d", "/s", "/c", ...args], opts); // npm и другие .cmd запускаются только через cmd
const oc = (args, opts) => run(process.execPath, [OC, ...args], opts);

say("=== Учётная запись агента лаб: OpenClaw, Claude Code, агент files, сторож ===");
const setupFile = join(HERE, "export", "setup.json");
if (!existsSync(setupFile)) stop(`нет ${setupFile}. Сначала владелец запускает 1-права.ps1 от администратора.`);
const setup = JSON.parse(readFileSync(setupFile, "utf8").replace(/^\uFEFF/, ""));
const me = userInfo().username;
if (me.toLowerCase() !== String(setup.agent).toLowerCase()) stop(`этот файл запускают под учётной записью ${setup.agent}, а сейчас — ${me}.`);
if (run("net", ["session"]).code === 0) stop(`${me} — администратор. Агенту нужна обычная учётная запись (УЧЁТКА-АГЕНТА.md, шаг 1).`);
if (!setup.files) stop("в выгрузке нет настроек агента files (модель и запреты инструментов). Владельцу: запустить 1-права.ps1 ещё раз — под его учётной записью должен стоять OpenClaw.");
const WORK = setup.work, APP = setup.app;
say(`Учётная запись: ${me}; moodle-work: ${WORK}`);

// 1. OpenClaw — та же версия, что у владельца
say("\n1. OpenClaw");
const want = setup.openclawVersion ? `openclaw@${setup.openclawVersion}` : "openclaw";
const have = existsSync(OC) ? (oc(["--version"]).out.match(/\d{4}\.\d+\.\d+/) || [""])[0] : "";
if (have && (!setup.openclawVersion || have === setup.openclawVersion)) say(`  уже стоит ${have}`);
else {
  say(`  ставлю ${want} (npm, для этой учётной записи)…`);
  if (viaCmd(["npm", "i", "-g", want], { show: true }).code !== 0 || !existsSync(OC)) stop("OpenClaw не установился — см. вывод npm выше.");
}
// Папка команд npm — в PATH этой учётной записи (чтобы в её терминале работали openclaw и claude).
const npmBin = join(APPDATA, "npm");
const userPath = run("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"]).out.trim();
if (!userPath.toLowerCase().split(";").includes(npmBin.toLowerCase())) {
  run("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', (@([Environment]::GetEnvironmentVariable('Path','User'), '${npmBin.replace(/'/g, "''")}') | Where-Object { $_ }) -join ';', 'User')`]);
  say(`  папка ${npmBin} добавлена в PATH этой учётной записи`);
}

// 2. Claude Code (им OpenClaw запускает модель)
say("\n2. Claude Code");
const claudeExe = join(HOME, ".local", "bin", "claude.exe");
if (existsSync(claudeExe) || viaCmd(["where", "claude"]).code === 0) say("  уже стоит");
else {
  say("  ставлю официальным установщиком (claude.ai/install.ps1, для этой учётной записи)…");
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"], { show: true });
  if (!existsSync(claudeExe) && viaCmd(["where", "claude"]).code !== 0) warn("Claude Code не нашёлся после установки — поставьте его вручную и запустите этот файл ещё раз.");
}

// 3. Python-пакеты для лаб (у каждой учётной записи свои) и библиотека LTspice
say("\n3. Python-пакеты и LTspice");
const py = ["C:\\Program Files\\Python312\\python.exe"].find((p) => existsSync(p)) || "python";
const freeze = join(HERE, "export", "pip-user-freeze.txt");
if (existsSync(freeze)) {
  say("  pip install --user по списку с ноутбука (несколько минут)…");
  if (run(py, ["-m", "pip", "install", "--user", "--disable-pip-version-check", "-r", freeze], { show: true }).code !== 0) warn("часть пакетов не встала — см. вывод pip выше; лабы с ними будут ставить их через агента окружения.");
} else warn("нет списка пакетов (export\\pip-user-freeze.txt) — пропускаю.");
const ltLib = join(LOCAL, "LTspice", "lib"), ltZip = join(WORK, "tools", "ltspice", "lib.zip");
if (existsSync(ltLib)) say("  библиотека LTspice уже есть");
else if (existsSync(ltZip)) {
  mkdirSync(join(LOCAL, "LTspice"), { recursive: true });
  if (run("tar", ["-xf", ltZip, "-C", join(LOCAL, "LTspice")]).code === 0 && existsSync(ltLib)) say(`  библиотека LTspice распакована в ${ltLib}`);
  else warn(`не распаковалась ${ltZip} — распакуйте её в ${join(LOCAL, "LTspice")} вручную.`);
} else warn(`нет ${ltZip} — библиотеку LTspice поставьте вручную в ${ltLib}.`);

// 4. Настройки OpenClaw: Gateway только на этом ПК, вход по ключу
say("\n4. Gateway");
const handoff = join(WORK, "agent-shared", "gateway-key.handoff");
let token = existsSync(handoff) ? readFileSync(handoff, "utf8").trim() : "";
if (!/^[0-9a-f]{48}$/.test(token)) token = randomBytes(24).toString("hex");
if (!existsSync(join(HOME, ".openclaw", "openclaw.json"))) {
  say("  первичная настройка OpenClaw (без входа в модель — его вы сделаете сами)…");
  const r = oc(["onboard", "--non-interactive", "--accept-risk", "--mode", "local", "--flow", "quickstart", "--auth-choice", "skip",
    "--gateway-auth", "token", "--gateway-bind", "loopback", "--gateway-port", "18789", "--gateway-token", token,
    "--skip-channels", "--skip-daemon", "--skip-search", "--skip-skills", "--skip-ui", "--skip-health", "--skip-hooks", "--skip-bootstrap"]);
  if (r.code !== 0) stop(`openclaw onboard не прошёл (код ${r.code}): ${(r.err || r.out).slice(-400)}`);
}
for (const [path, value] of [["gateway.mode", "\"local\""], ["gateway.bind", "\"loopback\""], ["gateway.port", "18789"], ["gateway.auth.mode", "\"token\""], ["gateway.auth.token", JSON.stringify(token)]]) {
  const r = oc(["config", "set", path, value, "--strict-json"]);
  if (r.code !== 0) warn(`openclaw config set ${path} — код ${r.code}: ${(r.err || r.out).replace(/[0-9a-f]{48}/g, "<ключ>").slice(-300)}`);
}
// Ключ — владельцу, через файл, который читают только эта учётная запись, владелец и система.
mkdirSync(dirname(handoff), { recursive: true });
writeFileSync(handoff, token + "\n");
const acl = run("icacls", [handoff, "/inheritance:r", "/grant:r", `${me}:F`, `*${setup.ownerSid}:R`, "*S-1-5-18:F"]);
if (acl.code !== 0) warn(`не удалось ограничить права на ${handoff}: ${acl.out || acl.err}`);
else say(`  ключ Gateway оставлен для 3-ключ.cmd: ${handoff} (сам ключ не печатается)`);

// 5. Агент files: рабочая папка, модель, запреты инструментов
say("\n5. Агент files");
const ws = join(HOME, ".openclaw", "workspace-files"), wsSrc = join(HERE, "export", "workspace-files");
mkdirSync(ws, { recursive: true });
if (existsSync(wsSrc)) {
  // Файлы рабочей папки (правила, память агента) — только те, которых тут ещё нет.
  cpSync(wsSrc, ws, { recursive: true, force: false, errorOnExist: false });
  say(`  файлы рабочей папки: ${readdirSync(ws).join(", ")}`);
} else warn("нет export\\workspace-files — рабочая папка агента files пустая.");
let agents = [];
try { agents = JSON.parse(oc(["agents", "list", "--json"]).out.replace(/^[^[]*/, "")); } catch { /* список не разобрать — заводим */ }
if (!agents.some((a) => a.id === "files")) {
  const r = oc(["agents", "add", "files", "--workspace", ws, "--model", String(setup.files.model || "anthropic/claude-sonnet-5-5"), "--non-interactive"]);
  if (r.code !== 0) stop(`openclaw agents add files не прошёл (код ${r.code}): ${(r.err || r.out).slice(-400)}`);
  say("  агент files заведён");
} else say("  агент files уже есть");
for (const key of ["model", "models", "tools", "identity"]) {
  if (setup.files[key] === undefined) continue;
  let r = oc(["config", "set", `agents.entries.files.${key}`, JSON.stringify(setup.files[key]), "--strict-json"]);
  if (r.code !== 0 && key === "models") r = oc(["config", "set", `agents.entries.files.${key}`, JSON.stringify(setup.files[key]), "--strict-json", "--replace"]);
  if (r.code !== 0) warn(`настройка agents.entries.files.${key} не записалась (код ${r.code}): ${(r.err || r.out).slice(-300)}`);
  else say(`  agents.entries.files.${key} — как у владельца`);
}
const deny = setup.files.tools?.deny?.length || 0;
say(`  запретов инструментов у агента files: ${deny}`);

// 6. Задача Gateway «при входе» (её завёл 1-права.ps1; OpenClaw обновляет её под себя и запускает без окна)
say("\n6. Служба Gateway");
const inst = oc(["gateway", "install", "--port", "18789"], { show: true, env: { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" } });
if (inst.code !== 0) warn(`openclaw gateway install — код ${inst.code}. Если задача «OpenClaw Gateway» не обновилась, владельцу запустить 1-права.ps1 ещё раз.`);

// 7. Сторож в настройках Claude Code этой учётной записи и папка журналов
say("\n7. Сторож агента");
const guard = join(APP, "ops", "agent-guard", "install.mjs");
run(process.execPath, [guard], { show: true });
if (run(process.execPath, [guard, "--check"], { show: true }).code !== 0) warn("сторож не подключился — см. строки выше.");
mkdirSync(join(HOME, ".claude", "projects"), { recursive: true }); // владелец получит чтение журналов (1-права.ps1, второй запуск)

// 8. Что ещё нужно для лаб на этом экране — только проверка
say("\n8. Проверка окружения");
say(`  Docker: ${run("docker", ["version", "--format", "{{.Server.Version}}"]).code === 0 ? "отвечает" : "не отвечает — откройте Docker Desktop, включите «запускать при входе» и интеграцию с Ubuntu"}`);
const wslList = run("wsl", ["-l", "-q"]).out.replace(/\0/g, "");
say(`  WSL Ubuntu: ${/ubuntu/i.test(wslList) ? "есть" : "нет — wsl --install -d Ubuntu (шаг 4 в УЧЁТКА-АГЕНТА.md)"}`);

say("\n=== Готово" + (warnings ? ` с замечаниями: ${warnings} (см. ВНИМАНИЕ выше)` : "") + " ===");
say("Дальше — вход в подписку Claude для этой учётной записи (токен вставляйте в окно терминала, не в чат):");
say("  claude setup-token");
say("  openclaw models auth login --provider anthropic --method setup-token --agent files");
say("  openclaw gateway restart");
say("Потом под своей учётной записью: 1-права.ps1 ещё раз (от администратора), затем 3-ключ.cmd.");
