import { test, expect } from "@playwright/test";

// Подключение ВШЭ на синтетическом /api/v1 по контракту backend #13 (docs/universities.md): Smart LMS через ссылку
// календаря, вход логином только для локальной учётной записи, РУЗ по идентификатору и отказ вне сети ВШЭ.
// Живой edu.hse.ru / ruz.hse.ru, SSO и реальные данные студента не используются.
const iso = () => new Date().toISOString();
const SPACE = { id: "s-hse", universityId: "hse", name: "ВШЭ", createdAt: iso() };
const METHODS = {
  "https://edu.hse.ru": [
    { id: "calendar_url", type: "calendar_url", label: "Ссылка экспорта календаря (iCal)", fields: ["calendarUrl"], sourceType: "moodle", note: "moodle_calendar_export", notes: ["sso_login_only"] },
    { id: "moodle_token", type: "token", label: "Токен Moodle", fields: ["token"], sourceType: "moodle", notes: ["sso_login_only"] },
    { id: "moodle_password", type: "password", label: "Логин и пароль Moodle", fields: ["username", "password"], sourceType: "moodle", note: "local_accounts_only", notes: ["sso_login_only"] },
  ],
  "https://ruz.hse.ru": [
    { id: "ruz_identifier", type: "identifier", label: "Почта, ФИО или номер студента в РУЗ", fields: ["identifier"], sourceType: "ruz", notes: ["university_network_only"] },
  ],
};

async function hseApi(page) {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const conns = new Map(), auth = [], added = [];
  let jobs = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    const p = url.pathname, method = route.request().method();
    const list = () => [...conns.values()].map((c) => c.connection);
    const section = { spaceId: SPACE.id, items: [], sources: [], get connections() { return list(); } };
    if (p === "/api/me") return send({ tgId: 1, loggedIn: true, moodle: null, group: null, groupCandidates: [], subgroup: "1", variant: null, labsAllowed: false, labsOff: true, labRequest: null, isOwner: false, courseOverrides: {}, shareRemarks: false, spaces: [SPACE], platformApi: "/api/v1" });
    if (p === "/api/v1/spaces") return send({ spaces: [SPACE] });
    if (/^\/api\/v1\/spaces\/s-hse\/(deadlines|schedule|courses)$/.test(p)) return send({ ...section, connections: list() });
    if (p === "/api/v1/spaces/s-hse/connections" && method === "POST") {
      const body = route.request().postDataJSON(); added.push(body);
      const id = "c" + (conns.size + 1);
      const connection = { id, spaceId: SPACE.id, sourceUrl: body.sourceUrl, kind: body.kind, label: body.label ?? "", status: "pending", errorCode: null, adapterId: null, createdAt: iso(), updatedAt: iso() };
      conns.set(id, { connection });
      // Discovery: известные ВШЭ-источники требуют действия пользователя.
      setTimeout(() => { connection.status = "user_action_required"; }, 0);
      return send({ connection, job: { id: "j" + ++jobs, status: "queued" } }, 202);
    }
    let m = p.match(/^\/api\/v1\/jobs\/(.+)$/);
    if (m) return send({ job: { id: m[1], status: "succeeded", errorCode: null, attempts: 1 } });
    m = p.match(/^\/api\/v1\/connections\/([^/]+)(\/auth)?$/);
    if (m && conns.has(m[1])) {
      const c = conns.get(m[1]).connection, o = new URL(c.sourceUrl).origin;
      if (!m[2]) return send({ connection: c, authMethods: c.status === "ready" ? [] : METHODS[o] ?? [] });
      const body = route.request().postDataJSON(); auth.push(body);
      if (o === "https://ruz.hse.ru") Object.assign(c, { status: "error", errorCode: "source_network_restricted" });
      else Object.assign(c, { status: "ready", errorCode: null });
      return send({ saved: true, job: { id: "j" + ++jobs, status: "queued" } }, 202);
    }
    if (p === "/api/cloud") return send(null);
    return send({ error: { code: "NOT_FOUND", requestId: "r" } }, 404);
  });
  return { auth, added };
}

