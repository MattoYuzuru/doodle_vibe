import { test, expect } from "@playwright/test";
import { H, iso, item, platformApi } from "./fixtures/platform.mjs";

// DES-009 (зона A): движение маскота под контролем пользователя и системы, клавиатура и узкие экраны — в режиме
// вузов на синтетическом /api/v1. Экранный диктор и настоящий телефон здесь не проверяются.
const LONG = "Индивидуальное домашнее задание по теории вероятностей и математической статистике для групп второго курса с отчётом";
const fireAnimation = (page) => page.locator(".owl-fire-a").first().evaluate((el) => getComputedStyle(el).animationName);
const spriteClass = (page) => page.locator('[data-space-home] [data-character]').first().getAttribute("class");

// Приложение само включает облегчённый режим (статичный маскот) при ≤ 4 ядрах — как у раннера GitHub Actions.
// Здесь проверяется полное движение и его выключатели, поэтому автоопределение отключаем, как ?lite=0.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jarvis.lite", "off"));
});

test("reduced motion: the fire stays as a still sign, the mascot does not move", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await platformApi(page);
  await page.goto("/");
  await expect(page.locator('[data-accent-layer="fire"]')).toBeVisible();
  expect(await fireAnimation(page)).toBe("none");
  expect(await spriteClass(page)).toContain("owl-static");
  await expect(page.getByText(/Горит · [45] ч/)).toBeVisible();
});

test("the calm mascot switch stops animation, keeps the meaning and survives a reload", async ({ page }) => {
  await platformApi(page);
  await page.goto("/");
  await expect(page.locator('[data-accent-layer="fire"]')).toBeVisible();
  expect(await fireAnimation(page)).not.toBe("none");
  const pause = page.getByRole("button", { name: "Остановить анимацию маскота" });
  await pause.click();
  await expect(page.getByRole("button", { name: "Включить анимацию маскота" })).toHaveAttribute("aria-pressed", "true");
  expect(await fireAnimation(page)).toBe("none");
  await expect(page.locator('[data-accent-layer="fire"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Открыть работу" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Включить анимацию маскота" })).toHaveAttribute("aria-pressed", "true");
  expect(await fireAnimation(page)).toBe("none");
});

test("a hidden tab pauses the mascot and resumes when visible again", async ({ page }) => {
  await platformApi(page);
  await page.goto("/");
  await expect(page.locator('[data-accent-layer="fire"]')).toBeVisible();
  const setVisibility = (state) => page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  await setVisibility("hidden");
  await expect.poll(() => spriteClass(page)).toContain("owl-static");
  await setVisibility("visible");
  await expect.poll(() => spriteClass(page)).not.toContain("owl-static");
});

test("keyboard: the university switcher and the mascot action are reachable with a visible focus", async ({ page }) => {
  await platformApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Открыть работу" })).toBeVisible();
  const reached = new Set();
  for (let i = 0; i < 25 && reached.size < 2; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { text: el.textContent?.trim() ?? "", outline: getComputedStyle(el).outlineStyle } : null;
    });
    if (f && (f.text === "МИСИС" || f.text === "Открыть работу")) {
      expect(f.outline).not.toBe("none");
      reached.add(f.text);
    }
  }
  expect([...reached].sort()).toEqual(["МИСИС", "Открыть работу"]);
});

for (const width of [320, 390, 768, 195]) {
  test(`no horizontal scroll at ${width} CSS px${width === 195 ? " (390 px at 200% zoom)" : ""} with long Russian text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await platformApi(page, { extraDeadlines: [item("s-hse", "long", LONG, { dueAt: iso(30 * 60e3) })] });
    await page.goto("/");
    await expect(page.getByText(LONG).first()).toBeVisible();
    // У ленты вкладок overflow-x: clip, поэтому scrollWidth ничего не докажет: проверяем, что каждый элемент экрана
    // целиком помещается по ширине (обрезанный текст или кнопка за краем — ошибка).
    const outside = (root) => page.locator(root).evaluate((el) => [...el.querySelectorAll("*")].filter((n) => {
      // Декоративные слои (блеск карточки и т. п.) нарочно шире и обрезаются родителем — их не считаем.
      if (n.closest(".pointer-events-none, [aria-hidden='true']")) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && (r.left < -0.5 || r.right > window.innerWidth + 0.5);
    }).map((n) => n.tagName + "." + String(n.className).slice(0, 40)));
    await expect.poll(() => outside("[data-space-home]")).toEqual([]);
    await page.getByRole("button", { name: "Дедлайны" }).first().click();
    await expect(page.locator("[data-space-deadlines]").getByText(LONG)).toBeVisible();
    // Лента вкладок доезжает анимацией — ждём, пока экран встанет на место.
    await expect.poll(() => outside("[data-space-deadlines]")).toEqual([]);
  });
}

test("live regions do not announce the ticking countdown", async ({ page }) => {
  await platformApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Открыть работу" })).toBeVisible();
  const live = await page.locator("[aria-live]").allTextContents();
  for (const text of live) expect(text).not.toMatch(/\d+\s*(мин|ч)\b/);
});
