// Постоянный адрес для подписки на календарь (calendar.mjs). Приложение открывается через быстрый туннель Cloudflare,
// адрес которого меняется при каждом запуске, — подписке в телефоне такой не годится. Здесь сервер держит второй туннель:
// ngrok на бесплатном постоянном домене из calendar-base.txt. Через него снаружи открыт ТОЛЬКО путь /cal/ (политика
// calendar-policy.yml), приложение и /api остаются на туннеле Cloudflare. Страницу-предупреждение бесплатный ngrok
// показывает только браузерам; календарные программы (iPhone, Google) получают ленту как есть (проверено 4 окт 2026).
//
// Туннель запускается отдельным процессом и переживает перезапуск сервера: перед запуском смотрим, не работает ли он уже
// (локальный адрес ngrok 127.0.0.1:4040). Раз в минуту проверяем и поднимаем заново, если упал. Выключить: CAL_TUNNEL=0
// или убрать calendar-base.txt.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableBase } from "./calendar.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(DIR, "ngrok.yml");
const POLICY = join(DIR, "calendar-policy.yml");
const CHECK_MS = 60e3;

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

/** Работает ли уже туннель на этот адрес (спрашиваем у самого ngrok на этом ПК). */
async function running(base) {
  try {
    const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return (j.tunnels || []).some((t) => String(t.public_url || "").replace(/[/]+$/, "") === base);
  } catch { return false; }
}

let state = { ok: false, reason: "не запускался" };
/** Состояние туннеля — для экрана «Календарь» (подписку предлагаем, только когда постоянный адрес действительно отвечает). */
export const tunnelState = () => state;

export function watchCalendarTunnel(port) {
  if (process.env.CAL_TUNNEL === "0") { state = { ok: true, reason: "управляется снаружи" }; return; }
  let fails = 0, pauseUntil = 0, said = "";
  const say = (text) => { if (text !== said) { said = text; console.log(`cal-tunnel: ${text}`); } };
  const tick = async () => {
    const base = await stableBase();
    if (!base) { state = { ok: false, reason: "нет calendar-base.txt" }; return; }
    if (await running(base)) { state = { ok: true, reason: "работает" }; fails = 0; return say(`постоянный адрес календаря работает: ${base}`); }
    state = { ok: false, reason: "туннель не запущен" };
    if (Date.now() < pauseUntil) return;
    const exe = await findNgrok();
    if (!exe || !existsSync(CONFIG) || !existsSync(POLICY)) { state = { ok: false, reason: !exe ? "ngrok не найден" : "нет ngrok.yml или calendar-policy.yml" }; return say(`не запущен: ${state.reason}`); }
    const p = spawn(exe, ["http", String(port), "--url", base, "--config", CONFIG, "--traffic-policy-file", POLICY, "--log", join(DIR, "cal-tunnel.log"), "--log-format", "logfmt"],
      { windowsHide: true, detached: true, stdio: "ignore" });
    p.on("error", (e) => say(`не запустился: ${e.message}`));
    p.unref();
    // Три неудачных запуска подряд (нет сети, домен занят другим сеансом) — 10 минут не пробуем.
    if (++fails >= 3) { fails = 0; pauseUntil = Date.now() + 10 * 60e3; say("три неудачных запуска подряд — пауза 10 минут (подробности в cal-tunnel.log)"); }
    else say("запускаю туннель ngrok для календаря");
    setTimeout(() => void running(base).then((ok) => { if (ok) { state = { ok: true, reason: "работает" }; fails = 0; say(`постоянный адрес календаря работает: ${base}`); } }), 8000).unref();
  };
  setTimeout(() => void tick().catch(() => {}), 5000).unref();
  setInterval(() => void tick().catch(() => {}), CHECK_MS).unref();
}
