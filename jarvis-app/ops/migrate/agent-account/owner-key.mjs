// Шаг после 2-агент.cmd — под учётной записью ВЛАДЕЛЬЦА ПК (обычный запуск, без администратора). Запускается из 3-ключ.cmd.
//
// Сервер приложения (под владельцем) отдаёт задания агенту командой `openclaw agent` через Gateway, который теперь
// работает под doodle-agent. Для этого в настройках OpenClaw владельца нужен тот же ключ Gateway. 2-агент.cmd оставил
// его в moodle-work\agent-shared\gateway-key.handoff (читать могут только doodle-agent, владелец и система). Скрипт
// записывает ключ в настройки OpenClaw владельца, проверяет связь с Gateway агента и удаляет этот файл. Ключ не печатается.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OC = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const say = (s = "") => console.log(s);
const stop = (s) => { console.log(`\nОСТАНОВЛЕНО: ${s}`); process.exit(1); };
const run = (exe, args) => { const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 120e3 }); return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" }; };
const oc = (args) => run(process.execPath, [OC, ...args]);
const hide = (s, t) => String(s).split(t).join("<ключ>");

say("=== Связь сервера приложения с Gateway агента ===");
const setupFile = join(HERE, "export", "setup.json");
if (!existsSync(setupFile)) stop("нет export\\setup.json — сначала 1-права.ps1 (от администратора) и 2-агент.cmd (под учётной записью агента).");
const setup = JSON.parse(readFileSync(setupFile, "utf8").replace(/^﻿/, ""));
const me = userInfo().username;
if (me.toLowerCase() === String(setup.agent).toLowerCase()) stop(`это запускают под вашей учётной записью (${setup.owner}), а не под ${setup.agent}.`);
if (!existsSync(OC)) stop(`под учётной записью ${me} не найден OpenClaw (${OC}).`);
const handoff = join(setup.work, "agent-shared", "gateway-key.handoff");
if (!existsSync(handoff)) stop(`нет ${handoff}: сначала под ${setup.agent} запустите 2-агент.cmd.`);
const token = readFileSync(handoff, "utf8").trim();
if (!/^[0-9a-f]{48}$/.test(token)) stop(`в ${handoff} не ключ Gateway — запустите 2-агент.cmd под ${setup.agent} ещё раз.`);

// Кто сейчас слушает порт 18789: если это ваш прежний Gateway (до перезагрузки), проверка связи пошла бы не туда.
const pid = run("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"]).out.trim();
if (/^\d+$/.test(pid)) {
  const row = run("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/v", "/nh"]).out;
  if (new RegExp(`\\\\${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i").test(row)) stop("порт 18789 занимает ваш прежний Gateway (под вашей учётной записью). Перезагрузите ПК — после входа doodle-agent Gateway запустится под ним, — и запустите 3-ключ.cmd снова.");
}

for (const [path, value] of [["gateway.mode", "\"local\""], ["gateway.port", "18789"], ["gateway.auth.mode", "\"token\""], ["gateway.auth.token", JSON.stringify(token)]]) {
  const r = oc(["config", "set", path, value, "--strict-json"]);
  if (r.code !== 0) stop(`openclaw config set ${path} — код ${r.code}: ${hide(r.err || r.out, token).slice(-300)}`);
}
say("  ключ Gateway агента записан в ваши настройки OpenClaw");

const h = oc(["gateway", "health"]);
if (h.code !== 0) {
  say(`  Gateway агента не ответил (код ${h.code}): ${hide(h.err || h.out, token).trim().slice(-300)}`);
  stop(`проверьте, что ${setup.agent} вошёл в Windows и Gateway запущен (под ним: openclaw gateway status), затем запустите 3-ключ.cmd снова. Файл с ключом оставлен.`);
}
say("  Gateway агента отвечает");
rmSync(handoff, { force: true });
say(`  файл передачи ключа удалён: ${handoff}`);
say("\nГотово. После перезагрузки ПК сервер приложения будет работать с агентом под учётной записью " + setup.agent + ".");
say("Проверку (whoami агента, «Отказано в доступе» к папке приложения, проверочная лаба) делает Claude — см. УЧЁТКА-АГЕНТА.md.");
