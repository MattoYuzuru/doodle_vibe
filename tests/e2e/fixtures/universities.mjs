import { test } from "@playwright/test";

// Синтетический /api/v1 для экрана «Вузы» (ADR-0005, docs/architecture/auth-sessions-contract.md): пространства,
// источники, discovery, способы входа, login-сессии (удалённый браузер и пароль+MFA), тикет и WebSocket кадров.
// Внешние адреса блокируются. Это протокол и поведение UI, а не вход в настоящий вуз.
const H = 3600e3;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
export const CODE = "123456";

const METHODS = {
  remote_login: { id: "remote_login", type: "remote_login", label: "Вход в браузере", fields: [] },
  sso_password: { id: "sso_password", type: "sso_password", label: "Логин и пароль ВШЭ с кодом MFA", fields: ["username", "password"] },
  moodle_password: { id: "moodle_password", type: "password", label: "Логин и пароль Moodle", fields: ["username", "password"] },
  moodle_token: { id: "moodle_token", type: "token", label: "Токен Moodle", fields: ["token"] },
  calendar_url: { id: "calendar_url", type: "calendar_url", label: "Ссылка экспорта календаря (iCal)", fields: ["calendarUrl"], note: "moodle_calendar_export" },
  ruz: { id: "ruz_identifier", type: "identifier", label: "Почта, ФИО или номер студента в РУЗ", fields: ["identifier"], notes: ["university_network_only"] },
};
const BY_HOST = {
  "edu.hse.ru": [METHODS.remote_login, METHODS.sso_password, { ...METHODS.calendar_url, note: "moodle_calendar_export" }],
  "ruz.hse.ru": [METHODS.ruz],
  "newlms.misis.ru": [METHODS.moodle_password, METHODS.moodle_token, METHODS.calendar_url],
  "my.centraluniversity.ru": [METHODS.remote_login],
  "lms.example.test": [METHODS.remote_login, METHODS.moodle_password, METHODS.moodle_token, METHODS.calendar_url],
};

