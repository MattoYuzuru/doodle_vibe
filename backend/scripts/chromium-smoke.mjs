// Chromium runtime smoke: launch with the OS sandbox, render a data: page, receive a CDP screencast frame.
// Touches no external network; exits 0 only if every check passed. Output is one JSON line without page data.
import { chromium } from "playwright-core";

const DEADLINE_MS = Number(process.env.CHROMIUM_SMOKE_TIMEOUT_MS || 30_000);
const page_html = `<!doctype html><meta charset="utf-8"><title>smoke</title>
<body style="margin:0;background:#fff"><main id="probe" style="width:320px;height:200px;background:rgb(10,120,200);color:#fff;font:24px sans-serif">chromium-smoke</main></body>`;

const steps = [];
const ok = (name, detail) => steps.push({ name, ok: true, ...detail });
function require(condition, name) { if (!condition) throw new Error("check failed: " + name); }

async function run() {
  const external = [];
  // chromiumSandbox: true keeps the OS sandbox; Playwright disables it by default.
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    chromiumSandbox: true,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "--disable-background-networking", "--no-first-run"],
    timeout: 15_000,
  });
  try {
    ok("launch", { version: browser.version(), sandbox: true });
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^(data|about|blob):/.test(url)) return route.continue();
      external.push(new URL(url).protocol);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(page_html));
    const rendered = await page.evaluate(() => {
      const el = document.getElementById("probe");
      const box = el.getBoundingClientRect();
      return { text: el.textContent, color: getComputedStyle(el).backgroundColor, width: Math.round(box.width), height: Math.round(box.height) };
    });
    require(rendered.text === "chromium-smoke" && rendered.color === "rgb(10, 120, 200)" && rendered.width === 320 && rendered.height === 200, "render");
    const png = await page.screenshot({ type: "png" });
    require(png.length > 200 && png.subarray(1, 4).toString() === "PNG", "screenshot");
    ok("render", { screenshotBytes: png.length });

    const cdp = await context.newCDPSession(page);
    const frame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("check failed: screencast frame timeout")), 10_000);
      cdp.once("Page.screencastFrame", (event) => { clearTimeout(timer); resolve(event); });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 360, maxHeight: 640, everyNthFrame: 1 });
    // Headless emits frames only on visual change; force a repaint after the screencast starts.
    await page.evaluate(() => { document.body.style.background = "rgb(240, 240, 240)"; document.getElementById("probe").textContent += "!"; });
    const event = await frame;
    await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    await cdp.send("Page.stopScreencast");
    const jpeg = Buffer.from(event.data, "base64");
    require(jpeg.length > 200 && jpeg[0] === 0xff && jpeg[1] === 0xd8, "screencast jpeg");
    ok("screencast", { frameBytes: jpeg.length, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight });
    require(external.length === 0, "no external requests (" + external.join(",") + ")");
    ok("isolation", { externalRequests: 0 });
  } finally {
    await browser.close();
  }
  ok("close", {});
}

const timer = setTimeout(() => { console.error(JSON.stringify({ ok: false, error: "timeout", steps })); process.exit(1); }, DEADLINE_MS);
try {
  await run();
  clearTimeout(timer);
  console.log(JSON.stringify({ ok: true, playwright: "playwright-core", steps }));
} catch (error) {
  clearTimeout(timer);
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).split("\n")[0].slice(0, 300), steps }));
  process.exitCode = 1;
}
