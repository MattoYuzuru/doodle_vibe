// Сторож входа Джарвиса в Claude.
// Работает без модели, поэтому срабатывает и тогда, когда бот сам ответить уже не может
// (навык OpenClaw или cron-задача OpenClaw в этот момент тоже не запустились бы: им нужна модель).
// Раз в час его запускает Планировщик заданий Windows (auth-watchdog.vbs, без окна). Он:
//   1) смотрит `openclaw models status --json/--check`: нет входа, вход истёк или скоро истечёт;
//   2) ищет в логе Gateway новые ошибки входа (Failed to authenticate…) с прошлой проверки;
//   3) при проблеме пишет владельцу в Telegram через `openclaw message send` (модель не нужна),
//      о той же проблеме напоминает не чаще раза в 6 часов, а когда всё починилось, сообщает об этом.
// Токены он не читает и не выводит. Запуск вручную: node auth-watchdog.mjs [--dry-run]
import { spawn } from "node:child_process";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, "auth-watchdog.state.json");
const RUN_LOG = join(DIR, "auth-watchdog.log");
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const GW_LOGS = process.env.WATCHDOG_LOG_DIR || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Temp", "openclaw");
const OWNER = "945210206"; // telegram:945210206
const REMIND_MS = 6 * 3600e3;
const WARN_DAYS = 14;
const DRY = process.argv.includes("--dry-run");

const FIX = [
  "Что сделать на ПК, в терминале (займёт пару минут):",
  "1) claude setup-token  — войди в браузере, скопируй токен sk-ant-oat01-… (никому его не пересылай)",
  "2) openclaw models auth login --provider anthropic --method setup-token  — вставь токен",
  "3) openclaw gateway restart",
].join("\n");

function run(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [OPENCLAW, ...args], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on("error", () => { clearTimeout(t); resolve({ code: -1, out }); });
  });
}

// Самый ранний срок действия среди сохранённых токенов (ключи вида expires/expiresAt/expiresAtMs).
function earliestExpiry(node, acc = []) {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/^expires/i.test(k)) {
        const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
        if (Number.isFinite(ms) && ms > 1e12) acc.push(ms);
      } else earliestExpiry(v, acc);
    }
  }
  return acc.length ? Math.min(...acc) : null;
}

const mskKey = (ms) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" }); // 2026-09-30
const mskTime = (ms) => new Date(ms).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Ошибки входа и удачные ответы модели в логе Gateway после момента since.
async function scanGatewayLog(since) {
  const days = new Set([mskKey(since), mskKey(Date.now())]);
  const res = { lastError: null, lastErrorAt: 0, lastOkAt: 0 };
  for (const day of days) {
    const text = await readFile(join(GW_LOGS, `openclaw-${day}.log`), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes("cli terminal failure") && !line.includes("cli turn:")) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const at = Date.parse(j._meta?.date || "");
      if (!(at > since)) continue;
      const msg = String(j["1"] ?? "");
      if (msg.startsWith("cli turn:")) res.lastOkAt = Math.max(res.lastOkAt, at);
      else if (/authenticat|login|oauth|refresh|401|403|not allowed|invalid_grant/i.test(msg) && at >= res.lastErrorAt) {
        res.lastErrorAt = at;
        res.lastError = (msg.match(/error=(.*)$/)?.[1] || msg).slice(0, 200);
      }
    }
  }
  return res;
}

async function main() {
  const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"));
  const now = Date.now();
  const since = state.lastScan || now - 3 * 3600e3;

  const check = await run(["models", "status", "--check"]);
  const statusJson = await run(["models", "status", "--json"]);
  let auth = null;
  try { auth = JSON.parse(statusJson.out).auth; } catch {}
  const route = auth?.runtimeAuthRoutes?.find((r) => r.provider === "anthropic");
  const expiry = earliestExpiry(auth?.providers);
  const daysLeft = expiry ? Math.floor((expiry - now) / 86400e3) : null;
  const log = await scanGatewayLog(since);

  // Что считаем проблемой.
  let problem = null;
  if (log.lastError && log.lastErrorAt > log.lastOkAt)
    problem = { key: "auth-error", text: `⚠️ Джарвис: не работает вход в Claude, бот не может отвечать.\nОшибка (${mskTime(log.lastErrorAt)}): ${log.lastError}\n\n${FIX}` };
  else if (route && /expired|missing|unavailable/i.test(route.status || ""))
    problem = { key: "auth-" + route.status, text: `⚠️ Джарвис: вход в Claude в состоянии «${route.status}».\n\n${FIX}` };
  else if (daysLeft !== null && daysLeft <= WARN_DAYS)
    problem = { key: "expiring", text: `⏳ Джарвис: токен Claude истекает через ${Math.max(daysLeft, 0)} дн. (${mskTime(expiry)}). Обнови заранее.\n\n${FIX}` };

  let sent = null;
  if (problem) {
    const again = state.alertKey === problem.key && now - (state.alertAt || 0) < REMIND_MS;
    if (!again) sent = problem.text;
  } else if (state.alertKey && log.lastOkAt > (state.alertAt || 0)) {
    sent = "✅ Джарвис: вход в Claude снова работает, бот отвечает.";
  }

  if (sent) {
    if (DRY) console.log("[dry-run] отправил бы в Telegram:\n" + sent);
    else {
      const r = await run(["message", "send", "--channel", "telegram", "--target", OWNER, "-m", sent]);
      if (r.code !== 0) sent = null; // не получилось отправить: попробуем в следующий раз
    }
  }

  const line = `${new Date(now).toISOString()} check=${check.code} route=${route?.status ?? "?"} daysLeft=${daysLeft ?? "-"} ` +
    `lastErr=${log.lastErrorAt ? new Date(log.lastErrorAt).toISOString() : "-"} lastOk=${log.lastOkAt ? new Date(log.lastOkAt).toISOString() : "-"} ` +
    `problem=${problem?.key ?? "none"} sent=${sent ? "yes" : "no"}`;
  if (DRY) { console.log(line); return; }
  await appendFile(RUN_LOG, line + "\n");
  const next = { ...state, lastScan: now };
  if (sent && problem) Object.assign(next, { alertKey: problem.key, alertAt: now });
  if (sent && !problem) Object.assign(next, { alertKey: null, alertAt: null });
  await writeFile(STATE_FILE, JSON.stringify(next, null, 2));
}

main().catch(async (e) => { await appendFile(RUN_LOG, `${new Date().toISOString()} crash ${e.message}\n`).catch(() => {}); process.exit(1); });
