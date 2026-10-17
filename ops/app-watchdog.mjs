// Сторож мини-приложения Джарвиса: раз в 30 минут (Планировщик, app-watchdog.vbs) проверяет, что сервер (127.0.0.1:8787)
// и постоянный адрес ngrok отвечают; если нет — перезапускает задачу Планировщика и пишет владельцу в Telegram
// через `openclaw message send` (модель не нужна). О той же проблеме напоминает не чаще раза в 3 часа, о починке сообщает.
import { spawn } from "node:child_process";
import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, "app-watchdog.state.json");
const RUN_LOG = join(DIR, "app-watchdog.log");
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const OWNER = "945210206";
// Публичный адрес: быстрый туннель Cloudflare пишет его в current-url.txt (меняется при перезапуске).
const PUBLIC = (await readFile(join(DIR, "..", "jarvis-app", "current-url.txt"), "utf8").catch(() => "")).trim();
const TUNNEL_LOG = join(DIR, "..", "jarvis-app", "tunnel.log");
const REMIND_MS = 3 * 3600e3;
const DRY = process.argv.includes("--dry-run");

function run(cmd, args, timeoutMs = 60e3) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on("error", () => { clearTimeout(t); resolve({ code: -1, out }); });
  });
}
const notify = (text) => run(process.execPath, [OPENCLAW, "message", "send", "--channel", "telegram", "--target", OWNER, "-m", text]);
const restartTask = (name) => run("schtasks.exe", ["/Run", "/TN", name]);

// Протухший быстрый туннель: cloudflared жив и без конца повторяет «Tunnel not found». Пока он жив, `schtasks /Run` для задачи
// «Jarvis Tunnel» ничего не запускает (MultipleInstances=IgnoreNew) — 1 окт 2026 туннель так «перезапускался» вхолостую и не
// оживал. Поэтому сначала гасим наш cloudflared и откладываем старый лог (не удаляем): иначе его хвост с «Tunnel not found»
// снова пометит новый туннель мёртвым, а tunnel-url.mjs будет искать адрес в старом логе.
async function dropStaleTunnel() {
  // Вместе с cloudflared гасим и его обёртку (cmd /c start-tunnel.cmd): она держит tunnel.log открытым, и без этого лог
  // не переименовать — новый туннель дописывал бы в старый файл рядом со старыми «Tunnel not found».
  const script = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '127[.]0[.]0[.]1:8787|run jarvis') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-tunnel[.]cmd') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await rename(TUNNEL_LOG, `${TUNNEL_LOG}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`).then(() => true, (e) => e.code === "ENOENT")) break;
  }
}

async function probe(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    return r.ok;
  } catch { return false; }
}

// Сторожа запускают и Планировщик (раз в 30 минут), и сервер приложения (после пробуждения ПК): два одновременных
// экземпляра дважды перезапустили бы туннель. Поэтому запуск, начавшийся меньше 90 с после предыдущего, сразу выходит.
const LOCK_FILE = join(DIR, "app-watchdog.lock");
async function alreadyRunning() {
  const prev = Number(await readFile(LOCK_FILE, "utf8").catch(() => "0")) || 0;
  if (Date.now() - prev < 90e3) return true;
  await writeFile(LOCK_FILE, String(Date.now()));
  return false;
}