const dataFor = (connection) => {
  const sourceUrl = connection.sourceUrl;
  const mk = (id, title, extra) => ({ id: `${connection.id}:${id}`, externalId: id, connectionId: connection.id, title, url: `${sourceUrl}item/${id}`, sourceUrl, fetchedAt: iso(-H), ...extra });
  const host = new URL(sourceUrl).host;
  return {
    schedule: [mk("l1", `Лекция · ${host}`, { startsAt: iso(2 * H), endsAt: iso(3.5 * H), location: "Аудитория 305" })],
    deadlines: [mk("d1", `Эссе · ${host}`, { dueAt: iso(30 * H) })],
    courses: [mk("k1", `Курс: Теория вероятностей · ${host}`, { courseId: "k1" })],
    documents: [{ id: `${connection.id}:doc`, connectionId: connection.id, url: `${sourceUrl}docs/1`, title: `Положение · ${host}`, text: "Текст положения для проверки отображения документов.", fetchedAt: iso(-H) }],
  };
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {boolean} [options.chromium=true] Есть ли на сервере Chromium: без него authMethods не содержит remote_login/sso_password.
 * @param {object[]} [options.spaces] Уже существующие пространства.
 */
export async function universitiesApi(page, { chromium = true, spaces = [] } = {}) {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const state = {
    spaces: [...spaces], connections: [], logins: new Map(), jobs: new Map(), sessions: new Set(), tickets: new Set(), nextId: 1,
    requests: [], stale: new Set(), streams: [], messages: [], unexpected: [], failSync: new Set(), discoverStatus: {}, mfaFailures: 0, startError: null,
  };
  const id = (prefix) => `${prefix}-${state.nextId++}`;
  const methodsOf = (connection) => (BY_HOST[new URL(connection.sourceUrl).host] ?? [METHODS.moodle_password, METHODS.calendar_url])
    .filter((m) => chromium || !["remote_login", "sso_password"].includes(m.type));
  const connection = (cid) => state.connections.find((c) => c.id === cid);
  const job = (c, type) => {
    const j = { id: id("job"), spaceId: c.spaceId, connectionId: c.id, type, status: "succeeded", errorCode: null, result: null, attempts: 1, createdAt: iso(0), updatedAt: iso(0) };
    state.jobs.set(j.id, j);
    return j;
  };
  const touch = (c, patch) => Object.assign(c, patch, { updatedAt: iso(0) });
  const activeLogin = (cid) => [...state.logins.values()].find((l) => l.connectionId === cid && !["succeeded", "failed", "cancelled", "expired"].includes(l.status)) ?? null;
  const finishLogin = (login) => {
    login.status = "succeeded";
    state.sessions.add(login.connectionId);
    touch(connection(login.connectionId), { status: "ready", errorCode: null });
    state.streams.forEach((s) => s.loginId === login.id && s.sendStatus());
  };

  const api = {
    state,
    login: (cid) => activeLogin(cid) ?? [...state.logins.values()].filter((l) => l.connectionId === cid).at(-1),
    /** Человек в кадре вошёл: сессия сохранена, подключение готово. */
    completeLogin: (login) => finishLogin(login),
    expireSession: (cid) => { state.sessions.delete(cid); touch(connection(cid), { status: "user_action_required", errorCode: "source_session_expired" }); },
    setStatus: (cid, status, errorCode = null) => touch(connection(cid), { status, errorCode }),
    sendFrame: async () => {
      const b64 = await page.evaluate(() => {
        const c = document.createElement("canvas"); c.width = 480; c.height = 640;
        const g = c.getContext("2d"); g.fillStyle = "#e8eefc"; g.fillRect(0, 0, 480, 640);
        g.fillStyle = "#2f7bf6"; g.fillRect(40, 300, 400, 56); g.fillStyle = "#fff"; g.font = "28px sans-serif"; g.fillText("Вход в вуз", 150, 338);
        return c.toDataURL("image/jpeg", 0.6).split(",")[1];
      });
      for (const s of state.streams) s.sendFrame(Buffer.from(b64, "base64"));
    },
  };

  const publicLogin = (l) => ({ ...l, secret: undefined, _password: undefined });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const p = url.pathname, method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    const fail = (code, status) => send({ error: { code, requestId: "r" } }, status);
    state.requests.push(`${method} ${p}`);
    let m;
    if (p === "/api/v1/spaces" && method === "GET") return send({ spaces: state.spaces });
    if (p === "/api/v1/spaces" && method === "POST") {
      const body = request.postDataJSON();
      const space = { id: id("s"), universityId: body.universityId, name: body.name, createdAt: iso(0) };
      state.spaces.push(space);
      return send({ space }, 201);
    }
    if ((m = p.match(/^\/api\/v1\/spaces\/([^/]+)\/connections$/))) {
      if (method === "GET") return send({ connections: state.connections.filter((c) => c.spaceId === m[1]) });
      const body = request.postDataJSON();
      const c = { id: id("c"), spaceId: m[1], sourceUrl: body.sourceUrl, kind: body.kind, label: body.label ?? "", status: "pending", errorCode: null, adapterId: null, createdAt: iso(0), updatedAt: iso(0) };
      state.connections.push(c);
      const j = job(c, "discover");
      // Discovery закончился сразу: источнику нужен вход (или он готов, если вход не требуется).
      const preset = state.discoverStatus[new URL(c.sourceUrl).host];
      touch(c, preset ?? { status: "user_action_required", errorCode: null });
      return send({ connection: c, job: { ...j, status: "queued" } }, 202);
    }
    if ((m = p.match(/^\/api\/v1\/spaces\/([^/]+)\/(schedule|deadlines|courses|documents)$/))) {
      const [, spaceId, kind] = m;
      const ready = state.connections.filter((c) => c.spaceId === spaceId && state.sessions.has(c.id));
      if (kind === "documents") return send({ documents: ready.flatMap((c) => dataFor(c).documents), kind: "source_documents" });
      const sources = ready.map((c) => ({ connectionId: c.id, fetchedAt: iso(-(state.stale?.has(c.id) ? 30 : 1) * H), stale: !!state.stale?.has(c.id) }));
      return send({ spaceId, items: ready.flatMap((c) => dataFor(c)[kind]), sources, connections: state.connections.filter((c) => c.spaceId === spaceId) });
    }
    if ((m = p.match(/^\/api\/v1\/connections\/([^/]+)(?:\/(auth|sync|discover|login))?$/))) {
      const c = connection(m[1]);
      if (!c) return fail("NOT_FOUND", 404);
      const action = m[2];
      if (!action && method === "GET") return send({ connection: c, authMethods: methodsOf(c), login: (() => { const l = activeLogin(c.id); return l ? publicLogin(l) : null; })() });
      if (!action && method === "DELETE") { state.connections.splice(state.connections.indexOf(c), 1); state.sessions.delete(c.id); return send({ deleted: true }); }
      if (action === "sync") {
        if (state.failSync.has(c.id)) { touch(c, { status: "error", errorCode: "source_unavailable" }); return send({ job: job(c, "sync") }, 202); }
        if (!state.sessions.has(c.id) && c.status !== "ready") return send({ job: job(c, "sync") }, 202);
        return send({ job: job(c, "sync") }, 202);
      }
      if (action === "auth") {
        const body = request.postDataJSON();
        state.messages.push({ route: "auth", body });
        const bad = body.password === "wrong" || body.token === "wrong";
        if (bad) { touch(c, { status: "user_action_required", errorCode: "source_auth_required" }); return send({ saved: true, job: job(c, "sync") }, 202); }
        state.sessions.add(c.id); touch(c, { status: "ready", errorCode: null });
        return send({ saved: true, job: job(c, "sync") }, 202);
      }
      if (action === "login") {
        const body = request.postDataJSON();
        state.messages.push({ route: "login", body: { ...body, password: body.password ? "[redacted]" : undefined } });
        if (!chromium) return fail("LOGIN_UNAVAILABLE", 409);
        if (state.startError) return fail(state.startError, 429);
        for (const old of state.logins.values()) if (old.connectionId === c.id && !["succeeded", "failed", "cancelled", "expired"].includes(old.status)) old.status = "cancelled";
        const login = {
          id: id("L"), connectionId: c.id, mode: body.mode, status: body.mode === "password" ? "awaiting_mfa" : "awaiting_user", errorCode: null,
          createdAt: iso(0), expiresAt: iso(10 * 60e3), idleExpiresAt: iso(2 * 60e3), viewport: { width: 480, height: 640 }, url: "https://saml.hse.ru/login",
          mfa: body.mode === "password" ? { kind: "totp", attemptsLeft: 3 } : null,
        };
        state.logins.set(login.id, login);
        return send({ login: publicLogin(login) }, 201);
      }
    }
    if ((m = p.match(/^\/api\/v1\/login\/([^/]+)(?:\/(mfa|handoff|cancel|ticket))?$/))) {
      const l = state.logins.get(m[1]);
      if (!l) return fail("NOT_FOUND", 404);
      const action = m[2];
      if (!action) return send({ login: publicLogin(l) });
      if (action === "ticket") {
        const ticket = `t-${state.nextId++}`;
        state.tickets.add(ticket);
        return send({ ticket, expiresAt: iso(30e3), path: `/api/v1/login/${l.id}/stream?ticket=${ticket}` });
      }
      if (action === "cancel") { l.status = "cancelled"; return send({ login: publicLogin(l) }); }
      if (action === "handoff") { l.status = "awaiting_user"; l.mode = "password"; l.mfa = null; return send({ login: publicLogin(l) }); }
      if (action === "mfa") {
        if (l.status !== "awaiting_mfa") return fail("LOGIN_NOT_WAITING_MFA", 409);
        const body = request.postDataJSON();
        state.messages.push({ route: "mfa", body: { code: body.code } });
        if (body.code === CODE) { l.status = "capturing"; setTimeout(() => finishLogin(l), 50); return send({ login: publicLogin(l) }, 202); }
        l.mfa.attemptsLeft -= 1;
        if (l.mfa.attemptsLeft <= 0) { l.status = "failed"; l.errorCode = "mfa_failed"; l.mfa = null; }
        return send({ login: publicLogin(l) }, 202);
      }
    }
    if ((m = p.match(/^\/api\/v1\/jobs\/([^/]+)$/))) {
      const j = state.jobs.get(m[1]);
      return j ? send({ job: j }) : fail("NOT_FOUND", 404);
    }
    state.unexpected.push(`${method} ${p}`);
    return fail("NOT_FOUND", 404);
  });

  await page.routeWebSocket(/\/api\/v1\/login\/[^/]+\/stream/, (ws) => {
    const url = new URL(ws.url());
    const loginId = url.pathname.split("/")[4];
    const ticket = url.searchParams.get("ticket");
    if (!ticket || !state.tickets.delete(ticket)) { ws.close({ code: 4401, reason: "ticket" }); return; }
    const login = state.logins.get(loginId);
    const stream = {
      loginId, received: [], ws,
      sendFrame: (buffer) => ws.send(buffer),
      sendStatus: () => ws.send(JSON.stringify({ type: "status", login: publicLogin(login) })),
    };
    state.streams.push(stream);
    ws.send(JSON.stringify({ type: "hello", width: 480, height: 640 }));
    ws.onMessage((message) => { try { stream.received.push(JSON.parse(String(message))); } catch { /* бинарного ввода нет */ } });
    ws.onClose(() => { state.streams.splice(state.streams.indexOf(stream), 1); });
  });
  return api;
}
