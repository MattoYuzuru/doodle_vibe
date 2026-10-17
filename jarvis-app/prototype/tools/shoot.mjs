// Снимки мини-приложения в размере телефона через Chrome DevTools Protocol.
// node tools/shoot.mjs <папка> <имя>=<url> [<имя>=<url> ...]; имя с суффиксом "@bottom" снимается после прокрутки вниз.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [outDir, ...jobs] = process.argv.slice(2);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
await mkdir(outDir, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), "jarvis-cdp-profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const waiting = new Map(), listeners = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  else if (m.method) listeners.forEach((f) => f(m));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
for (const job of jobs) {
  const [name, rest] = job.split(/=(.*)/s);
  const [url, js] = rest.split(/\|(.*)/s); // name=url|js — выполнить js перед снимком
  const loaded = new Promise((r) => listeners.push((m) => m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url });
  await loaded; listeners.length = 0;
  await sleep(2500);
  if (js) { await send("Runtime.evaluate", { expression: js, awaitPromise: true }); await sleep(700); }
  if (name.endsWith("@bottom")) { await send("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" }); await sleep(400); }
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(outDir, name.replace("@bottom", "-bottom") + ".png"), Buffer.from(data, "base64"));
  console.log("ok", name);
}
ws.close(); chrome.kill();
