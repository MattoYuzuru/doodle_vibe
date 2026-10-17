// Проверка выключателя лаб (labs.off / LABS_OFF=1, server.mjs): настоящий server.mjs на копии кода без данных.
// Во временную папку идут только код и шаблоны верхнего уровня (*.mjs, *.py, *.md) — ни токена бота, ни users/,
// ни состояния; запросы — как владелец с этого же компьютера (LOCAL_OWNER=1), агент не запускается ни разу.
// Домашняя папка и APPDATA сервера — тоже временная папка: токен Moodle владельца лежит в ~/.openclaw, а папки лаб —
// в ~/moodle-work (первая версия теста их нашла: прочитала профиль владельца и создала заготовку лабы).
// Запуск: node ops/stand/labs-off-test.mjs   (на Windows и на Linux)
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, symlink, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = await mkdtemp(join(tmpdir(), "labs-off-"));
const PORT = 18700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  | ${extra}` : ""}`); };
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, error: j.error, json: j };
};

let srv = null;
try {
  for (const f of await readdir(APP)) if (/\.(mjs|py|md)$/.test(f)) await copyFile(join(APP, f), join(dir, f));
  await symlink(join(APP, "node_modules"), join(dir, "node_modules"), "junction");
  srv = spawn(process.execPath, ["server.mjs"], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LOCAL_OWNER: "1", BOT_UPDATES: "0", LABS_OFF: "",
      CAL_TUNNEL: "0", GUARD_WATCH: "0", MOODLE_DIRECT: "0", APP_URL: "", MOODLE_PACE_DIR: dir,
      HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir },
  });
  let log = "";
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 40; i++) { if ((await api("GET", "/api/health").catch(() => ({}))).status === 200) break; await sleep(250); }
  check("сервер на копии кода запустился", (await api("GET", "/api/health")).status === 200, log.slice(-300));
  const probe = await api("GET", "/api/me");
  if (probe.json?.moodle) throw new Error("у тестового сервера нашёлся вход в Moodle — данные не изолированы, дальше не иду");

  // Лабы включены: флага нет, отказа labs_off нет (ход агента до него не доходит — нет входа в Moodle).
  const me1 = await api("GET", "/api/me");
  check("без labs.off профиль без labsOff", me1.status === 200 && !me1.json.labsOff, JSON.stringify(me1.json).slice(0, 120));
  const s1 = await api("POST", "/api/lab/123/start", { title: "t" });
  check("без labs.off «Сделать отчёт» не получает labs_off", s1.error !== "labs_off", `${s1.status} ${s1.error}`);

  // Включаем файлом на ходу — без перезапуска.
  await writeFile(join(dir, "labs.off"), "");
  const me2 = await api("GET", "/api/me");
  check("с labs.off профиль: labsOff = true", me2.json.labsOff === true);
  for (const a of ["start", "fix", "message", "explain"]) {
    const r = await api("POST", `/api/lab/123/${a}`, { text: "x", title: "t" });
    check(`с labs.off /lab/…/${a} → 403 labs_off`, r.status === 403 && r.error === "labs_off", `${r.status} ${r.error}`);
  }
  const c = await api("POST", "/api/check/123");
  check("с labs.off проверка отчёта → 403 labs_off", c.status === 403 && c.error === "labs_off", `${c.status} ${c.error}`);
  const e = await api("POST", "/api/env-requests", { tgId: 1, id: "1", approve: [] });
  check("с labs.off одобрение установки окружения → 403 labs_off", e.status === 403 && e.error === "labs_off", `${e.status} ${e.error}`);
  for (const a of ["approve", "dismiss"]) {
    const r = await api("POST", `/api/lab/123/${a}`, {});
    check(`с labs.off /lab/…/${a} (без агента) не получает labs_off`, r.error !== "labs_off", `${r.status} ${r.error}`);
  }
  const g = await api("GET", "/api/lab/123");
  check("с labs.off лабу можно открыть (GET)", g.status === 200, `${g.status} ${g.error}`);
  const envList = await api("GET", "/api/env-requests");
  check("с labs.off список запросов окружения читается", envList.status === 200, `${envList.status} ${envList.error}`);

  await unlink(join(dir, "labs.off"));
  const me3 = await api("GET", "/api/me");
  check("файл убран — снова без labsOff", me3.status === 200 && !me3.json.labsOff);
} catch (e) {
  fails++;
  console.log(`FAIL  ${e.message}`);
} finally {
  srv?.kill();
  await sleep(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
  process.exit(fails ? 1 : 0);
}
