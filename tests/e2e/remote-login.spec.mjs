import { test, expect } from "@playwright/test";

// Вход через удалённый браузер (ADR-0005, задача C) на синтетическом /api/v1 и поддельном WebSocket потока:
// interactive (кадры и ввод), password + MFA, «Войти вручную», повторный вход после истёкшей сессии и отказ сервера.
// Настоящий Chromium, сайт вуза, SSO и данные студента не используются. Живой вход делает владелец.
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const SPACE = { id: "s-hse", universityId: "hse", name: "ВШЭ", createdAt: iso() };
const REMOTE = { id: "remote_login", type: "remote_login", label: "Войти через браузер" };
const SSO = { id: "sso_password", type: "sso_password", label: "Логин и пароль ВШЭ" };
const CAL = { id: "calendar_url", type: "calendar_url", label: "Ссылка экспорта календаря (iCal)", fields: ["calendarUrl"] };

/**
 * Поддельный backend входа. script — как меняется вход: для password после старта filling → awaiting_mfa,
 * после кода — capturing → succeeded; interactive — awaiting_user до сообщения status из потока.
 */
async function loginApi(page, { methods = [REMOTE, CAL], existing = null, startError = null } = {}) {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const calls = { start: [], mfa: [], handoff: 0, cancel: 0, tickets: 0, urls: [] };
  const conns = new Map();
  if (existing) conns.set(existing.id, existing);
  let login = null, reads = 0;
  const loginState = (status, extra = {}) => ({ id: "L1", connectionId: "c1", mode: "interactive", status, errorCode: null, createdAt: iso(), expiresAt: iso(10 * 60e3), idleExpiresAt: null, viewport: { width: 480, height: 900 }, url: "https://edu.hse.ru/login/index.php", mfa: null, ...extra });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    calls.urls.push(url.href);
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    const p = url.pathname, body = () => route.request().postDataJSON();
    const list = () => [...conns.values()];
    if (p === "/api/me") return send({ tgId: 1, loggedIn: true, moodle: null, group: null, groupCandidates: [], subgroup: "1", variant: null, labsAllowed: false, labsOff: true, labRequest: null, isOwner: false, courseOverrides: {}, shareRemarks: false, spaces: [SPACE], platformApi: "/api/v1" });
    if (p === "/api/v1/spaces") return send({ spaces: [SPACE] });
    if (/^\/api\/v1\/spaces\/s-hse\/(deadlines|schedule|courses)$/.test(p)) return send({ spaceId: SPACE.id, items: [], sources: [], connections: list() });
    if (p === "/api/v1/spaces/s-hse/connections") {
      const b = body();
      const c = { id: "c1", spaceId: SPACE.id, sourceUrl: b.sourceUrl, kind: b.kind, label: b.label ?? "", status: "user_action_required", errorCode: null, adapterId: "moodle", createdAt: iso(), updatedAt: iso() };
      conns.set(c.id, c);
      return send({ connection: c, job: { id: "j1", status: "queued" } }, 202);
    }
    if (/^\/api\/v1\/jobs\//.test(p)) return send({ job: { id: "j", status: "succeeded", errorCode: null, attempts: 1 } });
    if (p === "/api/v1/connections/c1") {
      const c = conns.get("c1");
      return send({ connection: c, authMethods: c.status === "ready" ? [] : methods, login: login && !["succeeded", "failed", "cancelled", "expired"].includes(login.status) ? login : null });
    }
    if (p === "/api/v1/connections/c1/login") {
      if (startError) return send({ error: { code: startError, requestId: "r" } }, startError === "LOGIN_UNAVAILABLE" ? 409 : 429);
      const b = body(); calls.start.push(b);
      login = b.mode === "password" ? loginState("filling", { mode: "password" }) : loginState("awaiting_user");
      return send({ login }, 201);
    }
    if (p === "/api/v1/login/L1") {
      // Password: после нескольких опросов сервер «заполнил форму» и ждёт код.
      if (login?.mode === "password" && login.status === "filling" && ++reads >= 2) login = { ...login, status: "awaiting_mfa", mfa: { kind: "totp", attemptsLeft: 3 } };
      if (login?.status === "capturing") { login = { ...login, status: "succeeded" }; conns.get("c1").status = "ready"; }
      return send({ login });
    }
    if (p === "/api/v1/login/L1/mfa") { calls.mfa.push(body()); login = { ...login, status: "capturing", mfa: null }; return send({ login }, 202); }
    if (p === "/api/v1/login/L1/handoff") { calls.handoff++; login = { ...login, status: "awaiting_user" }; return send({ login }); }
    if (p === "/api/v1/login/L1/cancel") { calls.cancel++; login = { ...login, status: "cancelled" }; return send({ login }); }
    if (p === "/api/v1/login/L1/ticket") { calls.tickets++; return send({ ticket: "ticket-" + calls.tickets, expiresAt: iso(30e3), path: "/api/v1/login/L1/stream" }); }
    if (p === "/api/cloud") return send(null);
    return send({ error: { code: "NOT_FOUND", requestId: "r" } }, 404);
  });
  return { calls, finishInteractive: () => { login = { ...login, status: "succeeded" }; conns.get("c1").status = "ready"; return login; } };
}