async function main() {
  if (!DRY && (await alreadyRunning())) return;
  const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"));
  const now = Date.now();
  let local = await probe("http://127.0.0.1:8787/api/health");
  // Туннель «мёртв», если cloudflared сам уже не восстановится:
  //  — «Tunnel not found» — быстрый туннель протух на стороне Cloudflare (после сна ноутбука);
  //  — подряд идут отказы соединения с Cloudflare и после них нет «Registered tunnel connection» — например, ноутбук
  //    перешёл в сеть раздачи с телефона, где не проходит QUIC (1 окт 2026: «failed to dial to edge with quic»).
  const tail = (await readFile(TUNNEL_LOG, "utf8").catch(() => "")).slice(-4000);
  const afterLastOk = tail.slice(tail.lastIndexOf("Registered tunnel connection") + 1);
  // «Tunnel not found» после последней удачной регистрации — приговор: Cloudflare удалил быстрый туннель (так бывает после
  // долгого сна ноутбука), сам он уже не вернётся. Раньше ждали трёх таких строк, и после пробуждения 1 окт 2026 первая
  // проверка их ещё не видела — приложение оставалось недоступным до следующей проверки через полчаса.
  const dead = /Tunnel not found/.test(afterLastOk)
    || (afterLastOk.match(/Failed to dial|Connection terminated|Serve tunnel error/g) || []).length >= 4;
  let pub = local && !dead && (!PUBLIC || (await probe(`${PUBLIC}/api/health`)));
  // Снаружи не ответил, но явных признаков смерти туннеля нет — скорее всего, ПК только что проснулся и сеть или
  // cloudflared ещё переподключаются (1 окт 2026: проверка через 4 с после пробуждения дала ложную тревогу, а туннель
  // сам восстановился через 17 с). Ждём минуту и проверяем ещё раз, прежде чем что-то перезапускать и писать владельцу.
  if (local && !pub && !dead && PUBLIC && !DRY) {
    await new Promise((r) => setTimeout(r, 60e3));
    pub = await probe(`${PUBLIC}/api/health`);
  }
  const problems = [];
  if (!local) {
    if (!DRY) { await restartTask("Jarvis App Server"); await new Promise((r) => setTimeout(r, 8000)); local = await probe("http://127.0.0.1:8787/api/health"); }
    if (!local) problems.push("сервер приложения не отвечает (перезапуск не помог)");
  }
  if (local && !pub) {
    // После перезапуска быстрого туннеля адрес будет новым — его пришлёт tunnel-url.mjs; здесь просто фиксируем факт.
    if (!DRY) {
      // Снаружи не отвечает, а cloudflared ещё жив: `schtasks /Run` при живом процессе ничего не делает, поэтому со второй
      // подряд неудачной проверки (≈30 мин простоя) гасим процесс в любом случае, а при явных признаках — сразу.
      if (dead || state.pubFails >= 1) await dropStaleTunnel();
      await restartTask("Jarvis Tunnel");
      await new Promise((r) => setTimeout(r, 20000));
    }
    problems.push("туннель не отвечал, перезапущен (адрес мог смениться — смотри сообщение бота)");
  }
  const key = problems.join("; ") || null;
  let sent = null;
  if (key) {
    if (!(state.alertKey === key && now - (state.alertAt || 0) < REMIND_MS))
      sent = `⚠️ Джарвис: приложение недоступно — ${key}.\nПроверь на ПК: задачи «Jarvis App Server» и «Jarvis Tunnel» в Планировщике, логи в moodle-work\\jarvis-app (server.log, tunnel.log).`;
  } else if (state.alertKey) sent = "✅ Джарвис: приложение снова доступно.";

  if (sent) { if (DRY) console.log("[dry-run] " + sent); else if ((await notify(sent)).code !== 0) sent = null; }
  const line = `${new Date(now).toISOString()} local=${local} public=${pub} problem=${key ?? "none"} sent=${sent ? "yes" : "no"}`;
  if (DRY) { console.log(line); return; }
  await appendFile(RUN_LOG, line + "\n");
  const next = { ...state, lastRun: now, pubFails: local && !pub ? (state.pubFails || 0) + 1 : 0 };
  if (sent && key) Object.assign(next, { alertKey: key, alertAt: now });
  if (sent && !key) Object.assign(next, { alertKey: null, alertAt: null });
  await writeFile(STATE_FILE, JSON.stringify(next, null, 2));
}

main().catch(async (e) => { await appendFile(RUN_LOG, `${new Date().toISOString()} crash ${e.message}\n`).catch(() => {}); process.exit(1); });
