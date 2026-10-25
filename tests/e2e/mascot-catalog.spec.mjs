import { test, expect } from "@playwright/test";

// DES-006: «горит дедлайн», ошибка, несколько работ, однократная реакция и загрузка — на каталоге маскотов
// с синтетическими данными и фиксированными часами (без backend, входа в вуз и сети).
const catalog = "http://127.0.0.1:" + Number(process.env.E2E_CATALOG_PORT || 14174) + "/mascot-catalog.html";
const card = (page, id) => page.locator(`[data-fixture="${id}"]`);

async function open(page, query = "character=varya") {
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === new URL(catalog).origin ? route.continue() : route.abort()));
  await page.goto(catalog + "?" + query);
  await expect(card(page, "urgent").locator("[data-status]")).toBeVisible();
}

test("urgent deadline: fire behind one mascot, time-left badge and a keyboard-reachable action", async ({ page }) => {
  await open(page);
  const urgent = card(page, "urgent");
  await expect(urgent.locator("[data-status]")).toHaveAttribute("data-status", "urgent");
  await expect(urgent.locator('[data-accent-layer="fire"]')).toBeVisible();
  await expect(urgent.locator("[data-character]")).toHaveCount(1);
  await expect(urgent.getByText("Горит · 5 ч")).toBeVisible();
  await expect(urgent.getByText(/И ещё 1/)).toBeVisible();
  const action = urgent.getByRole("button", { name: "Открыть работу" });
  await action.focus();
  await expect(action).toBeFocused();
  expect((await action.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("error and overdue are labelled without fire; the deadline stays as a badge during a sync", async ({ page }) => {
  await open(page);
  await expect(card(page, "error").getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(card(page, "error").locator('[data-accent-layer="fire"]')).toHaveCount(0);
  await expect(card(page, "overdue").getByText("Просрочено", { exact: true })).toBeVisible();
  await expect(card(page, "overdue").locator('[data-accent-layer="fire"]')).toHaveCount(0);
  await expect(card(page, "urgent-sync").getByText("Горит · 5 ч · «Отчёт по лабе 3»")).toBeVisible();
  await expect(card(page, "urgent-sync").getByRole("progressbar", { name: "Обновление" })).toBeVisible();
});

test("completion reacts once and can be replayed only explicitly", async ({ page }) => {
  // Реакция живёт REACTION_WINDOW_MS (1,5 с): на медленном раннере она успевала доиграть до первой проверки.
  // Часы стоят, пока тест сам их не сдвинет.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await open(page);
  const status = card(page, "completed").locator("[data-status]");
  await expect(status).toHaveAttribute("data-status", "completed");
  await page.clock.runFor(2000);
  await expect(status).toHaveAttribute("data-status", "ready");
  await page.getByRole("button", { name: "Проиграть реакции заново" }).click();
  await expect(card(page, "completed").locator("[data-status]")).toHaveAttribute("data-status", "completed");
});

test("reduced motion keeps a static fire sign and a still loading track", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "character=dusya");
  const fire = card(page, "urgent").locator(".owl-fire-a");
  await expect(fire).toBeVisible();
  expect(await fire.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  const loaders = page.locator('[data-fixture="loaders"]');
  await expect(loaders.getByRole("progressbar")).toHaveCount(2);
  for (const bar of await loaders.getByRole("progressbar").all()) expect(await bar.getAttribute("aria-valuenow")).toBeNull();
  expect(await loaders.locator(".owl-track-run").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
