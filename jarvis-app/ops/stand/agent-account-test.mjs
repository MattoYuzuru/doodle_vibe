// Проверка подготовки к отдельной учётной записи агента лаб (agent-account.mjs и всё, что от неё зависит): пути журналов
// и настроек агента, общие файлы в agent-shared, правило про Docker, перезапуск Gateway задачей, «какая команда идёт» по
// журналу, путь списка WSL-пользователей. Всё — на временных папках; настоящие журналы, настройки и права не трогаются.
// Запуск: node agent-account-test.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", "..");
const root = join(tmpdir(), `agent-account-test-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const JR = join(root, "journals");
mkdirSync(JR, { recursive: true });
// Модули подключаются с временными папками (как в usage-test): живые журналы и хранилище расхода не читаются и не пишутся.
process.env.LAB_TRANSCRIPTS_DIR = JR;
process.env.USAGE_TRANSCRIPTS_DIR = join(root, "tr");
process.env.USAGE_CHAT_TRANSCRIPTS_DIR = join(root, "chat");
process.env.USAGE_STORE_DIR = join(root, "store");
process.env.MOODLE_DIRECT = "0";
const url = (f) => pathToFileURL(join(APP, f)).href;

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

// --- без файла agent-account.json: всё как на ноутбуке ---
{
  const acc = await import(url("agent-account.mjs"));
  const gw = await import(url("gateway-watch.mjs"));
  const W = join(homedir(), "moodle-work");
  check("без agent-account.json: агент под той же учётной записью, журналы — в домашней папке сервера", acc.AGENT === null
    && acc.AGENT_TRANSCRIPTS === join(homedir(), ".claude", "projects", join(homedir(), ".openclaw", "workspace-files").replace(/[^A-Za-z0-9]/g, "-"))
    && acc.AGENT_SETTINGS === join(homedir(), ".claude", "settings.json"), acc.AGENT_TRANSCRIPTS);
  check("без agent-shared замки — в корне moodle-work, как раньше", existsSync(join(W, "agent-shared")) || (acc.measureLock() === join(W, ".measure.lock") && acc.sharedFile(".install.lock") === join(W, ".install.lock")), acc.measureLock());
  const local = join(process.env.LOCALAPPDATA || "", "Programs", "DockerDesktop", "Docker Desktop.exe");
  check("правило про Docker: путь, где Docker стоит на этом ПК; текст правил прежний", !existsSync(local) || acc.dockerRule() === `Docker на этом ПК стоит не в \`Program Files\`. Если \`docker info\` не отвечает, запусти \`${local}\` и подожди, пока \`docker info\` заработает (до двух минут). Другие пути не пробуй: запуск несуществующего файла открывает на экране владельца окно с ошибкой.`, acc.dockerRule());
  const [c1, a1] = gw.restartCommand(null), [c2, a2] = gw.restartCommand({ user: "doodle-agent", restartTask: "Doodle Gateway Restart" });
  check("перезапуск Gateway: своим OpenClaw, а под отдельной учётной записью — запуском её задачи", c1 === process.execPath && a1.slice(1).join(" ") === "gateway restart"
    && /schtasks\.exe$/i.test(c2) && a2.join("|") === "/Run|/TN|Doodle Gateway Restart", `${c2} ${a2.join(" ")}`);
  const tpl = readFileSync(join(APP, "lab-instruction.md"), "utf8"), env = readFileSync(join(APP, "env-instruction.md"), "utf8");
  check("в правилах лабы и окружения нет зашитых путей Docker и замков — только подстановки", tpl.includes("{{LOCK}}") && tpl.includes("{{DOCKER_START}}") && env.includes("{{DOCKER_START}}") && env.includes("{{INSTALL_LOCK}}")
    && !/DockerDesktop|moodle-work\\\.(measure|install)\.lock/.test(tpl + env));
}

