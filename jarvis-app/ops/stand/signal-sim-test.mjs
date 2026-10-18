// Симуляция сигнала по курсу и проверки материалов группы (news.mjs, 18 окт 2026) с подменённым временем: 25 человек в
// курсе, сигнал раз в 30 с, «шум» (форум курса меняется), новый материал в случайный момент. Проверяется главное: новый
// материал получают ВСЕ студенты курса (на стенде load-test 18 окт часть группы его теряла). Несколько прогонов с разным
// порядком и шагом. Поддельный Moodle и Bot API на 127.0.0.1 — настоящие сервисы и данные не затрагиваются.
// Запуск: node ops\stand\signal-sim-test.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(import.meta.dirname, "..", ".."), PORT = 9967, FAKE = `http://127.0.0.1:${PORT}`;
const root = join(tmpdir(), `signal-sim-test-${process.pid}`), SIM = join(root, "app");
rmSync(root, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) writeFileSync(join(SIM, f), readFileSync(join(APP, f), "utf8").split("https://newlms.misis.ru").join(FAKE).split("https://api.telegram.org").join(`${FAKE}/tg`));
writeFileSync(join(SIM, "bot-token.txt"), "1:TEST");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
Object.assign(process.env, { MOODLE_PACE: "0", MOODLE_PACE_DIR: join(root, "usage"), BOT_STATS_DIR: join(root, "usage"), BOT_UPDATES: "1", USERPROFILE: join(root, "home"), HOME: join(root, "home"),
  // Расписания и учебные планы misis.ru — тоже на поддельный адрес: импорт модулей не должен ходить на настоящий сайт.
  MISIS_SCHEDULE_INDEX: FAKE + "/schedule/", MISIS_EDUOP_URL: FAKE + "/eduop/", MISIS_SESSION_URL: FAKE + "/session/" });

// Подменённое время: всё в news.mjs и notify.mjs берёт Date.now.
const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;
const nowS = () => Math.floor(clock / 1000);

