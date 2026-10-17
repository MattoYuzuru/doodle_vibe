// Проверка state-file.mjs: «файла нет» — только ENOENT; занятый файл (держим его открытым без общего доступа, как
// антивирус) читается повторно, а если не отпустили — StateReadError, и файл не трогается; испорченный JSON уходит в
// .bad-*; запись атомарна и переживает короткую блокировку. Только временная папка. Запуск: node ops\stand\state-file-test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sf = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "state-file.mjs")).href);
const dir = join(tmpdir(), `state-file-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

// Держать файл открытым без общего доступа ms миллисекунд; промис — когда файл уже занят, done — когда отпущен.
function lock(path, ms) {
  const ps = spawn("powershell", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${path}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds ${ms}; $f.Close(); 'free'`], { windowsHide: true });
  let out = "";
  const done = new Promise((r) => ps.on("close", r));
  return new Promise((resolve) => ps.stdout.on("data", (d) => { out += d; if (out.includes("locked")) resolve({ done }); }));
}

const p = join(dir, "u.json");
check("нет файла → значение «нет файла»", (await sf.readJson(p, { missing: "нет" })) === "нет");
writeFileSync(p, JSON.stringify({ token: "секрет" }));
check("обычное чтение", (await sf.readJson(p))?.token === "секрет");

let l = await lock(p, 350);
let t = Date.now(), r = await sf.readJson(p).catch((e) => e);
check("файл занят ~0,35 с → прочитан со второй-третьей попытки", r?.token === "секрет", `${Date.now() - t} мс, ${r?.name || ""} ${r?.cause?.code || ""}`);
await l.done;

l = await lock(p, 4000);
r = await sf.readJson(p, { missing: "нет" }).catch((e) => e);
check("файл занят дольше повторов → StateReadError (а не «нет файла»), код 424", r?.name === "StateReadError" && r.status === 424 && /^(EBUSY|EPERM|EACCES)$/.test(r.cause?.code || ""), `${r?.name} ${r?.cause?.code}`);
await l.done;
check("после блокировки файл цел", JSON.parse(readFileSync(p, "utf8")).token === "секрет");

writeFileSync(p, '{"token": "обры');
r = await sf.readJson(p, { missing: () => ({ fresh: true }) });
const bad = readdirSync(dir).filter((f) => f.startsWith("u.json.bad-"));
check("испорченный JSON → отложен в .bad-*, дальше «нет файла»", r?.fresh === true && bad.length === 1 && readFileSync(join(dir, bad[0]), "utf8") === '{"token": "обры', bad.join());
t = Date.now();
for (let i = 0; i < 5; i++) await sf.readJson(p, { missing: () => ({ fresh: true }) });
check("тот же испорченный файл читается снова — новых копий нет, без ожидания перечитывания", readdirSync(dir).filter((f) => f.startsWith("u.json.bad-")).length === 1 && Date.now() - t < 200, `${Date.now() - t} мс`);
const s = join(dir, "shared.json");
writeFileSync(s, "{не json");
r = await sf.readJson(s, { missing: {}, corrupt: "throw" }).catch((e) => e);
check("общий файл, испорченный JSON → отложен и StateReadError", r?.name === "StateReadError" && readdirSync(dir).some((f) => f.startsWith("shared.json.bad-")));
writeFileSync(s, "﻿{\"a\":1}");
check("BOM в начале файла не мешает", (await sf.readJson(s))?.a === 1);

writeFileSync(p, JSON.stringify({ v: 1 }));
l = await lock(p, 150);
t = Date.now();
r = await sf.writeJsonAtomic(p, { v: 2 }, { space: 2 }).then(() => "ok", (e) => e);
await l.done;
check("запись поверх ненадолго занятого файла — с повтором rename", r === "ok" && JSON.parse(readFileSync(p, "utf8")).v === 2, `${r?.code || r}, ${Date.now() - t} мс`);
check("временных файлов не осталось", !readdirSync(dir).some((f) => f.endsWith(".tmp")), readdirSync(dir).join());
check("синхронное чтение: нет файла / есть", sf.readJsonSync(join(dir, "нет.json"), { missing: 0 }) === 0 && sf.readJsonSync(p).v === 2);

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
