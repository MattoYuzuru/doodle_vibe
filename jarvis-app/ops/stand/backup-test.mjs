// Проверка ежедневной копии данных (backup.mjs) на временных папках — настоящие данные не трогаются.
// Запуск: node backup-test.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(tmpdir(), `backup-test-${process.pid}`), SRC = join(root, "app"), DST = join(root, "copies");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(SRC, "users"), { recursive: true }); mkdirSync(join(SRC, "jobs"), { recursive: true }); mkdirSync(join(SRC, "web"), { recursive: true });
writeFileSync(join(SRC, "users", "5001.json"), '{"enc":"…"}'); writeFileSync(join(SRC, "users", "5001.json.ab12.tmp"), "оборванная запись");
writeFileSync(join(SRC, "users.key"), "ключ"); writeFileSync(join(SRC, "jobs", "5001-777.json"), "{}");
writeFileSync(join(SRC, "bot-token.txt"), "секрет бота"); writeFileSync(join(SRC, "server.mjs"), "код"); writeFileSync(join(SRC, "web", "index.html"), "<html>");
process.env.BACKUP_SRC = SRC; process.env.BACKUP_DIR = DST; process.env.BACKUP_KEEP = "3";
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
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
