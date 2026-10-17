// Проверка решений cal-tunnel.mjs (plan): один агент ngrok на адрес, зомби останавливаются, терпение и пауза.
// Без ngrok и сети — только чистая функция. Запуск: node cal-tunnel-test.mjs
import { pathToFileURL } from "node:url";

process.env.MOODLE_DIRECT ??= "0";
const { plan, GRACE_MS, PATIENCE } = await import(pathToFileURL("C:/Users/User/moodle-work/jarvis-app/cal-tunnel.mjs").href);
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

const BASE = "https://example.ngrok-free.dev";
const now = Date.parse("2026-10-15T01:00:00Z");
const mem = (o = {}) => ({ lastSpawn: 0, down: 0, pauseUntil: 0, ...o });
const online = (port, url = BASE) => ({ port, status: "online", urls: [url] });
const zombie = (port, url = BASE) => ({ port, status: "reconnecting", urls: [url] });
const connecting = (port) => ({ port, status: "reconnecting", urls: [] });

// Сегодняшняя картина: живой агент на 4043, два зомби на 4041–4042 — живого оставить, зомби остановить.
let r = plan(BASE, [zombie(4041), zombie(4042), online(4043)], mem(), now);
check("живой агент на 4043 найден, зомби останавливаются", r.ok && r.port === 4043 && r.stopOthers === true && r.down === 0, JSON.stringify(r));

r = plan(BASE, [online(4040)], mem(), now);
check("один живой агент на 4040 — ничего не трогаем", r.ok && r.port === 4040 && !r.stopOthers && !r.spawn);

r = plan(BASE, [zombie(4040), online(4041)], mem({ lastSpawn: now - 30e3 }), now);
check("сразу после своего запуска лишних не трогаем (90 с)", r.ok && r.port === 4041 && r.stopOthers === false);

r = plan(BASE, [], mem(), now);
check("агентов нет — запускаем, останавливать некого", !r.ok && r.spawn === true && r.stopAll === false && r.down === 0);

r = plan(BASE, [], mem({ lastSpawn: now - 10e3 }), now);
check("только что запустили — ждём, второго не запускаем", !r.ok && r.wait === true && !r.spawn && r.reason === "запускается");

r = plan(BASE, [zombie(4040)], mem({ down: 0 }), now);
check("агент переподключается — ждём и считаем проверки", !r.ok && r.wait === true && r.down === 1 && /reconnecting/.test(r.reason));

let m = mem({ down: 0 });
for (let i = 0; i < PATIENCE; i++) { r = plan(BASE, [zombie(4040)], m, now); m.down = r.down; }
check(`после ${PATIENCE} проверок без online — остановить всех и запустить заново`, r.spawn === true && r.stopAll === true && r.down === 0, JSON.stringify(r));

r = plan(BASE, [connecting(4040)], mem(), now);
check("агент без туннелей (ещё подключается) считается своим — ждём", !r.ok && r.wait === true && r.down === 1);

r = plan(BASE, [online(4040, "https://other.ngrok-free.dev")], mem(), now);
check("чужой агент с другим адресом не считается — запускаем свой, чужого не трогаем", !r.ok && r.spawn === true && r.stopAll === false);

r = plan(BASE, [], mem({ pauseUntil: now + 60e3 }), now);
check("в паузе после неудач — ждём", !r.ok && r.wait === true && /пауза/.test(r.reason));

r = plan(BASE, [zombie(4040), zombie(4041)], mem({ lastSpawn: now - GRACE_MS }), now);
check("ровно по истечении 90 с ожидание кончается", r.wait === true && r.down === 1);

console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
