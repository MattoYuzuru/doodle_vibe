import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT || 14173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT must be an unprivileged TCP port");
const baseURL = "http://127.0.0.1:" + port;

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
  webServer: {
    command: "npm --prefix jarvis-app/web run preview -- --host 127.0.0.1 --port " + port + " --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
