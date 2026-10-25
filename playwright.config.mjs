import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT || 14173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT must be an unprivileged TCP port");
const baseURL = "http://127.0.0.1:" + port;
// Каталог маскотов (DES-005/006) живёт только на dev-сервере Vite и в сборку приложения не входит — для него свой порт.
const catalogPort = Number(process.env.E2E_CATALOG_PORT || 14174);
if (!Number.isInteger(catalogPort) || catalogPort < 1024 || catalogPort > 65535 || catalogPort === port) throw new Error("E2E_CATALOG_PORT must be a different unprivileged TCP port");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"], ["junit", { outputFile: "artifacts/e2e/results.xml" }], ["html", { outputFolder: "artifacts/playwright-report", open: "never" }]],
  outputDir: "artifacts/e2e/results",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", timezoneId: "Europe/Moscow" },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: [{
    command: "npm --prefix jarvis-app/web run preview -- --host 127.0.0.1 --port " + port + " --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: "npx vite --host 127.0.0.1 --port " + catalogPort + " --strictPort",
    cwd: "jarvis-app/web",
    url: "http://127.0.0.1:" + catalogPort + "/mascot-catalog.html",
    reuseExistingServer: false,
    timeout: 60_000,
  }],
});
