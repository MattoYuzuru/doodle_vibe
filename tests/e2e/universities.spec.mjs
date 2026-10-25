import { test, expect } from "@playwright/test";
import { CODE, universitiesApi } from "./fixtures/universities.mjs";

// Экран «Вузы» (#/universities) на синтетическом /api/v1: четыре раздела, предзаполненные источники, вход через удалённый
// браузер (кадры, ввод, тикет), вход паролем с MFA, токен/пароль Moodle/календарь, ошибки, устаревшие данные и «Войти снова».
// Настоящие вузы, Telegram, живой Chromium и SSO здесь не проверяются (docs/TESTING.md).
const card = (page, name) => page.locator(`[data-source-card="${name}"]`);
const open = async (page, section) => { await page.goto(`/#/universities/${section}`); await expect(page.locator("[data-universities]")).toBeVisible(); };
const shot = (page, name) => page.screenshot({ path: `artifacts/screenshots/${name}.png`, fullPage: true });
const kinds = (stream, type) => stream.received.filter((m) => m.type === type);

test("four sections: HSE, MISIS, CU and a custom university show their sources without test data", async ({ page }) => {
  await universitiesApi(page);
  await open(page, "hse");
  await expect(page.getByRole("tab")).toHaveText(["ВШЭ", "МИСИС", "ЦУ", "Свой вуз"]);
  await expect(card(page, "Smart LMS ВШЭ").getByLabel("Адрес источника")).toHaveValue("https://edu.hse.ru/");
  await expect(card(page, "РУЗ ВШЭ").getByLabel("Адрес источника")).toHaveValue("https://ruz.hse.ru/");
  await expect(card(page, "Smart LMS ВШЭ").getByRole("button", { name: "Подключить" })).toBeVisible();
  await shot(page, "01-hse");
  await page.getByRole("tab", { name: "МИСИС" }).click();
  await expect(page.getByRole("tab", { name: "МИСИС" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-university]")).toHaveAttribute("data-university", "misis");
  await expect(page.getByLabel("Адрес источника")).toHaveValue("https://newlms.misis.ru/");
  await shot(page, "02-misis");
  await page.getByRole("tab", { name: "ЦУ" }).click();
  await expect(page.getByRole("tab", { name: "ЦУ" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-university]")).toHaveAttribute("data-university", "cu");
  await expect(page.getByLabel("Адрес источника")).toHaveValue("https://my.centraluniversity.ru/");
  await shot(page, "03-cu");
  await page.getByRole("tab", { name: "Свой вуз" }).click();
  await expect(page.getByRole("tab", { name: "Свой вуз" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-university]")).toHaveAttribute("data-university", "custom");
  await expect(page.getByLabel("Адрес сайта")).toHaveValue("");
  await expect(page.getByLabel("Название вуза")).toBeVisible();
  await shot(page, "04-custom");
  await expect(page.locator("body")).not.toContainText("[ТЕСТ]");
});

test("HSE remote login: ticket, frames, mouse, keyboard and text reach the stream; the session then shows data", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "hse");
  const lms = card(page, "Smart LMS ВШЭ");
  await lms.getByRole("button", { name: "Подключить" }).click();
  // Сервер предлагает способы входа: удалённый браузер первым.
  await expect(lms.locator("[data-auth-panel]")).toHaveAttribute("data-auth-panel", "remote_login");
  await expect(lms.locator("[data-badge]")).toHaveText("Нужен вход");
  await lms.getByRole("button", { name: "Открыть браузер для входа" }).click();

  await expect(page.locator("[data-remote-viewer]")).toHaveAttribute("data-remote-viewer", "live");
  await expect.poll(() => api.state.streams.length).toBe(1);
  expect(api.state.requests.filter((r) => r.endsWith("/ticket"))).toHaveLength(1);
  await api.sendFrame();
  const canvas = page.locator("[data-remote-canvas]");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((c) => { const d = c.getContext("2d").getImageData(60, 320, 1, 1).data; return d[2] > 200 && d[0] < 100; })).toBe(true);
  await expect(page.getByText("saml.hse.ru/login")).toBeVisible();
  await shot(page, "05-hse-remote-login");

  const stream = api.state.streams[0];
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => kinds(stream, "mouse").map((m) => m.action)).toEqual(expect.arrayContaining(["move", "down", "up"]));
  const down = kinds(stream, "mouse").find((m) => m.action === "down");
  expect(Math.abs(down.x - 240)).toBeLessThanOrEqual(2);
  expect(Math.abs(down.y - 320)).toBeLessThanOrEqual(2);
  expect(down.button).toBe("left");

  await page.keyboard.type("student");
  await page.keyboard.press("Enter");
  await expect.poll(() => kinds(stream, "text").map((m) => m.text).join("")).toBe("student");
  expect(kinds(stream, "key").some((m) => m.action === "down" && m.key === "Enter")).toBe(true);
  await page.getByLabel("Текст для ввода").fill("pasted-секрет");
  await page.getByRole("button", { name: "Ввести" }).click();
  await expect.poll(() => kinds(stream, "text").some((m) => m.text === "pasted-секрет")).toBe(true);
  // Клиент передаёт только события ввода: ни адреса навигации, ни неизвестных типов.
  expect(stream.received.every((m) => ["mouse", "key", "text", "resize", "ping"].includes(m.type))).toBe(true);

  // Человек вошёл на странице вуза: сессия сохранена, UI показывает данные с временем получения.
  api.completeLogin(api.login(api.state.connections[0].id));
  const results = page.locator("[data-results]");
  await expect(results).toBeVisible({ timeout: 10_000 });
  await expect(lms.locator("[data-badge]")).toHaveText("Подключено");
  await expect(results.getByText("Лекция · edu.hse.ru")).toBeVisible();
  await expect(results.getByText(/получено .*\d/).first()).toBeVisible();
  await results.getByRole("tab", { name: /Дедлайны/ }).click();
  await expect(results.getByText("Эссе · edu.hse.ru")).toBeVisible();
  await results.getByRole("tab", { name: /Курсы/ }).click();
  await expect(results.getByText("Курс: Теория вероятностей · edu.hse.ru")).toBeVisible();
  await results.getByRole("tab", { name: /Документы/ }).click();
  await expect(results.getByText("Положение · edu.hse.ru")).toBeVisible();
  await shot(page, "06-hse-data");
  expect(api.state.unexpected).toEqual([]);
});

test("HSE password sign-in with MFA: the password never leaves the form, a wrong code shows attempts, then data", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "hse");
  const lms = card(page, "Smart LMS ВШЭ");
  await lms.getByPlaceholder("Почта вида логин@edu.hse.ru").fill("student@edu.hse.ru");
  await lms.getByPlaceholder("Пароль").fill("hunter2-secret");
  await lms.getByRole("button", { name: "Подключить" }).click();

  const mfa = page.getByRole("form", { name: "Код подтверждения" });
  await expect(mfa).toBeVisible();
  await expect(mfa).toContainText("Осталось попыток: 3");
  expect(api.state.messages.find((m) => m.route === "login").body).toMatchObject({ mode: "password", username: "student@edu.hse.ru", password: "[redacted]" });
  await shot(page, "07-hse-mfa");

  await mfa.getByLabel("Код подтверждения").fill("000000");
  await mfa.getByRole("button", { name: "Отправить код" }).click();
  await expect(mfa).toContainText("Осталось попыток: 2");
  await expect(mfa.getByLabel("Код подтверждения")).toHaveValue("");
  await mfa.getByLabel("Код подтверждения").fill(CODE);
  await mfa.getByRole("button", { name: "Отправить код" }).click();
  await expect(page.locator("[data-results]")).toBeVisible({ timeout: 10_000 });
  await expect(lms.locator("[data-badge]")).toHaveText("Подключено");

  // Пароль нигде не оседает: не в адресах запросов, не в хранилищах браузера, не в полях формы.
  expect(api.state.requests.join("\n")).not.toContain("hunter2");
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(stored).not.toContain("hunter2");
  expect(await page.locator("input").evaluateAll((els) => els.map((e) => e.value))).not.toContain("hunter2-secret");
});

