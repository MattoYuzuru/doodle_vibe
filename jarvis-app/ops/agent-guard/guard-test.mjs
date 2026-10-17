// Проверка сторожа агента (guard.mjs) на придуманных действиях: что закрыто и что обычной работе лабы не мешает.
// Запуск: node guard-test.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.GUARD_HOME = "C:\\Users\\User";
process.env.GUARD_APP = "C:\\Users\\User\\moodle-work\\jarvis-app";
const g = await import(pathToFileURL(join(HERE, "guard.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const WS = "C:\\Users\\User\\.openclaw\\workspace-files", LAB = "C:\\Users\\User\\moodle-work\\users\\5001\\777";
const act = (tool_name, tool_input, cwd = WS) => g.decide({ tool_name, tool_input, cwd });
const denied = (r) => typeof r.deny === "string";
const sh = (command, tool = "PowerShell") => denied(act(tool, { command }));
const all = (list, f) => list.filter((x) => !f(x));

// --- обычная работа лабы: не должна задеваться ---
const okCommands = [
  `python C:\\Users\\User\\moodle-work\\jarvis-app\\assets\\render_ps.py ${LAB}\\work\\out\\p1.txt ${LAB}\\work\\report\\p1.png ${LAB}`,
  `python "C:\\Users\\User\\moodle-work\\jarvis-app\\assets\\wsl_lab.py" setup --id 5001 --name "Иванов"`,
  `python C:/Users/User/moodle-work/jarvis-app/assets/lt_shot.py схема.asc --out ${LAB}\\work\\out --traces "V(out);V(in)"`,
  `cd ${LAB}; docker compose -p lab-5001-777 up -d; docker ps`,
  `Get-Content C:\\Users\\User\\moodle-work\\tools\\README.md`,
  `pip install --user tabulate; python -c "import tabulate"`,
  `cd ..; ls; git status`,
  `curl.exe -s http://localhost:8080/api/users | Tee-Object -FilePath work\\out\\users.txt`,
  `New-Item ${LAB}\\work\\bot-token.txt -Value "123:test"`, // лаба про своего бота: свой файл в своей папке
  `type C:\\Users\\User\\.openclaw\\workspace-files\\AGENTS.md`,
  `Get-Content C:\\Users\\User\\.claude\\projects\\c--users-user--openclaw-workspace-files\\1f2e3d4c\\tool-results\\out1.txt`,
  `python -c "print('jarvis')"; echo .openclawish`,
];
const blockedOk = all(okCommands, (c) => !sh(c));
check("обычные команды лабы сторож пропускает (скрипты из assets, docker, pip, своя папка, tools)", blockedOk.length === 0, blockedOk.join(" || "));
const okPaths = [
  ["Read", { file_path: `${LAB}\\ЗАДАНИЕ.md` }], ["Write", { file_path: `${LAB}\\work\\report\\build.py`, content: "x" }], ["Edit", { file_path: `${LAB}\\NOTES.md` }],
  ["Read", { file_path: "C:\\Users\\User\\moodle-work\\jarvis-app\\assets\\powershell-titlebar.png" }], ["Read", { file_path: "C:\\Users\\User\\moodle-work\\tools\\README.md" }],
  ["Write", { file_path: "C:\\Users\\User\\moodle-work\\tools\\README.md" }], ["Read", { file_path: `${WS}\\AGENTS.md` }], ["Read", { file_path: "work\\out\\p1.txt" }, LAB],
  ["Glob", { pattern: "**/*.pdf", path: LAB }], ["Grep", { pattern: "users\\.key", path: LAB }], ["Glob", { pattern: `${LAB.replace(/\\/g, "/")}/work/**/*.png` }],
  ["Read", { file_path: "C:\\Users\\User\\.claude\\projects\\C--Users-User--openclaw-workspace-files\\abc\\tool-results\\big.txt" }],
  ["Write", { file_path: "C:\\Users\\User\\.claude\\projects\\C--Users-User--openclaw-workspace-files\\memory\\note.md" }],
];
const blockedPaths = all(okPaths, ([t, i, cwd]) => !denied(act(t, i, cwd)));
check("обычные чтение и запись файлов лабы сторож пропускает", blockedPaths.length === 0, JSON.stringify(blockedPaths));

// --- секреты: должны быть закрыты ---
const badCommands = [
  `type C:\\Users\\User\\moodle-work\\jarvis-app\\users.key`,
  `Get-Content "C:\\Users\\User\\moodle-work\\jarvis-app\\bot-token.txt"`,
  `cat /c/Users/User/moodle-work/jarvis-app/users/5002.json`,
  `Get-ChildItem C:\\Users\\User\\moodle-work\\jarvis-app -Recurse`,
  `ls C:/Users/User/moodle-work/jarvis-app/`,
  `Copy-Item C:\\Users\\User\\moodle-work\\jarvis-app\\assets\\..\\users.key ${LAB}\\x.txt`,
  `python C:\\Users\\User\\moodle-work\\jarvis-app\\server.mjs`,
  `type C:\\Users\\User\\.openclaw\\moodle-token.txt`,
  `cat ~/.openclaw/openclaw.json`,
  `Get-Content $env:USERPROFILE\\.openclaw\\credentials\\x.json`,
  `type ..\\moodle-token.txt`,
  `cat ../openclaw.json`,
  `Get-Content C:\\Users\\User\\.claude\\.credentials.json`,
  `cat ~/.claude/projects/c--users-user-moodle-work/abc.jsonl`,
  `Get-Content C:\\Users\\User\\.claude\\projects\\c--users-user--openclaw-workspace-files\\other-session.jsonl`,
  `type C:\\Users\\User\\.ssh\\id_ed25519`,
  `Copy-Item "C:\\Users\\User\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data" ${LAB}\\l.db`,
  `Set-Content C:\\Users\\User\\.openclaw\\workspace-files\\.claude\\settings.json '{}'`,
  `Remove-Item C:\\Users\\User\\moodle-work\\jarvis-app\\ops\\agent-guard\\guard.mjs`,
  `tar -cf ${LAB}\\a.tar C:\\Users\\User\\moodle-work\\jarvis-app\\users`,
];
const passedBad = all(badCommands, (c) => sh(c) && sh(c, "Bash"));
check("команды, читающие или меняющие секреты и защиту, сторож отклоняет (PowerShell и Bash)", passedBad.length === 0, passedBad.join(" || "));
const badPaths = [
  ["Read", { file_path: "C:\\Users\\User\\moodle-work\\jarvis-app\\users.key" }], ["Read", { file_path: "C:/Users/User/moodle-work/jarvis-app/users/5002.json" }],
  ["Read", { file_path: "/c/Users/User/moodle-work/jarvis-app/bot-token.txt" }], ["Read", { file_path: "C:\\Users\\User\\moodle-work\\jarvis-app\\server.mjs" }],
  ["Read", { file_path: "..\\..\\moodle-work\\jarvis-app\\users.key" }], ["Read", { file_path: "..\\moodle-token.txt" }], ["Read", { file_path: "~/.openclaw/openclaw.json" }],
  ["Read", { file_path: "C:\\Users\\User\\.claude\\.credentials.json" }], ["Read", { file_path: "C:\\Users\\User\\.claude\\projects\\C--Users-User--openclaw-workspace-files\\x.jsonl" }],
  ["Write", { file_path: "C:\\Users\\User\\moodle-work\\jarvis-app\\assets\\render_ps.py" }], ["Edit", { file_path: `${WS}\\.claude\\settings.json` }],
  ["Glob", { pattern: "C:/Users/User/moodle-work/jarvis-app/**/*.json" }], ["Glob", { pattern: "*.json", path: "C:\\Users\\User\\moodle-work\\jarvis-app\\users" }],
  ["Grep", { pattern: "token", path: "C:\\Users\\User\\.openclaw" }], ["Read", { file_path: "C:\\Users\\User\\.ssh\\id_rsa" }],
  ["Read", { file_path: `${LAB}\\..\\..\\..\\jarvis-app\\users.key` }],
];
const passedPaths = all(badPaths, ([t, i, cwd]) => denied(act(t, i, cwd)));
check("чтение секретов, правка готовых скриптов и настроек защиты через инструменты работы с файлами — отклоняется", passedPaths.length === 0, JSON.stringify(passedPaths));
check("настройки защиты агент может прочитать, но не изменить; чужой инструмент и пустой ввод не мешают", !denied(act("Read", { file_path: `${WS}\\.claude\\settings.json` })) && !denied(act("WebFetch", { url: "https://example.com/jarvis-app/x" })) && !denied(g.decide({})) && !denied(g.decide(null)));

// --- как настоящий перехватчик: ввод — JSON, ответ — JSON с отказом или пусто ---
const run = (input) => spawnSync(process.execPath, [join(HERE, "guard.mjs")], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { ...process.env } });
const r1 = run({ session_id: "testsession", cwd: WS, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "C:\\Users\\User\\moodle-work\\jarvis-app\\users.key" } });
const r2 = run({ session_id: "testsession", cwd: WS, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `${LAB}\\ЗАДАНИЕ.md` } });
const r3 = run("это не JSON");
let out1 = null; try { out1 = JSON.parse(r1.stdout); } catch { /* */ }
check("перехватчик: на секрет отвечает отказом в формате Claude Code, на обычный файл — молчит, на мусор во вводе — не падает и не запрещает", r1.status === 0 && out1?.hookSpecificOutput?.permissionDecision === "deny" && /Отказано защитой сервера/.test(out1.hookSpecificOutput.permissionDecisionReason) && r2.status === 0 && r2.stdout === "" && r3.status === 0 && r3.stdout === "", `${r1.status} ${r1.stdout.slice(0, 80)} | ${r2.status} «${r2.stdout}» | ${r3.status}`);
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
