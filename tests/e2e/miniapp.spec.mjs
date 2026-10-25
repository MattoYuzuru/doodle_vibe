import { test, expect } from "@playwright/test";

// Browser smoke of the existing UI with a synthetic backend. No university login,
// Telegram identity, real grades, LLM or future multi-space behavior is exercised.
const profile = (loggedIn) => ({
  tgId: 5001, loggedIn, moodle: loggedIn ? { userId: 1001, fullName: "Тестовый Студент", username: "fixture-student" } : null,
  group: "ТЕСТ-26-1", groupCandidates: [], subgroup: "1", variant: null,
  labsAllowed: false, labsOff: true, labRequest: null, isOwner: false, courseOverrides: {}, shareRemarks: false,
});
async function fixtureApi(page, { rejectLogin = false, stale = false } = {}) {
  let loggedIn = false;
  const unexpected = [];
  const fixtureOrigin = new URL(test.info().project.use.baseURL).origin;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (data, status = 200) => route.fulfill({ status, json: data });
    switch (url.pathname) {
      case "/api/me": return send(profile(loggedIn));
      case "/api/login": {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({ username: "fixture-student", password: "fixture-password" });
        if (rejectLogin) return send({ error: "Неверный логин или пароль" }, 401);
        loggedIn = true; return send(profile(true));
      }
      case "/api/cloud": return send(null);
      case "/api/deadlines": return send({
        updated: Date.now(), stale,
        ...(stale ? { moodle: { down: true, since: Date.now(), reason: "network", okAt: null } } : {}),
        courses: [{ id: 101, name: "Тестовая дисциплина", short: "ТД" }],
        items: [{ id: "moodle:assign:1001", title: "Работа из тестового источника", kind: "lab", courseId: 101, due: Date.now() + 86400_000, url: "https://university.example.test/task/1001", status: "open" }],
      });
      case "/api/schedule": {
        const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
        return send({ at: Date.now(), group: "ТЕСТ-26-1", lessons: [{ date: today, start: "09:00", end: "10:35", name: "Тестовая пара", type: "lecture", typeLabel: "Лекция", teacher: "Тестовый Преподаватель", place: "А-101", subgroup: "" }] });
      }
      case "/api/labs": return send([]);
      case "/api/ej": return send({ subjects: [], connected: false });
      case "/api/session": return send({ subjects: [], items: [] });
      case "/api/reminders": case "/api/diag": return send({ ok: true });
      default: unexpected.push(url.pathname); return send({ error: "Unexpected fixture request" }, 500);
    }
  });
  return unexpected;
}
async function openLogin(page) {
  await page.goto("/");
  const skip = page.getByRole("button", { name: "Пропустить", exact: true });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(page.getByRole("heading", { name: "Вход в Moodle", exact: true })).toBeVisible();
}
async function login(page) {
  await page.getByPlaceholder("Логин Moodle", { exact: true }).fill("fixture-student");
  await page.getByPlaceholder("Пароль", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}

test("login loads personal deadlines and schedule; reload reuses the fixture session", async ({ page }) => {
  const unexpected = await fixtureApi(page);
  await openLogin(page);
  await login(page);
  await expect(page.getByText("Работа из тестового источника", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Тестовая пара", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Дедлайны", exact: true }).click();
  await expect(page.getByText("Работа из тестового источника", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Вход в Moodle", exact: true })).toHaveCount(0);
  await expect(page.getByText("Работа из тестового источника", { exact: true }).first()).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("rejected credentials remain on the login screen with an actionable error", async ({ page }) => {
  const unexpected = await fixtureApi(page, { rejectLogin: true });
  await openLogin(page);
  await login(page);
  await expect(page.getByText("Неверный логин или пароль", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Вход в Moodle", exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("an unavailable source keeps the last returned deadline visible", async ({ page }) => {
  const unexpected = await fixtureApi(page, { stale: true });
  await openLogin(page);
  await login(page);
  await expect(page.getByText("Работа из тестового источника", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Moodle.*(?:не|недоступ)|Нет связи с Moodle/i).first()).toBeVisible();
  expect(unexpected).toEqual([]);
});
