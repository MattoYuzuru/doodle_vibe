import { test, expect } from "@playwright/test";

// DES-010: приложение с новым backend (platformApi "/api/v1") на синтетическом API. Два вуза — ВШЭ и МИСИС,
// переключение без данных прежнего вуза, ошибка обновления с сохранёнными данными и подключение нового вуза.
// Живой вход в вуз, Telegram и реальный backend здесь не проверяются.
const H = 3600e3;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const SPACES = [
  { id: "s-hse", universityId: "hse", name: "ВШЭ", createdAt: iso(-10 * 24 * H) },
  { id: "s-misis", universityId: "misis", name: "МИСИС", createdAt: iso(-10 * 24 * H) },
];
const conn = (spaceId, status = "ready") => ({ id: "c-" + spaceId, spaceId, sourceUrl: "https://lms.example.test/", kind: "lms", label: "LMS", status, errorCode: null, adapterId: "moodle", createdAt: iso(-H), updatedAt: iso(-H) });
const section = (spaceId, items) => ({ spaceId, items, sources: [{ connectionId: "c-" + spaceId, fetchedAt: iso(-H), stale: false }], connections: [conn(spaceId)] });
const item = (spaceId, id, title, extra) => ({ id, externalId: id, connectionId: "c-" + spaceId, title, url: "https://lms.example.test/" + id, sourceUrl: "https://lms.example.test/", fetchedAt: iso(-H), ...extra });
const DATA = {
  "s-hse": {
    deadlines: [item("s-hse", "d1", "Эссе по экономике", { dueAt: iso(5 * H) })],
    schedule: [item("s-hse", "l1", "Микроэкономика", { startsAt: iso(30 * 60e3), endsAt: iso(110 * 60e3), location: "Покровка R205" })],
    courses: [item("s-hse", "k1", "Микроэкономика", { courseId: "k1" })],
  },
  "s-misis": {
    deadlines: [item("s-misis", "d2", "Лабораторная по физике", { dueAt: iso(2 * 24 * H) })],
    schedule: [],
    courses: [item("s-misis", "k2", "Физика", { courseId: "k2" })],
  },
};

async function platformApi(page, { spaces = SPACES, misisDelay = 0, failDeadlines = () => false } = {}) {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const created = [];
  let list = [...spaces];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    const p = url.pathname;
    if (p === "/api/me") return send({ tgId: 1, loggedIn: list.length > 0, moodle: null, group: null, groupCandidates: [], subgroup: "1", variant: null, labsAllowed: false, labsOff: true, labRequest: null, isOwner: false, courseOverrides: {}, shareRemarks: false, spaces: list, platformApi: "/api/v1" });
    if (p === "/api/v1/spaces" && route.request().method() === "GET") return send({ spaces: list });
    if (p === "/api/v1/spaces" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const space = { id: "s-new-" + body.universityId, universityId: body.universityId, name: body.name, createdAt: iso(0) };
      list = [...list, space]; created.push(body);
      return send({ space }, 201);
    }
    const m = p.match(/^\/api\/v1\/spaces\/([^/]+)\/(deadlines|schedule|courses)$/);
    if (m) {
      const [, id, kind] = m;
      if (id === "s-misis" && misisDelay) await new Promise((r) => setTimeout(r, misisDelay));
      if (kind === "deadlines" && failDeadlines(id)) return send({ error: { code: "INTERNAL_ERROR", requestId: "r" } }, 500);
      const d = DATA[id];
      return send(d ? section(id, d[kind]) : { spaceId: id, items: [], sources: [], connections: [] });
    }
    if (p === "/api/cloud") return send(null);
    return send({ error: { code: "NOT_FOUND", requestId: "r" } }, 404);
  });
  return created;
}

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
  await page.getByRole("button", { name: "ВШЭ", exact: true }).click();
  await expect(page.getByText("Выбран: ВШЭ")).toBeVisible();
  await expect(page.getByLabel("Адрес сайта")).toBeVisible();
  expect(created).toEqual([{ universityId: "hse", name: "ВШЭ" }]);
  await page.getByLabel("Адрес сайта").fill("http://lms.example.test/?token=1");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByRole("alert")).toContainText("https://");
});
