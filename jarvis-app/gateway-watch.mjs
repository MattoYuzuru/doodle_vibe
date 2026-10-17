// Сторож Gateway OpenClaw. 1 окт 2026 Gateway завис на четыре часа: процесс жив, порт 18789 открыт, но на подключения
// он не отвечает — агент «молчал» у всех, пока службу не перезапустили вручную. Сторож раз в две минуты спрашивает
// Gateway по HTTP; три проверки подряд без ответа (порт при этом принимает соединение) — это зависание: выполняется
// `openclaw gateway restart`, владельцу уходит сообщение. Если Gateway просто не запущен (в соединении отказано),
// сторож ничего не делает: его могли остановить намеренно, а после входа в Windows он стартует сам.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.GATEWAY_URL || "http://127.0.0.1:18789/";
const EVERY_MS = Number(process.env.GATEWAY_WATCH_MS) || 2 * 60e3;
const PROBE_MS = Number(process.env.GATEWAY_PROBE_MS) || 10e3;
const FAILS = 3;
const COOLDOWN_MS = Number(process.env.GATEWAY_COOLDOWN_MS) || 15 * 60e3; // не чаще одного перезапуска за 15 минут
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");

/** «ok» — ответил (любым кодом), «hung» — соединение принято, ответа нет, «down» — не запущен. */
async function probe() {
  try { await fetch(URL_, { signal: AbortSignal.timeout(PROBE_MS) }); return "ok"; }
  catch (e) { return e.name === "TimeoutError" || e.name === "AbortError" ? "hung" : "down"; }
}

const restart = () => new Promise((resolve) => {
  const p = spawn(process.execPath, [OPENCLAW, "gateway", "restart"], { windowsHide: true });
  const t = setTimeout(() => p.kill(), 3 * 60e3);
  p.on("close", (code) => { clearTimeout(t); resolve(code); });
  p.on("error", () => { clearTimeout(t); resolve(-1); });
});

/** notify(text) — сообщение владельцу (через Bot API напрямую: зависший Gateway его отправить не может). */
export function watchGateway({ notify }) {
  let fails = 0, lastRestart = 0, busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await probe();
      fails = state === "hung" ? fails + 1 : 0;
      if (fails < FAILS || Date.now() - lastRestart < COOLDOWN_MS) return;
      lastRestart = Date.now();
      fails = 0;
      console.log("gateway-watch: Gateway не отвечает — перезапуск");
      const code = await restart();
      // Gateway поднимается около полминуты; проверяем результат и сообщаем владельцу как есть.
      let after = "down";
      for (let i = 0; i < 12 && after !== "ok"; i++) { await new Promise((r) => setTimeout(r, Math.min(5000, EVERY_MS))); after = await probe(); }
      console.log(`gateway-watch: перезапуск завершён (код ${code}), состояние: ${after}`);
      await notify(after === "ok"
        ? "🔄 Служба OpenClaw на ПК зависла — Doodle перезапустил её сам, агент снова отвечает. Если лаба в этот момент не запустилась, нажмите в ней «Запустить заново»."
        : "⚠️ Служба OpenClaw на ПК зависла, автоматический перезапуск не помог. На ПК: openclaw gateway restart").catch(() => {});
    } catch (e) { console.error(`gateway-watch: ${e.message || e}`); }
    finally { busy = false; }
  };
  setInterval(tick, EVERY_MS).unref();
}
