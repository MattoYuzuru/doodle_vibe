// Постоянный адрес для подписки на календарь (calendar.mjs). Приложение открывается через быстрый туннель Cloudflare,
// адрес которого меняется при каждом запуске, — подписке в телефоне такой не годится. Здесь сервер держит второй туннель:
// ngrok на бесплатном постоянном домене из calendar-base.txt. Через него снаружи открыт ТОЛЬКО путь /cal/ (политика
// calendar-policy.yml), приложение и /api остаются на туннеле Cloudflare. Страницу-предупреждение бесплатный ngrok
// показывает только браузерам; календарные программы (iPhone, Google) получают ленту как есть (проверено 4 окт 2026).
//
// Туннель запускается отдельным процессом и переживает перезапуск сервера. Раз в минуту сервер опрашивает агентов ngrok
// на этом ПК через их локальный API (порт 4040; если он занят, ngrok сам берёт 4041, 4042, …) — /api/status отвечает
// online, пока сеанс с ngrok жив, и reconnecting, когда потерян (сон ноутбука, смена сети). На один адрес должен работать
// ровно ОДИН агент: второго с тем же адресом ngrok не пускает (ERR_NGROK_334 «endpoint is already online»), а агент,
// потерявший сеанс, сам не выходит — переподключается бесконечно и, раз адрес уже занял другой, вечно получает тот же
// отказ. Поэтому при живом агенте лишние (не online) останавливаются, а если online нет PATIENCE проверок подряд —
// останавливаются все агенты адреса и запускается новый. До 15 окт 2026 проверялся только порт 4040, из-за чего
// сервер не видел живой агент на 4041+ и каждую минуту запускал ещё один (NOTES.md п. 131).
// Выключить: CAL_TUNNEL=0 или убрать calendar-base.txt.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stableBase } from "./calendar.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(DIR, "ngrok.yml");
const POLICY = join(DIR, "calendar-policy.yml");
const LOG = join(DIR, "cal-tunnel.log");
const CHECK_MS = 60e3;
const PORTS = Array.from({ length: 10 }, (_, i) => 4040 + i); // локальный API ngrok: 4040, при занятом — следующие
export const GRACE_MS = 90e3; // после своего запуска агента не трогаем и второй не запускаем
export const PATIENCE = 5; // проверок подряд без online-агента (ngrok переподключается сам) — остановить всех и запустить заново
const PAUSE_MS = 10 * 60e3; // после трёх запусков без результата (нет сети) — пауза
const LOG_MAX = 5 * 2 ** 20; // журнал ngrok больше 5 МБ — отложить в .old.log перед новым запуском (если никто не держит)
const run = promisify(execFile);

async function findNgrok() {
  if (process.env.NGROK_EXE && existsSync(process.env.NGROK_EXE)) return process.env.NGROK_EXE;
  const local = process.env.LOCALAPPDATA || "";
  const link = join(local, "Microsoft", "WinGet", "Links", "ngrok.exe");
  if (existsSync(link)) return link;
  const pk = join(local, "Microsoft", "WinGet", "Packages");
  for (const d of await readdir(pk).catch(() => [])) {
    const exe = join(pk, d, "ngrok.exe");
    if (/^Ngrok\.Ngrok/i.test(d) && existsSync(exe)) return exe;
  }
  return null;
}

/** Агенты ngrok на этом ПК: порт локального API, состояние сеанса (online | reconnecting | …) и адреса их туннелей. */
async function agents() {
  const out = [];
  await Promise.all(PORTS.map(async (port) => {
    const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json());
    try {
      const st = await get("/api/status");
      if (typeof st?.status !== "string") return;
      const t = await get("/api/tunnels").catch(() => ({}));
      out.push({ port, status: st.status, urls: (t.tunnels || []).map((x) => String(x.public_url || "").replace(/[/]+$/, "")) });
    } catch { /* на этом порту ngrok нет */ }
  }));
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Что делать по списку агентов — чистая функция (проверяется в ops/stand/cal-tunnel-test.mjs).
 * mem: lastSpawn — когда запускали своего агента, down — сколько проверок подряд нет online, pauseUntil — пауза после неудач.
 * Ответ: ok/reason для экрана; port — живой агент; stopOthers — остановить остальных агентов адреса; wait — ничего не
 * делать; spawn — запустить (stopAll — перед этим остановить всех агентов адреса); down — новое значение счётчика.
 */
export function plan(base, list, mem, now = Date.now()) {
  const mine = list.filter((a) => a.urls.includes(base));
  const online = mine.find((a) => a.status === "online");
  if (online) return { ok: true, reason: "работает", port: online.port, stopOthers: mine.length > 1 && now - mem.lastSpawn >= GRACE_MS, down: 0 };
  // Агент без туннелей тоже считается «наш, подключается»: пока сеанса нет, ngrok ещё не показывает адрес.
  const trying = list.filter((a) => a.status !== "online" && (a.urls.includes(base) || !a.urls.length));
  if (now - mem.lastSpawn < GRACE_MS) return { ok: false, reason: "запускается", wait: true, down: mem.down };
  if (trying.length && mem.down + 1 < PATIENCE) return { ok: false, reason: `ngrok: ${trying[0].status}`, wait: true, down: mem.down + 1 };
  if (now < mem.pauseUntil) return { ok: false, reason: "пауза после неудачных запусков", wait: true, down: 0 };
  return { ok: false, reason: "туннель не запущен", spawn: true, stopAll: trying.length > 0, down: 0 };
}