// --- «какая команда идёт» по журналу Claude CLI (агент под своей учётной записью) ---
{
  const act = await import(url("activity.mjs"));
  const t0 = Date.parse("2026-10-16T12:00:00Z"), iso = (ms) => new Date(ms).toISOString();
  const user = (text, at) => JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: text } });
  const use = (id, name, input, at) => JSON.stringify({ type: "assistant", timestamp: iso(at), message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, at) => JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const first = "# Лабораторная Нагрузочное испытание (Moodle id 777)\n\nСтудент: Иванов. Рабочая папка: `C:\\Users\\User\\moodle-work\\users\\5001\\777` (подпапки …).";
  const lines = [user(first, t0), use("t1", "Bash", { command: "ls" }, t0 + 1000), result("t1", t0 + 2000), use("t2", "Bash", { command: "k6 run load.js" }, t0 + 3000)];
  check("журнал: вызов без результата — идёт, с результатом — нет, до начала хода — не считается, оборванная строка пропускается",
    act.pendingTools(["{оборван", ...lines].join("\n"), t0).map((c) => c.text).join() === "k6 run load.js" && act.pendingTools(lines.join("\n"), t0 + 10e3).length === 0
    && act.pendingTools([...lines, result("t2", t0 + 4000)].join("\n"), t0).length === 0);
  writeFileSync(join(JR, "s1.jsonl"), lines.join("\n") + "\n");
  const job = { tgId: 5001, id: "777", key: "5001-777", dir: "C:\\Users\\User\\moodle-work\\users\\5001\\777" };
  const mine = await act.journalBusy(job, t0, JR), other = await act.journalBusy({ ...job, tgId: 5002, key: "5002-777" }, t0, JR);
  writeFileSync(join(JR, "s1.jsonl"), [...lines, result("t2", t0 + 4000), use("t3", "Task", { prompt: "собери таблицу" }, t0 + 5000)].join("\n") + "\n");
  const sub = await act.journalBusy(job, t0, JR);
  check("журнал лабы: идёт нагрузочный тест — у своей работы, у чужой — ничего; подагент — «работает помощник агента»", mine === "идёт нагрузочный тест" && other === null && sub === "работает помощник агента", `${mine} | ${other} | ${sub}`);
}

// --- с agent-account.json (отдельный процесс: модуль читает файл при подключении) ---
{
  const home = join(root, "home"), work = join(home, "moodle-work");
  mkdirSync(join(work, "agent-shared"), { recursive: true });
  const cfg = join(root, "agent-account.json");
  writeFileSync(cfg, JSON.stringify({ user: "doodle-agent", home: "C:\\Users\\doodle-agent", restartTask: "Doodle Gateway Restart" }));
  const probe = `const a = await import(${JSON.stringify(url("agent-account.mjs"))}); console.log(JSON.stringify({ agent: a.AGENT, tr: a.AGENT_TRANSCRIPTS, st: a.AGENT_SETTINGS, lock: a.measureLock(), inst: a.sharedFile(".install.lock"), docker: a.dockerRule() }));`;
  const runProbe = (file) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", env: { ...process.env, AGENT_ACCOUNT_FILE: file, USERPROFILE: home, HOME: home } }).stdout.trim().split("\n").pop());
  const r = runProbe(cfg);
  check("agent-account.json: журналы и настройки агента — в его профиле", r.agent?.user === "doodle-agent" && r.tr === "C:\\Users\\doodle-agent\\.claude\\projects\\C--Users-doodle-agent--openclaw-workspace-files"
    && r.st === "C:\\Users\\doodle-agent\\.claude\\settings.json", r.tr);
  check("есть agent-shared — замки в ней; Docker агент сам не запускает", r.lock === join(work, "agent-shared", ".measure.lock") && r.inst === join(work, "agent-shared", ".install.lock") && /запускается сам при входе/.test(r.docker) && /не запускай/.test(r.docker), r.lock);
  writeFileSync(cfg, "{ испорчен");
  check("испорченный agent-account.json — как будто его нет (агент под той же учётной записью)", runProbe(cfg).agent === null);
}

// --- wsl_lab.py: список WSL-пользователей рядом с moodle-work этого файла, а не в домашней папке ---
{
  const mw = join(root, "mw"), assets = join(mw, "jarvis-app", "assets");
  mkdirSync(assets, { recursive: true });
  for (const f of ["wsl_lab.py", "vt.py"]) cpSync(join(APP, "assets", f), join(assets, f));
  const py = (env = {}) => spawnSync("python", ["-I", "-B", "-c", `import sys; sys.path.insert(0, r"${assets}"); import wsl_lab; print(wsl_lab.MAP_FILE)`], { encoding: "utf8", env: { ...process.env, ...env } }).stdout.trim();
  const before = py();
  mkdirSync(join(mw, "agent-shared"));
  const after = py(), forced = py({ WSL_USERS_FILE: join(root, "x.json") });
  check("wsl_lab.py: wsl-users.json — в moodle-work над скриптом, при agent-shared — в ней, переменная важнее", before === join(mw, "wsl-users.json") && after === join(mw, "agent-shared", "wsl-users.json") && forced === join(root, "x.json"), `${before} | ${after}`);
}

rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
