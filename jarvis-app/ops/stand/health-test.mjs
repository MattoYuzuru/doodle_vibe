// Проверка счётчика «узел МИСИС не отвечает» (users.mjs netHealth) без Moodle: поддельный сервер на этом ПК.
// Запуск: MOODLE_DIRECT=0 MOODLE_DOWN_STREAK=3 MOODLE_DOWN_AFTER_MS=300 node health-test.mjs
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Счётчики и паузы ограничителя — во временную папку (15 окт 2026): без этого тест писал в usage\moodle-load.json
// живого сервера. Переменные из строки запуска выше — значениями по умолчанию, чтобы тест можно было запустить и без них.
process.env.MOODLE_PACE_DIR ??= mkdtempSync(join(tmpdir(), "health-test-"));
process.env.MOODLE_DIRECT ??= "0";
process.env.MOODLE_DOWN_STREAK ??= "3";
process.env.MOODLE_DOWN_AFTER_MS ??= "300";
process.env.MOODLE_PACE ??= "0"; // без пауз очереди: с паузой 150 мс между запросами три сбоя растягивались дольше порога 300 мс

const users = await import(pathToFileURL("C:/Users/User/moodle-work/jarvis-app/users.mjs").href);
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = "ok";
const srv = createServer((req, res) => {
  if (mode === "drop") return req.socket.destroy();
  if (mode === "503") { res.writeHead(503); return res.end("maintenance"); }
  res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/x`;
const hit = () => users.mfetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, (e) => e.message);
const H = () => users.netHealth("127.0.0.1");

check("до первых запросов узел не считается упавшим", H().down === false && H().okAt === null);
check("ответ 200 — узел работает", (await hit()) === 200 && H().down === false && H().okAt > 0);
mode = "drop";
const r1 = [await hit(), await hit()];
check("два сбоя подряд — ещё не «не работает» (отдельные сбои у МИСИС — норма)", r1.every((x) => x === "fetch failed") && H().down === false, JSON.stringify(r1));
await hit();
check("три сбоя, но серия короче порога по времени — ещё нет", H().down === false);
await sleep(350);
await hit();
const h = H();
check("серия сбоев дольше порога — узел не работает, известно, с какого времени", h.down === true && h.since > 0 && Date.now() - h.since >= 300 && h.okAt > 0 && h.okAt <= h.since, JSON.stringify(h));
mode = "ok";
check("первый же ответ — узел снова работает", (await hit()) === 200 && H().down === false && H().since === null);
mode = "503";
for (let i = 0; i < 3; i++) await hit();
await sleep(350);
check("ответы 5xx (техработы) считаются сбоем так же", (await hit()) === 503 && H().down === true);
mode = "ok";
await hit();
check("другой узел независим", users.netHealth("ej.example.test").down === false && H().down === false);
srv.close();
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