const C = 21, FORUM = 2160;
let mods = []; // { id, name, modname, at }
const sent = new Map(); // chat_id → [тексты]
function ws(fn, p) {
  if (fn === "tool_mobile_call_external_functions") {
    const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre ? `${pre}[${k}]` : k; if (v && typeof v === "object") flat(v, key, out); else out[key] = v; } return out; };
    const responses = [];
    for (let i = 0; p[`requests[${i}][function]`]; i++) responses.push({ error: false, data: JSON.stringify(ws(p[`requests[${i}][function]`], flat(JSON.parse(p[`requests[${i}][arguments]`] || "{}")))) });
    return { responses };
  }
  if (fn === "core_course_get_updates_since") return { instances: mods.filter((m) => m.at >= Number(p.since)).map((m) => ({ contextlevel: "module", id: m.id, updates: [{ name: "configuration" }] })) };
  if (fn === "core_course_get_contents") return [{ name: "Раздел", modules: mods.map((m) => ({ id: m.id, name: m.name, modname: m.modname, visible: 1, uservisible: true, url: `${FAKE}/m${m.id}` })) }];
  return { exception: "x", errorcode: "unknownfn", message: fn };
}
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/tg/")) { try { const j = JSON.parse(body); const a = sent.get(j.chat_id) || []; a.push(j.text); sent.set(j.chat_id, a); } catch { /* */ } return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } })); }
    res.end(JSON.stringify(ws(new URLSearchParams(body).get("wsfunction"), Object.fromEntries(new URLSearchParams(body)))));
  });
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
// SIM_TRACE=<tgId> — по шагам: общий ответ, свой запрос, решения сигнала (для разбора, в копии news.mjs).
if (process.env.SIM_TRACE) {
  const f = join(SIM, "news.mjs"), T = Number(process.env.SIM_TRACE);
  let s = readFileSync(f, "utf8");
  s = s.replace("  const nowS = Math.floor(Date.now() / 1000);\n  const got = new Map();", `  if (tgId === ${T}) console.log("ENTER at", snap.at, "known", JSON.stringify(snap.courses), "need", needsCheck(tgId, courses.map((c) => c.id)), "now", Date.now());\n  const nowS = Math.floor(Date.now() / 1000);\n  const got = new Map();`);
  s = s.replace("{ got.set(c.id, { same: true, at: p.to }); continue; }", `{ if (tgId === ${T}) console.log("REUSE s", s, "p", JSON.stringify(p), "known", known.at, "now", nowS); got.set(c.id, { same: true, at: p.to }); continue; }`);
  s = s.replace("if (!inst.length) { extend(probes, c.id, since.get(c.id), nowS);", `if (tgId === ${T}) console.log("OWN since", since.get(c.id), "inst", inst.map((x) => x.id).join(), "now", nowS); if (!inst.length) { extend(probes, c.id, since.get(c.id), nowS);`);
  s = s.replace("if (!forMaterials) { extend(probes, id, since.get(id), nowS); return; }", `console.log("SIG forMat", forMaterials, "since", since.get(id), "now", nowS, inst.map((x) => x.id).join()); if (!forMaterials) { extend(probes, id, since.get(id), nowS); return; }`);
  writeFileSync(f, s);
}
const news = await import(pathToFileURL(join(SIM, "news.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
// Детерминированный «случай» для повторяемости.
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const courses = [{ id: C, short: "К21", name: "Курс 21" }];

/**
 * Прогон: N человек (id base+1…), шаг времени step с; за шаг материалы проверяет не больше perStep человек (как очередь
 * под нагрузкой), сначала needsCheck — как server.mjs materialsTick. Сигнал — раз в 30 с. Шум — форум раз в noise с.
 * Материал добавляется в момент addAt (с от начала). Возвращает, сколько человек получили сообщение о нём.
 */
async function run({ base, N = 25, step = 5, perStep = 4, noise = 120, addAt = 600, total = 1500 }) {
  const t0 = nowS();
  mods = [{ id: 2150, name: "Методичка", modname: "resource", at: t0 - 3600 }, { id: FORUM, name: "Форум курса", modname: "forum", at: t0 - 3600 }];
  const users = Array.from({ length: N }, (_, i) => base + i + 1);
  let cursor = 0, lastSignal = -1e9, lastNoise = 0, added = false;
  const matId = base + 9000;
  for (let t = 0; t <= total; t += step) {
    clock += step * 1000;
    if (t - lastNoise >= noise) { lastNoise = t; mods.find((m) => m.id === FORUM).at = nowS(); }
    if (!added && t >= addAt) { added = true; mods.push({ id: matId, name: `Лекция ${matId}`, modname: "resource", at: nowS() }); }
    if (t - lastSignal >= 30) { lastSignal = t; await news.probeSignal("tok", [C]); }
    // Материалы: perStep человек за шаг, первыми — кому надо (needsCheck), остальные по кругу.
    const urgent = users.filter((u) => news.needsCheck(u, [C]));
    if (process.env.SIM_TRACE && t % 60 === 0) console.log("URGENT", t, urgent.join(","));
    const pick = [...urgent];
    while (pick.length < perStep) { const u = users[cursor++ % N]; if (!pick.includes(u)) pick.push(u); else if (pick.length >= N) break; }
    for (const u of pick.slice(0, perStep)) await news.checkMaterials(u, "tok", courses);
  }
  const miss = users.filter((u) => !(sent.get(u) || []).some((x) => x.includes(`Лекция ${matId}`)));
  if (miss.length) console.log(`  материал добавлен в ${t0 + addAt}…; не получили: ${miss.join(", ")}`);
  return N - miss.length;
}

const cases = [
  { step: 5, perStep: 4, noise: 120, addAt: 600 },
  { step: 5, perStep: 2, noise: 60, addAt: 613 },
  { step: 7, perStep: 3, noise: 45, addAt: 401 },
  { step: 3, perStep: 1, noise: 90, addAt: 777 },
  { step: 10, perStep: 6, noise: 35, addAt: 505 },
];
for (let k = 0; k < cases.length; k++) {
  seed = k + 1;
  const c = { ...cases[k], addAt: cases[k].addAt + Math.floor(rnd() * 30) };
  const got = await run({ base: 1000 * (k + 1), ...c });
  check(`прогон ${k + 1} (шаг ${c.step} с, ${c.perStep} чел. за шаг, шум раз в ${c.noise} с): новый материал получили все 25`, got === 25, `получили ${got}`);
}

fake.closeAllConnections();
await new Promise((r) => fake.close(r));
rmSync(root, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