test("MFA exhausted: the error is plain and the flow can start again", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "hse");
  const lms = card(page, "Smart LMS ВШЭ");
  await lms.getByPlaceholder("Почта вида логин@edu.hse.ru").fill("student@edu.hse.ru");
  await lms.getByPlaceholder("Пароль").fill("pw");
  await lms.getByRole("button", { name: "Подключить" }).click();
  const mfa = page.getByRole("form", { name: "Код подтверждения" });
  for (const left of [2, 1]) {
    await mfa.getByLabel("Код подтверждения").fill("111111");
    await mfa.getByRole("button", { name: "Отправить код" }).click();
    await expect(mfa).toContainText(`Осталось попыток: ${left}`);
  }
  await mfa.getByLabel("Код подтверждения").fill("222222");
  await mfa.getByRole("button", { name: "Отправить код" }).click();
  await expect(lms.getByRole("alert").filter({ hasText: "mfa_failed" })).toContainText("Код подтверждения не подошёл");
  await lms.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(lms.locator("[data-auth-panel]")).toBeVisible();
  expect(api.state.unexpected).toEqual([]);
});

test("the MFA step can hand over to the remote browser", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "hse");
  const lms = card(page, "Smart LMS ВШЭ");
  await lms.getByPlaceholder("Почта вида логин@edu.hse.ru").fill("s@edu.hse.ru");
  await lms.getByPlaceholder("Пароль").fill("pw");
  await lms.getByRole("button", { name: "Подключить" }).click();
  await lms.getByRole("button", { name: "Войти вручную в браузере" }).click();
  await expect(page.locator("[data-remote-viewer]")).toHaveAttribute("data-remote-viewer", "live");
  await api.sendFrame();
  await expect(page.locator("[data-remote-canvas]")).toBeVisible();
});