// Процессы ngrok с портами их локального API: «pid|порт|командная строка» (порт пустой, если процесс ничего не слушает).
const PS_LIST = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $l = @{}; "
  + "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 4040 -and $_.LocalPort -le 4049 } | ForEach-Object { $l[[int]$_.OwningProcess] = [int]$_.LocalPort }; "
  + "Get-CimInstance Win32_Process -Filter \"Name='ngrok.exe'\" | ForEach-Object { [string]$_.ProcessId + '|' + $l[[int]$_.ProcessId] + '|' + $_.CommandLine }";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Процессы ngrok, запущенные для этого адреса: [{ pid, port }] (port — порт локального API, 0 — не слушает). */
async function ourAgents(base) {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST], { windowsHide: true, timeout: 30e3 });
  const re = new RegExp(`--url ${esc(base)}(\\s|$)`);
  return stdout.split(/\r?\n/).map((l) => l.split("|")).filter((f) => f.length >= 3 && re.test(f.slice(2).join("|")))
    .map((f) => ({ pid: Number(f[0]), port: Number(f[1]) || 0 })).filter((x) => x.pid > 0);
}

/** Остановить агентов этого адреса, кроме того, что слушает keepPort (0 — всех). */
async function stopAgents(base, keepPort, say) {
  let list;
  try { list = await ourAgents(base); } catch (e) { return say(`не смог посмотреть процессы ngrok: ${e.message}`); }
  const keep = keepPort ? list.find((x) => x.port === keepPort) : null;
  if (keepPort && !keep) return say(`живой агент ngrok (порт ${keepPort}) не найден среди процессов — лишних не трогаю`);
  const stopped = [];
  for (const x of list) if (x !== keep) { try { process.kill(x.pid); stopped.push(x.pid); } catch { /* уже вышел */ } }
  if (stopped.length) say(`остановлены лишние агенты ngrok (сеанс потерян; адрес ${keep ? `держит агент на порту ${keep.port}` : "свободен"}): ${stopped.join(", ")}`);
}

async function rotateLog() {
  const s = await stat(LOG).catch(() => null);
  if (s && s.size > LOG_MAX) await rename(LOG, LOG.replace(/\.log$/, ".old.log")).catch(() => { /* файл держит работающий агент — в другой раз */ });
}

let state = { ok: false, reason: "не запускался" };
/** Состояние туннеля — для экрана «Календарь» (подписку предлагаем, только когда постоянный адрес действительно отвечает). */
export const tunnelState = () => state;

export function watchCalendarTunnel(port) {
  if (process.env.CAL_TUNNEL === "0") { state = { ok: true, reason: "управляется снаружи" }; return; }
  const mem = { lastSpawn: 0, down: 0, pauseUntil: 0, fails: 0 };
  let said = "", busy = false;
  const say = (text) => { if (text !== said) { said = text; console.log(`cal-tunnel: ${text}`); } };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const base = await stableBase();
      if (!base) { state = { ok: false, reason: "нет calendar-base.txt" }; return; }
      const r = plan(base, await agents(), mem, Date.now());
      state = { ok: r.ok, reason: r.reason };
      mem.down = r.down;
      if (r.ok) {
        mem.fails = 0;
        say(`постоянный адрес календаря работает: ${base}${r.port !== 4040 ? ` (ngrok на порту ${r.port})` : ""}`);
        if (r.stopOthers) await stopAgents(base, r.port, say);
        return;
      }
      if (r.wait) return say(`туннеля пока нет (${r.reason})`);
      if (r.stopAll) await stopAgents(base, 0, say);
      const exe = await findNgrok();
      if (!exe || !existsSync(CONFIG) || !existsSync(POLICY)) { state = { ok: false, reason: !exe ? "ngrok не найден" : "нет ngrok.yml или calendar-policy.yml" }; return say(`не запущен: ${state.reason}`); }
      await rotateLog();
      // --log-level warn: в cal-tunnel.log только предупреждения и ошибки (обычная работа там не шумит, об успехе пишем сами).
      const p = spawn(exe, ["http", String(port), "--url", base, "--config", CONFIG, "--traffic-policy-file", POLICY, "--log", LOG, "--log-format", "logfmt", "--log-level", "warn"],
        { windowsHide: true, detached: true, stdio: "ignore" });
      p.on("error", (e) => say(`не запустился: ${e.message}`));
      p.unref();
      mem.lastSpawn = Date.now();
      if (++mem.fails >= 3) { mem.fails = 0; mem.pauseUntil = Date.now() + PAUSE_MS; say("три запуска подряд без результата — пауза 10 минут (подробности в cal-tunnel.log)"); }
      else say("запускаю туннель ngrok для календаря");
      setTimeout(() => void tick().catch(() => {}), 10e3).unref(); // через 10 с посмотреть, поднялся ли
    } finally { busy = false; }
  };
  setTimeout(() => void tick().catch(() => {}), 5000).unref();
  setInterval(() => void tick().catch(() => {}), CHECK_MS).unref();
}