/** Поддельный поток: hello, один настоящий JPEG-кадр, запись присланного ввода. */
async function fakeStream(page, frame) {
  const stream = { messages: [], urls: [], server: null };
  await page.routeWebSocket(/\/api\/v1\/login\/L1\/stream/, (ws) => {
    stream.urls.push(ws.url());
    stream.server = ws;
    ws.onMessage((m) => { try { stream.messages.push(JSON.parse(String(m))); } catch { /* binary from client is not expected */ } });
    ws.send(JSON.stringify({ type: "hello", width: 480, height: 900 }));
    ws.send(frame);
  });
  return stream;
}

async function openHse(page) {
  await page.goto("/");
  await expect(page.locator('[data-space-home="s-hse"]')).toBeVisible();
  await page.getByRole("button", { name: "Подключить вуз или сайт" }).click();
  // Первые 350 мс после открытия экрана App гасит нажатия (защита от двойного тапа). Активный вуз выбран сразу,
  // поэтому выжидаем это окно, а не повторяем нажатия: повторное нажатие на сайт добавило бы второе подключение.
  await page.waitForTimeout(400);
  await page.getByRole("region", { name: "Вуз" }).getByRole("button", { name: "ВШЭ", exact: true }).click();
  await expect(page.getByText("Выбран: ВШЭ")).toBeVisible();
  await page.locator('[data-preset="edu.hse.ru"]').click();
}