test("MISIS: a wrong Moodle password gives a clear error, then a token works", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "misis");
  const lms = card(page, "LMS МИСИС (Moodle)");
  await lms.getByRole("button", { name: "Подключить" }).click();
  await expect(lms.locator("[data-auth-panel]")).toHaveAttribute("data-auth-panel", "password");
  await expect(lms.getByRole("group", { name: "Способ входа" }).getByRole("button")).toHaveText(["Логин и пароль Moodle", "Токен", "Ссылка календаря"]);

  await lms.getByLabel("Логин").fill("student");
  await lms.getByLabel("Пароль").fill("wrong");
  await lms.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(lms.getByRole("alert").filter({ hasText: "source_auth_required" })).toContainText("Нужен вход");
  expect(api.state.messages.at(-1)).toEqual({ route: "auth", body: { origin: "https://newlms.misis.ru", username: "student", password: "wrong" } });

  await lms.getByRole("button", { name: "Токен", exact: true }).click();
  await lms.getByLabel("Токен").fill("tok-123");
  await lms.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(lms.locator("[data-badge]")).toHaveText("Подключено");
  await expect(page.locator("[data-results]").getByText("Лекция · newlms.misis.ru")).toBeVisible();
  await shot(page, "08-misis-data");
});

test("MISIS calendar link is the fallback path: masked field, sent verbatim", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "misis");
  const lms = card(page, "LMS МИСИС (Moodle)");
  await lms.getByRole("button", { name: "Подключить" }).click();
  await lms.getByRole("button", { name: "Ссылка календаря" }).click();
  await expect(lms.getByText(/Календарь → Импорт или экспорт/)).toBeVisible();
  const input = lms.getByLabel("Ссылка календаря");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("https://newlms.misis.ru/calendar/export_execute.php?userid=1&authtoken=abc");
  await lms.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(lms.locator("[data-badge]")).toHaveText("Подключено");
  expect(api.state.messages.at(-1).body).toEqual({ origin: "https://newlms.misis.ru", calendarUrl: "https://newlms.misis.ru/calendar/export_execute.php?userid=1&authtoken=abc" });
});

