import { test, expect } from "@playwright/test";
import { platformApi } from "./fixtures/platform.mjs";

// DES-010: приложение с новым backend (platformApi "/api/v1") на синтетическом API. Два вуза — ВШЭ и МИСИС,
// переключение без данных прежнего вуза, ошибка обновления с сохранёнными данными и подключение нового вуза.
// Живой вход в вуз, Telegram и реальный backend здесь не проверяются.
test("two universities: HSE shows Varya with fire, switching to MISIS never shows HSE data", async ({ page }) => {
  await platformApi(page, { misisDelay: 800 });
  await page.goto("/");
  const home = page.locator('[data-space-home="s-hse"]');
  await expect(home.getByText("Эссе по экономике").first()).toBeVisible();
  await expect(home.locator('[data-character="varya"]').first()).toBeVisible();
  await expect(home.locator('[data-accent-layer="fire"]')).toBeVisible();
  await expect(home.getByText(/Горит · [45] ч/)).toBeVisible();
  await expect(home.getByText("Микроэкономика").first()).toBeVisible();

  await page.getByRole("button", { name: "МИСИС", exact: true }).click();
  const misis = page.locator('[data-space-home="s-misis"]');
  await expect(misis).toBeVisible();
  await expect(page.getByText("Эссе по экономике")).toHaveCount(0);
  await expect(misis.getByRole("progressbar").first()).toBeVisible();
  await expect(misis.getByText("Лабораторная по физике").first()).toBeVisible();
  await expect(misis.locator('[data-character="dusya"]').first()).toBeVisible();
  await expect(misis.locator('[data-accent-layer="warm"]')).toBeVisible();
});

test("tabs follow the selected university; the fourth tab lists its courses", async ({ page }) => {
  await platformApi(page);
  await page.goto("/");
  await expect(page.locator('[data-space-home="s-hse"]')).toBeVisible();
  await page.getByRole("button", { name: "Курсы" }).first().click();
  await expect(page.locator('[data-space-courses="s-hse"]').getByText("Микроэкономика")).toBeVisible();
  await page.getByRole("button", { name: "Дедлайны" }).first().click();
  const list = page.locator('[data-space-deadlines="s-hse"]');
  await expect(list.getByText("Эссе по экономике")).toBeVisible();
  await list.getByRole("button", { name: "МИСИС", exact: true }).click();
  await expect(page.locator('[data-space-deadlines="s-misis"]').getByText("Лабораторная по физике")).toBeVisible();
  await expect(page.getByText("Эссе по экономике")).toHaveCount(0);
});

test("a failed refresh keeps the last data visible and says so", async ({ page }) => {
  let fail = false;
  await platformApi(page, { failDeadlines: () => fail });
  await page.goto("/");
  const home = page.locator('[data-space-home="s-hse"]');
  await expect(home.getByText("Эссе по экономике").first()).toBeVisible();
  fail = true;
  await home.getByRole("button", { name: "Обновить данные вуза" }).click();
  await expect(home.getByRole("alert")).toContainText("Не получилось обновить");
  await expect(home.getByText("Эссе по экономике").first()).toBeVisible();
  await expect(home.getByRole("button", { name: "Повторить" })).toBeVisible();
});

test("a new user connects a university from the empty home screen", async ({ page }) => {
  const created = await platformApi(page, { spaces: [] });
  await page.goto("/");
  await page.getByRole("button", { name: "Подключить учёбу" }).click();
  await expect(page.getByRole("heading", { name: "Подключить учёбу" })).toBeVisible();
  // Первые 350 мс после открытия экрана приложение нарочно гасит нажатия (защита от двойного тапа, App.tsx):
  // на быстрой машине тест успевает нажать раньше, поэтому нажимаем, пока выбор не сработает.
  await expect(async () => {
    await page.getByRole("button", { name: "ВШЭ", exact: true }).click();
    await expect(page.getByText("Выбран: ВШЭ")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByLabel("Адрес сайта")).toBeVisible();
  expect(created).toEqual([{ universityId: "hse", name: "ВШЭ" }]);
  await page.getByLabel("Адрес сайта").fill("http://lms.example.test/?token=1");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByRole("alert")).toContainText("https://");
});
