import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startEgressProxy } from './egress-proxy.mjs';

// One Chromium process per login session, an in-memory profile, and every byte of
// egress through the filtering proxy. Nothing here logs page content, input or
// frames; callers receive plain data and decide what is stored.
const BEARER = /^Bearer\s+([A-Za-z0-9._~+/=-]{8,8192})$/i;
const MAX_VIEWPORT = { width: 480, height: 900 };
const MIN_VIEWPORT = { width: 240, height: 320 };
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min));

export function createBrowserFactory({ executablePath = process.env.CHROMIUM_PATH || undefined, sandbox = process.env.CHROMIUM_SANDBOX !== '0',
  launchArgs = [], ignoreHTTPSErrors = false, headless = process.env.CHROMIUM_HEADED !== '1', resolver, dial, allowPorts, loadPlaywright } = {}) {
  const require = createRequire(import.meta.url);
  const playwright = () => (loadPlaywright ? loadPlaywright() : require('playwright-core'));
  const pathToChromium = () => { try { return executablePath ?? playwright().chromium.executablePath(); } catch { return null; } };
  return {
    // Synchronous: without the dependency or the binary the manager answers LOGIN_UNAVAILABLE.
    available() { const path = pathToChromium(); return Boolean(path) && existsSync(path); },
    async open({ policy, viewport = { width: 390, height: 780 } }) {
      const proxy = await startEgressProxy({ policy, resolver, dial, ...(allowPorts ? { allowPorts } : {}) });
      let browser;
      try {
        browser = await playwright().chromium.launch({
          executablePath: pathToChromium(), headless, chromiumSandbox: sandbox, timeout: 20_000,
          proxy: { server: `http://127.0.0.1:${proxy.port}` },
          args: ['--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--no-first-run', '--mute-audio',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', ...launchArgs],
        });
      } catch (error) { await proxy.close(); throw error; }
      const size = { width: clamp(viewport.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width), height: clamp(viewport.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height) };
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block', permissions: [], locale: 'ru-RU', ignoreHTTPSErrors });
      const observed = { bearer: null };
      await context.route('**/*', route => {
        const request = route.request(); let url;
        try { url = new URL(request.url()); } catch { return route.abort(); }
        if (!['https:', 'data:', 'about:', 'blob:'].includes(url.protocol)) return route.abort();
        if (url.protocol === 'https:' && !policy.allows(url.hostname, { contact: false })) return route.abort();
        if (request.resourceType() === 'media') return route.abort();
        return route.continue();
      });
      context.on('request', request => {
        const match = BEARER.exec(request.headers().authorization ?? '');
        if (!match) return;
        let host; try { host = new URL(request.url()).hostname; } catch { return; }
        if (policy.allows(host, { contact: false })) observed.bearer = { token: match[1], host, at: Date.now() };
      });
      // API responses seen during the login, kept in memory only so the origin can be learned (task B); never persisted here.
      const observations = [];
      context.on('response', async response => {
        try {
          const request = response.request();
          if (request.method() !== 'GET' || !['xhr', 'fetch'].includes(request.resourceType()) || response.status() !== 200 || observations.length >= 80) return;
          if (!/json/i.test(response.headers()['content-type'] ?? '') || !policy.allows(new URL(response.url()).hostname, { contact: false })) return;
          const body = await response.body();
          if (body.length <= 262_144) observations.push({ method: 'GET', url: response.url(), status: 200, body: JSON.parse(body.toString('utf8')) });
        } catch { /* Not JSON or the page moved on. */ }
      });
      const page = await context.newPage();
      page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
      page.on('download', download => void download.cancel().catch(() => {}));
      // Popups (window.open) are folded into the one page: same policy, never a second window.
      context.on('page', async popup => {
        if (popup === page) return;
        try {
          await popup.waitForURL(url => url.href !== 'about:blank', { timeout: 3000 });
          const target = new URL(popup.url());
          await popup.close().catch(() => {});
          if (target.protocol === 'https:' && policy.allows(target.hostname, { contact: false })) await page.goto(target.href, { timeout: 20_000 }).catch(() => {});
        } catch { await popup.close().catch(() => {}); }
      });
      let screencast = null;
      const handle = {
        page, context, observed, proxy,
        observations: () => observations.slice(),
        viewport: () => page.viewportSize() ?? size,
        // origin + path only: query strings and fragments can carry tokens.
        safeUrl() { try { const url = new URL(page.url()); return url.protocol === 'https:' ? url.origin + url.pathname : null; } catch { return null; } },
        async cookies() {
          return (await context.cookies()).filter(cookie => policy.allows(cookie.domain.replace(/^\./, ''), { contact: false })).map(cookie => ({
            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
            ...(cookie.expires > 0 ? { expires: cookie.expires } : {}), ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          }));
        },
        // Storage is read only to locate where the observed bearer lives; it is never kept.
        async storageEntries() {
          try {
            return await page.evaluate(() => {
              const out = [];
              for (const [kind, storage] of [['localStorage', window.localStorage], ['sessionStorage', window.sessionStorage]]) {
                for (let i = 0; i < storage.length; i++) { const key = storage.key(i); out.push([kind, key, String(storage.getItem(key)).slice(0, 16_384)]); }
              }
              return out;
            });
          } catch { return []; }
        },
        async startScreencast(onFrame, { quality = 60, everyNthFrame = 2 } = {}) {
          if (screencast) return;
          const cdp = await context.newCDPSession(page);
          screencast = cdp;
          cdp.on('Page.screencastFrame', event => {
            onFrame(Buffer.from(event.data, 'base64'));
            cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
          });
          const { width, height } = handle.viewport();
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame });
          // Headless emits frames only on visual change: nudge one repaint so a static page still produces a first frame.
          await page.evaluate(() => { const root = document.documentElement; root.style.opacity = '0.99'; requestAnimationFrame(() => requestAnimationFrame(() => { root.style.opacity = ''; })); }).catch(() => {});
        },
        async stopScreencast() {
          const cdp = screencast; screencast = null;
          if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
        },
        async resize(width, height) {
          const next = { width: clamp(width, MIN_VIEWPORT.width, MAX_VIEWPORT.width), height: clamp(height, MIN_VIEWPORT.height, MAX_VIEWPORT.height) };
          await page.setViewportSize(next).catch(() => {});
          return next;
        },
        // Coordinates are clamped to the viewport; unknown keys are ignored.
        async input(message) {
          const { width, height } = handle.viewport();
          try {
            if (message.type === 'mouse') {
              const x = clamp(message.x, 0, width - 1); const y = clamp(message.y, 0, height - 1);
              const button = ['left', 'right', 'middle'].includes(message.button) ? message.button : 'left';
              if (message.action === 'move') await page.mouse.move(x, y);
              else if (message.action === 'down') { await page.mouse.move(x, y); await page.mouse.down({ button }); }
              else if (message.action === 'up') await page.mouse.up({ button });
              else if (message.action === 'wheel') { await page.mouse.move(x, y); await page.mouse.wheel(clamp(message.dx ?? 0, -2000, 2000), clamp(message.dy ?? 0, -2000, 2000)); }
            } else if (message.type === 'key' && typeof message.key === 'string' && /^[\x20-\x7E]$|^[A-Za-z0-9]{2,20}$/.test(message.key)) {
              if (message.action === 'down') await page.keyboard.down(message.key); else if (message.action === 'up') await page.keyboard.up(message.key);
            } else if (message.type === 'text' && typeof message.text === 'string') await page.keyboard.insertText(message.text.slice(0, 4096));
          } catch { /* An input the page cannot take is simply dropped. */ }
        },
        async close() {
          await handle.stopScreencast().catch(() => {});
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
          await proxy.close();
        },
      };
      return handle;
    },
  };
}