test("CU: remote login; a cooldown is explained, a cancelled login can start again", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "cu");
  const cu = card(page, "Личный кабинет ЦУ");
  await cu.getByRole("button", { name: "Подключить" }).click();
  await expect(cu.locator("[data-auth-panel]")).toHaveAttribute("data-auth-panel", "remote_login");
  api.state.startError = "LOGIN_COOLDOWN";
  await cu.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect(cu.getByRole("alert")).toContainText("Подожди 10 минут");
  await expect(cu.getByRole("alert")).toContainText("LOGIN_COOLDOWN");
  api.state.startError = null;
  await cu.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect(page.locator("[data-remote-viewer]")).toHaveAttribute("data-remote-viewer", "live");
  await shot(page, "09-cu-remote-login");
  await cu.getByRole("button", { name: "Отмена" }).click();
  await expect(cu.getByText("Вход отменён.")).toBeVisible();
  await cu.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(cu.locator("[data-auth-panel]")).toBeVisible();
});

test("without Chromium on the server only credential methods are offered", async ({ page }) => {
  await universitiesApi(page, { chromium: false });
  await open(page, "hse");
  const lms = card(page, "Smart LMS ВШЭ");
  await lms.getByRole("button", { name: "Подключить" }).click();
  await expect(lms.locator("[data-auth-panel]")).toHaveAttribute("data-auth-panel", "calendar_url");
  await expect(lms.getByRole("button", { name: "Открыть браузер для входа" })).toHaveCount(0);
});

test("custom university: a bad address is rejected, then the same flow runs from authMethods", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "custom");
  await page.getByLabel("Название вуза").fill("Тестовый университет");
  await page.getByLabel("Адрес сайта").fill("http://lms.example.test/?token=1");
  await page.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByRole("alert")).toContainText("https://");
  expect(api.state.spaces).toEqual([]);
  await page.getByLabel("Адрес сайта").fill("lms.example.test");
  await page.getByRole("button", { name: "Подключить" }).click();
  const lms = page.locator('[data-source-card][data-status]').first();
  await expect(lms.getByRole("group", { name: "Способ входа" }).getByRole("button")).toHaveText(["Войти в браузере", "Логин и пароль Moodle", "Токен", "Ссылка календаря"]);
  expect(api.state.spaces.map((s) => s.name)).toEqual(["Тестовый университет"]);
  expect(api.state.connections[0].sourceUrl).toBe("https://lms.example.test/");
  await lms.getByRole("button", { name: "Токен", exact: true }).click();
  await lms.getByLabel("Токен").fill("tok");
  await lms.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator("[data-results]")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Тестовый университет" })).toBeVisible();
  await shot(page, "10-custom-data");
});

test("a failed refresh keeps the data, marks it stale and offers to retry", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "misis");
  const lms = card(page, "LMS МИСИС (Moodle)");
  await lms.getByRole("button", { name: "Подключить" }).click();
  await lms.getByRole("button", { name: "Токен", exact: true }).click();
  await lms.getByLabel("Токен").fill("tok");
  await lms.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator("[data-results]")).toBeVisible({ timeout: 10_000 });
  const cid = api.state.connections[0].id;
  api.state.stale.add(cid);
  api.state.failSync.add(cid);
  await lms.getByRole("button", { name: "Обновить" }).click();
  await expect(lms.locator("[data-badge]")).toHaveText("Ошибка");
  await expect(lms.getByRole("alert")).toContainText("Сайт вуза недоступен");
  await expect(lms.getByRole("alert")).toContainText("source_unavailable");
  const results = page.locator("[data-results]");
  await expect(results.getByText("Лекция · newlms.misis.ru")).toBeVisible();
  await expect(results.locator('[data-fresh="stale"]').first()).toContainText("данные устарели");
  api.state.failSync.delete(cid);
  api.setStatus(cid, "ready");
  await lms.getByRole("button", { name: "Повторить" }).click();
  await expect(lms.locator("[data-badge]")).toHaveText("Подключено");
});