async function openConnect(page) {
  await page.goto("/");
  await expect(page.locator('[data-space-home="s-hse"]')).toBeVisible();
  await page.getByRole("button", { name: "Подключить вуз или сайт" }).click();
  await expect(page.getByRole("heading", { name: "Подключить учёбу" })).toBeVisible();
  // Первые 350 мс после открытия экрана App гасит нажатия (защита от двойного тапа). Активный вуз выбран сразу,
  // поэтому выжидаем это окно, а не повторяем нажатия: повторное нажатие на сайт добавило бы второе подключение.
  await page.waitForTimeout(400);
  await page.getByRole("region", { name: "Вуз" }).getByRole("button", { name: "ВШЭ", exact: true }).click();
  await expect(page.getByText("Выбран: ВШЭ")).toBeVisible();
}

test("Smart LMS: calendar link is offered first with instructions and connects", async ({ page }) => {
  const api = await hseApi(page);
  await openConnect(page);
  await page.locator('[data-preset="edu.hse.ru"]').click();
  const form = page.getByRole("region", { name: "Вход" });
  await expect(form).toHaveAttribute("data-auth-method", "calendar_url");
  await expect(form.getByRole("button", { name: "Ссылка экспорта календаря (iCal)" })).toBeInViewport();
  await expect(form.locator('[data-note="sso_login_only"]')).toContainText("единый вход ВШЭ");
  await expect(form.locator('[data-note="moodle_calendar_export"]')).toContainText("Экспорт календаря");
  const submit = form.getByRole("button", { name: "Подключить" });
  await expect(submit).toBeDisabled();
  await form.getByLabel("Ссылка календаря").fill(" https://edu.hse.ru/calendar/export_execute.php?userid=1&authtoken=SYNTHETIC ");
  await submit.click();
  await expect(page.getByRole("status")).toContainText("подключён");
  expect(api.added).toEqual([{ sourceUrl: "https://edu.hse.ru/", kind: "lms", label: "Smart LMS" }]);
  expect(api.auth).toEqual([{ origin: "https://edu.hse.ru", calendarUrl: "https://edu.hse.ru/calendar/export_execute.php?userid=1&authtoken=SYNTHETIC" }]);
  await expect(page.getByRole("region", { name: "Подключённые сайты" })).toContainText("Подключено");
});

test("Smart LMS: the password form warns that the HSE single sign-on password will not work", async ({ page }) => {
  const api = await hseApi(page);
  await openConnect(page);
  await page.locator('[data-preset="edu.hse.ru"]').click();
  const form = page.getByRole("region", { name: "Вход" });
  await form.getByRole("button", { name: "Логин и пароль Moodle" }).click();
  await expect(form).toHaveAttribute("data-auth-method", "moodle_password");
  await expect(form.locator('[data-note="local_accounts_only"]')).toContainText("локальная учётная запись");
  await form.getByLabel("Логин").fill("student");
  await form.getByLabel("Пароль").fill("synthetic-password");
  await form.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByRole("status")).toContainText("подключён");
  expect(api.auth).toEqual([{ origin: "https://edu.hse.ru", username: "student", password: "synthetic-password" }]);
});

test("RUZ: identifier form, and outside the HSE network the reason is explained", async ({ page }) => {
  const api = await hseApi(page);
  await openConnect(page);
  await page.locator('[data-preset="ruz.hse.ru"]').click();
  const form = page.getByRole("region", { name: "Вход" });
  await expect(form).toHaveAttribute("data-auth-method", "ruz_identifier");
  await expect(form.locator('[data-note="university_network_only"]')).toContainText("HSE.Student");
  await form.getByLabel("Почта вуза, ФИО или номер в РУЗ").fill("student@edu.hse.ru");
  await form.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByRole("alert")).toContainText("только из сети вуза");
  expect(api.auth).toEqual([{ origin: "https://ruz.hse.ru", identifier: "student@edu.hse.ru" }]);
  await expect(page.getByRole("region", { name: "Подключённые сайты" })).toContainText("Только из сети вуза");
});
