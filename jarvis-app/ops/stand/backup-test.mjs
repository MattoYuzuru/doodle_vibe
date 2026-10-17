// Проверка ежедневной копии данных (backup.mjs) на временных папках — настоящие данные не трогаются.
// Запуск: node backup-test.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(tmpdir(), `backup-test-${process.pid}`), SRC = join(root, "app"), DST = join(root, "copies");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(SRC, "users"), { recursive: true }); mkdirSync(join(SRC, "jobs"), { recursive: true }); mkdirSync(join(SRC, "web"), { recursive: true });
writeFileSync(join(SRC, "users", "5001.json"), '{"enc":"…"}'); writeFileSync(join(SRC, "users", "5001.json.ab12.tmp"), "оборванная запись");
writeFileSync(join(SRC, "users.key"), "ключ"); writeFileSync(join(SRC, "jobs", "5001-777.json"), "{}");
writeFileSync(join(SRC, "bot-token.txt"), "секрет бота"); writeFileSync(join(SRC, "server.mjs"), "код"); writeFileSync(join(SRC, "web", "index.html"), "<html>");
// Папки лаб — в отдельной временной «moodle-work»; до проверки лаб в ней ничего нет.
const WORK = join(root, "moodle-work");
mkdirSync(WORK, { recursive: true });
process.env.BACKUP_SRC = SRC; process.env.BACKUP_DIR = DST; process.env.BACKUP_KEEP = "3"; process.env.BACKUP_LABS_SRC = WORK; process.env.BACKUP_MAX_FILE = "1000";
const b = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "backup.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const DAY = 86400e3, t0 = Date.parse("2026-10-04T10:00:00+03:00");

const r1 = await b.backupNow({ now: t0 });
const d1 = join(DST, "2026-10-04");
check("копия за день: данные пользователей, ключ и задания скопированы; код, токен бота и временные файлы — нет", r1.day === "2026-10-04" && !r1.skipped && r1.files === 3 && existsSync(join(d1, "users", "5001.json")) && readFileSync(join(d1, "users.key"), "utf8") === "ключ" && existsSync(join(d1, "jobs", "5001-777.json"))
  && !existsSync(join(d1, "bot-token.txt")) && !existsSync(join(d1, "server.mjs")) && !existsSync(join(d1, "web")) && !existsSync(join(d1, "users", "5001.json.ab12.tmp")), JSON.stringify(r1));
writeFileSync(join(SRC, "users", "5002.json"), "{}");
const r2 = await b.backupNow({ now: t0 + 3600e3 });
check("вторая попытка в тот же день копию не переписывает; по требованию — переписывает", r2.skipped === true && r2.files === 3 && !existsSync(join(d1, "users", "5002.json")) && (await b.backupNow({ now: t0, force: true })).files === 4 && existsSync(join(d1, "users", "5002.json")));
for (let i = 1; i <= 4; i++) await b.backupNow({ now: t0 + i * DAY });
mkdirSync(join(DST, "мои заметки"), { recursive: true });
await b.backupNow({ now: t0 + 5 * DAY });
const left = readdirSync(DST).sort();
check("хранятся последние копии (здесь три), старые удаляются, постороннее в папке копий не трогается, недоделанных копий не остаётся", left.join() === "2026-10-07,2026-10-08,2026-10-09,мои заметки", left.join());

// Папки лаб: <id>, check-<id>, users\…, agent-shared и wsl-users.json — да; программы, приложение, личное, node_modules,
// *.tmp и слишком большие файлы — нет. Назавтра неизменённое — жёсткой ссылкой на вчерашнюю копию, изменённое — копией.
{
  const put = (rel, text) => { const p = join(WORK, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); return p; };
  put("29397/work/out/run.txt", "вывод"); const notes = put("users/5001/777/NOTES.md", "заметки"); put("check-12/check-result.json", "{}");
  put("agent-shared/wsl-users.json", "{}"); put("wsl-users.json", "{}"); put("29397/node_modules/pkg/index.js", "x"); put("29397/tmp/a.tmp", "x");
  put("29397/work/big.bin", "x".repeat(2000)); put("tools/octave/octave.exe", "x"); put("ops/watchdog.mjs", "x"); put("HANDOFF.md", "x"); put("jarvis-app/users.key", "x");
  const r = await b.backupNow({ now: t0 + 6 * DAY }), d = join(DST, "2026-10-10", "labs");
  const has = (rel) => existsSync(join(d, rel));
  check("копия папок лаб: работы, проверки, папки студентов и общая папка агента — да; tools, ops, личное, node_modules, *.tmp и большие файлы — нет",
    has("29397/work/out/run.txt") && has("users/5001/777/NOTES.md") && has("check-12/check-result.json") && has("agent-shared/wsl-users.json") && has("wsl-users.json")
    && !has("29397/node_modules") && !has("29397/tmp/a.tmp") && !has("29397/work/big.bin") && !has("tools") && !has("ops") && !has("HANDOFF.md") && !has("jarvis-app")
    && r.labs.files === 5 && r.labs.linked === 0 && r.labs.skipped === 1, JSON.stringify(r.labs));
  writeFileSync(notes, "заметки, день второй"); utimesSync(notes, new Date(), new Date(Date.now() + 5000));
  const r2 = await b.backupNow({ now: t0 + 7 * DAY }), d2 = join(DST, "2026-10-11", "labs");
  const same = (rel) => statSync(join(d, rel)).ino === statSync(join(d2, rel)).ino;
  check("назавтра неизменённые файлы — ссылкой на вчерашнюю копию, изменённый — новой копией", r2.labs.files === 5 && r2.labs.linked === 4 && same("29397/work/out/run.txt") && !same("users/5001/777/NOTES.md")
    && readFileSync(join(d2, "users/5001/777/NOTES.md"), "utf8") === "заметки, день второй" && readFileSync(join(d, "users/5001/777/NOTES.md"), "utf8") === "заметки", JSON.stringify(r2.labs));
}
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