test("an expired session offers 'Войти снова', keeps the old data and signs in again through the remote browser", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "cu");
  const cu = card(page, "Личный кабинет ЦУ");
  await cu.getByRole("button", { name: "Подключить" }).click();
  await cu.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect.poll(() => api.state.streams.length).toBe(1);
  const cid = api.state.connections[0].id;
  api.completeLogin(api.login(cid));
  await expect(page.locator("[data-results]").getByText("Лекция · my.centraluniversity.ru")).toBeVisible({ timeout: 10_000 });

  api.expireSession(cid);
  api.state.sessions.add(cid); // прежние снимки остаются на сервере
  await page.reload();
  await expect(cu.locator("[data-badge]")).toHaveText("Сессия истекла");
  await expect(cu.getByRole("alert")).toContainText("Прежние данные сохранены");
  await expect(cu.getByRole("alert")).toContainText("source_session_expired");
  await expect(page.locator("[data-results]").getByText("Лекция · my.centraluniversity.ru")).toBeVisible();
  await shot(page, "11-cu-reauth");
  await cu.getByRole("button", { name: "Войти снова" }).click();
  await cu.getByRole("button", { name: "Войти снова" }).click();
  await expect(page.locator("[data-remote-viewer]")).toHaveAttribute("data-remote-viewer", "live");
  api.completeLogin(api.login(cid));
  await expect(cu.locator("[data-badge]")).toHaveText("Подключено", { timeout: 10_000 });
  await expect(cu.getByRole("alert")).toHaveCount(0);
});

test("a dropped stream reconnects with a fresh one-time ticket and an active login survives a reload", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "cu");
  const cu = card(page, "Личный кабинет ЦУ");
  await cu.getByRole("button", { name: "Подключить" }).click();
  await cu.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect.poll(() => api.state.streams.length).toBe(1);
  api.state.streams[0].ws.close({ code: 1006, reason: "network" });
  await expect.poll(() => api.state.requests.filter((r) => r.endsWith("/ticket")).length, { timeout: 8000 }).toBe(2);
  await expect(page.locator("[data-remote-viewer]")).toHaveAttribute("data-remote-viewer", "live");
  await page.reload();
  await expect(page.locator("[data-remote-viewer]")).toBeVisible();
  await expect.poll(() => api.state.streams.length).toBe(1);
});

test("touch: a tap clicks; the wheel scrolls the remote page", async ({ page }) => {
  const api = await universitiesApi(page);
  await open(page, "cu");
  const cu = card(page, "Личный кабинет ЦУ");
  await cu.getByRole("button", { name: "Подключить" }).click();
  await cu.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect.poll(() => api.state.streams.length).toBe(1);
  await api.sendFrame();
  const canvas = page.locator("[data-remote-canvas]");
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const stream = api.state.streams[0];
  await page.touchscreen.tap(box.x + 40, box.y + 100);
  await expect.poll(() => kinds(stream, "mouse").map((m) => m.action)).toEqual(expect.arrayContaining(["down", "up"]));
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => kinds(stream, "mouse").some((m) => m.action === "wheel" && m.dy > 0)).toBe(true);
});

test("an unreachable server is reported with a retry, not an endless spinner", async ({ page }) => {
  await page.route("**/api/v1/spaces", (route) => route.abort());
  await open(page, "hse");
  await expect(page.getByRole("alert").first()).toContainText("Сервер не отвечает");
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
});