test("interactive login: frames are shown, clicks and typing reach the remote browser, success connects", async ({ page }) => {
  const frame = await page.screenshot({ type: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 48, height: 90 } });
  const api = await loginApi(page);
  const stream = await fakeStream(page, frame);
  await openHse(page);
  const auth = page.getByRole("region", { name: "Вход" });
  await expect(auth).toHaveAttribute("data-auth-method", "remote_login");
  await auth.getByRole("button", { name: "Открыть браузер для входа" }).click();
  const shot = auth.getByRole("img", { name: "Экран входа на сайт вуза" });
  await expect(shot).toBeVisible();
  expect(api.calls.start).toEqual([{ mode: "interactive" }]);
  expect(stream.urls[0]).toMatch(/\/api\/v1\/login\/L1\/stream\?ticket=ticket-1$/);

  await expect.poll(async () => (await shot.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  const box = await shot.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("ivan");
  await page.keyboard.press("Enter");
  await expect.poll(() => stream.messages.filter((m) => m.type === "mouse" && m.action === "down").length).toBe(1);
  const down = stream.messages.find((m) => m.type === "mouse" && m.action === "down");
  expect(Math.abs(down.x - 240)).toBeLessThanOrEqual(2);
  expect(Math.abs(down.y - 450)).toBeLessThanOrEqual(2);
  await expect.poll(() => stream.messages.filter((m) => m.type === "text").map((m) => m.text).join("")).toBe("ivan");
  await expect.poll(() => stream.messages.some((m) => m.type === "key" && m.key === "Enter" && m.action === "down")).toBe(true);

  stream.server.send(JSON.stringify({ type: "status", login: api.finishInteractive() }));
  await expect(page.getByRole("status").filter({ hasText: "подключён" })).toBeVisible({ timeout: 10_000 });
});

test("password login with MFA: the code goes to the server, the password never into a URL", async ({ page }) => {
  const api = await loginApi(page, { methods: [SSO, REMOTE] });
  await openHse(page);
  const auth = page.getByRole("region", { name: "Вход" });
  await expect(auth).toHaveAttribute("data-auth-method", "sso_password");
  await auth.getByLabel("Логин вуза").fill("student@edu.hse.ru");
  await auth.getByLabel("Пароль").fill("synthetic-pass");
  await auth.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(auth.getByLabel(/Код подтверждения/)).toBeVisible({ timeout: 10_000 });
  await expect(auth.getByText("попыток: 3")).toBeVisible();
  const confirm = auth.getByRole("button", { name: "Подтвердить" });
  await auth.getByLabel(/Код подтверждения/).fill("12");
  await expect(confirm).toBeDisabled();
  await auth.getByLabel(/Код подтверждения/).fill("123456");
  await confirm.click();
  await expect(page.getByRole("status").filter({ hasText: "подключён" })).toBeVisible({ timeout: 15_000 });
  expect(api.calls.start).toEqual([{ mode: "password", username: "student@edu.hse.ru", password: "synthetic-pass" }]);
  expect(api.calls.mfa).toEqual([{ code: "123456" }]);
  expect(api.calls.urls.some((u) => u.includes("synthetic-pass") || u.includes("123456"))).toBe(false);
});

test("password login can be handed over to the remote browser and cancelled", async ({ page }) => {
  const frame = await page.screenshot({ type: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 48, height: 90 } });
  const api = await loginApi(page, { methods: [SSO] });
  await fakeStream(page, frame);
  await openHse(page);
  const auth = page.getByRole("region", { name: "Вход" });
  await auth.getByLabel("Логин вуза").fill("student");
  await auth.getByLabel("Пароль").fill("synthetic-pass");
  await auth.getByRole("button", { name: "Войти", exact: true }).click();
  await auth.getByRole("button", { name: "Войти вручную" }).click();
  await expect(auth.getByRole("img", { name: "Экран входа на сайт вуза" })).toBeVisible();
  expect(api.calls.handoff).toBe(1);
  await auth.getByRole("button", { name: "Отменить вход" }).click();
  await expect(auth.getByText("Вход отменён.")).toBeVisible();
  expect(api.calls.cancel).toBe(1);
});

test("an expired session offers to sign in again from the connected list", async ({ page }) => {
  const expired = { id: "c1", spaceId: "s-hse", sourceUrl: "https://edu.hse.ru/", kind: "lms", label: "Smart LMS", status: "user_action_required", errorCode: "source_session_expired", adapterId: "learned:x:1", createdAt: iso(), updatedAt: iso() };
  await loginApi(page, { existing: expired });
  await page.goto("/");
  await expect(page.locator('[data-space-home="s-hse"]').getByText("Нужен вход заново")).toBeVisible();
  await page.getByRole("button", { name: "Подключить вуз или сайт" }).click();
  const list = page.getByRole("region", { name: "Подключённые сайты" });
  await expect(list.getByText("Нужен вход заново")).toBeVisible();
  await expect(async () => {
    await list.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByRole("region", { name: "Вход" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByRole("alert")).toContainText("истёк");
  await expect(page.getByRole("region", { name: "Вход" }).getByRole("button", { name: "Открыть браузер для входа" })).toBeVisible();
});

test("the server without a browser runtime explains it instead of hanging", async ({ page }) => {
  await loginApi(page, { startError: "LOGIN_UNAVAILABLE" });
  await openHse(page);
  const auth = page.getByRole("region", { name: "Вход" });
  await auth.getByRole("button", { name: "Открыть браузер для входа" }).click();
  await expect(auth.getByRole("alert")).toContainText("недоступен");
  await auth.getByRole("button", { name: "Ссылка экспорта календаря (iCal)" }).click();
  await expect(auth.getByLabel("Ссылка календаря")).toBeVisible();
});
