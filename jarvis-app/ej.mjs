// Электронный журнал МИСИС (ej.misis.ru): посещаемость и успеваемость студента.
// Вход — через «MISIS ID» (OpenID Connect, id.misis.ru → форма consent-id.misis.ru → обратно в журнал) теми же почтой
// и паролем, что в Moodle. Пароль используется только во время входа и нигде не хранится: сохраняются cookies журнала и
// MISIS ID (зашифрованно, users.mjs). Пока жив вход MISIS ID («Запомнить меня»), устаревший вход в журнал обновляется
// сам, без пароля. Сервер журнала доступен только с российского адреса — на домашнем роутере для 85.143.106.23
// стоит маршрут мимо VPN (NOTES.md п. 70).
import { mfetch, retry } from "./users.mjs";

export const EJ = "https://ej.misis.ru";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/* ---------- cookies: простая банка без сторонних пакетов ---------- */
function setCookie(jar, header, url) {
  const host = new URL(url).hostname;
  const [pair, ...attrs] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return;
  const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, path: "/", expires: null };
  for (const a of attrs) {
    const [k, ...v] = a.split("="); const key = k.trim().toLowerCase(), val = v.join("=").trim();
    if (key === "domain" && val) { c.domain = val.replace(/^\./, "").toLowerCase(); c.hostOnly = false; }
    else if (key === "path" && val) c.path = val;
    else if (key === "max-age") c.expires = Date.now() + Number(val) * 1000;
    else if (key === "expires" && c.expires === null) { const t = Date.parse(val); if (!Number.isNaN(t)) c.expires = t; }
  }
  const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
  if (i >= 0) jar.splice(i, 1);
  if (c.expires === null || c.expires > Date.now()) jar.push(c);
}
function cookieHeader(jar, url) {
  const u = new URL(url), now = Date.now();
  return jar.filter((c) => (c.expires === null || c.expires > now)
    && (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith("." + c.domain))
    && u.pathname.startsWith(c.path)).map((c) => `${c.name}=${c.value}`).join("; ");
}

async function req(jar, url, { method = "GET", headers = {}, body } = {}) {
  const ck = cookieHeader(jar, url);
  const r = await mfetch(url, {
    method, body, redirect: "manual", signal: AbortSignal.timeout(25000),
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "accept-language": "ru-RU,ru;q=0.9", ...(ck ? { cookie: ck } : {}), ...headers },
  });
  for (const sc of r.headers.getSetCookie?.() || []) setCookie(jar, sc, url);
  return r;
}
/** Идём по перенаправлениям (GET), пока не дойдём до страницы. Сетевые сбои повторяются (retry), ответы — нет. */
async function follow(jar, url, max = 15) {
  for (let i = 0; i < max; i++) {
    const r = await retry(() => req(jar, url));
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { await r.arrayBuffer().catch(() => {}); url = new URL(loc, url).href; continue; }
    return { r, url };
  }
  throw new Error("Журнал зациклился на перенаправлениях");
}

/* ---------- формы MISIS ID ---------- */
// Страницы входа и согласия MISIS ID (consent-id.misis.ru) — SvelteKit с именованными действиями: кнопка «Войти»
// отправляет форму на «?/signin», «Разрешить» — на «?/allow» (formaction кнопки). На адрес самой страницы форма не
// принимается — так первая версия получала отказ «не принял почту или пароль» при верном пароле (2 окт).
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag); return m ? unescape(m[1]) : null; };
const flag = (tag, name) => new RegExp(`\\s${name}(?:\\s|=|/?>)`, "i").test(tag);
/** Поля формы парами (повторяющиеся имена — каждое значение). allChecks — флажки берём все, даже неотмеченные в HTML. */
function formFields(html, { allChecks = false } = {}) {
  const out = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0], name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !allChecks && !flag(tag, "checked")) continue;
    out.push([name, attr(tag, "value") ?? (type === "checkbox" ? "on" : "")]);
  }
  return out;
}
/** Куда отправлять форму: formaction кнопки, подходящей под want, иначе action формы, иначе сам адрес страницы. */
function formTarget(html, url, want) {
  for (const m of html.matchAll(/<button\b[^>]*>/gi)) {
    const fa = attr(m[0], "formaction");
    if (fa && (!want || want.test(fa))) return new URL(fa, url).href;
  }
  const form = /<form\b[^>]*>/i.exec(html)?.[0];
  const action = form && attr(form, "action");
  return action ? new URL(action, url).href : url;
}
/** Текст ошибки на странице: блок «text-error» формы MISIS ID, иначе узнаваемая фраза. */
const pageError = (html) => {
  const own = /class="[^"]*\btext-error\b[^"]*"[^>]*>([^<]+)</i.exec(html)?.[1]?.trim();
  if (own) return unescape(own);
  const t = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return /невер[а-я]* (логин|почт|парол|адрес|данн)[^.]{0,80}|не найден[^.]{0,60}|заблокирован[^.]{0,60}|incorrect[^.]{0,60}|invalid[^.]{0,60}/i.exec(t)?.[0]?.trim() || null;
};
/** POST формы как браузер без JS: Origin своего сайта (проверка CSRF у SvelteKit), ответ — перенаправление или страница. */
async function postForm(jar, url, pairs, referer) {
  const r = await req(jar, url, { method: "POST", headers: { origin: new URL(url).origin, referer, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(pairs).toString() });
  const loc = r.headers.get("location");
  const text = await r.text().catch(() => "");
  return { status: r.status, loc: r.status >= 300 && r.status < 400 && loc ? new URL(loc, url).href : null, text };
}

/** Есть ли у банки живой вход в журнал: /auth/session отдаёт пользователя. */
export async function sessionUser(jar) {
  const r = await retry(() => req(jar, `${EJ}/auth/session`, { headers: { accept: "application/json" } }));
  if (r.status !== 200) return null;
  const j = await r.json().catch(() => null);
  return j?.user ? j.user : null;
}

/**
 * Вход в журнал. С паролем — полный вход через форму MISIS ID; без пароля — «тихий» вход по cookies MISIS ID из банки
 * (если вход MISIS ID ещё жив, форма не показывается). Возвращает { jar, user }; при неудаче — ошибка с понятным текстом.
 */
export async function login({ jar = [], email, password } = {}) {
  // 1. Кнопка «Войти через MISIS ID» в журнале: POST /auth/signin/misis_id → адрес авторизации id.misis.ru (PKCE).
  const start = await retry(() => req(jar, `${EJ}/auth/signin/misis_id`, {
    method: "POST", headers: { origin: EJ, referer: `${EJ}/signin`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ callbackUrl: `${EJ}/` }).toString(),
  }));
  const authUrl = start.headers.get("location");
  await start.arrayBuffer().catch(() => {});
  if (!authUrl || /\/auth\/error/.test(authUrl)) throw new Error("Журнал не начал вход через MISIS ID — возможно, техработы");
  // 2. По перенаправлениям: либо форма входа MISIS ID, либо (вход MISIS ID жив) сразу обратно в журнал.
  let { r, url } = await follow(jar, new URL(authUrl, EJ).href);
  let html = await r.text();
  if (/\/auth\/signin\?login_challenge=/.test(url)) {
    if (!password) throw Object.assign(new Error("Нужен пароль: вход MISIS ID истёк"), { code: "need_password" });
    // 3. Форма входа: скрытый loginChallenge + почта, пароль, «Запомнить меня» — на действие кнопки «Войти» (?/signin).
    const challenge = formFields(html).find(([k]) => k === "loginChallenge")?.[1] || new URL(url).searchParams.get("login_challenge") || "";
    const post = await postForm(jar, formTarget(html, url, /signin/i), [["loginChallenge", challenge], ["email", email], ["password", password], ["remember", "1"]], url);
    if (!post.loc) {
      const msg = pageError(post.text);
      throw Object.assign(new Error(msg ? `MISIS ID: ${msg}` : `MISIS ID не принял почту или пароль (ответ ${post.status})`), { code: "bad_credentials", status: post.status });
    }
    ({ r, url } = await follow(jar, post.loc));
    html = await r.text();
  }
  // 4. Согласие на доступ журнала к данным MISIS ID (спрашивается при первом входе): форма как есть — скрытый
  // consentChallenge, все области (grantScope; на странице они скрыты и отмечены скриптом), «запомнить» — на «?/allow».
  // Области — значения флажков grantScope; если страница их не отдала, — те, что журнал запросил (scope из шага 1).
  const asked = (new URL(authUrl, EJ).searchParams.get("scope") || "openid profile email").split(/[\s+]+/).filter(Boolean);
  for (let i = 0; i < 2 && /consent_challenge=/.test(url); i++) {
    let pairs = formFields(html, { allChecks: true });
    const granted = pairs.filter(([k, v]) => k === "grantScope" && v && v !== "on").map(([, v]) => v);
    pairs = pairs.filter(([k]) => k !== "grantScope").concat((granted.length ? granted : asked).map((s) => ["grantScope", s]));
    if (!pairs.some(([k]) => k === "consentChallenge")) pairs.push(["consentChallenge", new URL(url).searchParams.get("consent_challenge") || ""]);
    const post = await postForm(jar, formTarget(html, url, /allow|accept/i), pairs, url);
    if (!post.loc) { const msg = pageError(post.text); throw new Error(`MISIS ID не принял согласие на доступ к журналу${msg ? `: ${msg}` : ` (ответ ${post.status})`}`); }
    ({ r, url } = await follow(jar, post.loc));
    html = await r.text();
  }
  // 5. Вернулись в журнал (обработчик /auth/callback поставил вход) — проверяем.
  const user = await sessionUser(jar);
  if (!user) throw new Error(`Вход в журнал не завершился (остановились на ${new URL(url).hostname}${new URL(url).pathname})`);
  return { jar, user };
}

/** Публичная часть банки для хранения: только нужные домены, без просроченных. */
export const keepJar = (jar) => jar.filter((c) => /(^|\.)misis\.ru$/.test(c.domain) && (c.expires === null || c.expires > Date.now()));

/* ---------- вход пользователя бота ---------- */
// Ленивая загрузка users.mjs-функций хранения, чтобы не было круговой зависимости при старте.
const store = () => import("./users.mjs");

/** Подключить журнал: почта и пароль MISIS ID (те же, что в Moodle). Пароль дальше этой функции не живёт. */
export async function connect(tgId, email, password) {
  const { setEj } = await store();
  try {
    const { jar, user } = await login({ email, password });
    await setEj(tgId, keepJar(jar));
    return user;
  } catch (e) {
    await setEj(tgId, undefined, e.message);
    throw e;
  }
}

/**
 * Живая банка пользователя: проверенный вход в журнал; устаревший — обновляется по cookies MISIS ID без пароля.
 * Ошибка с code "need_connect" (журнал не подключён) или "need_password" (вход MISIS ID истёк — нужен пароль один раз).
 */
const refreshing = new Map(); // tgId → идущее обновление (параллельные запросы ждут одного)
/** fresh — войти заново, даже если /auth/session ещё отвечает (сайт пускает, а его API уже нет: истёк ключ доступа внутри входа). */
export async function session(tgId, { fresh = false } = {}) {
  const { ejJar, setEj } = await store();
  const jar = await ejJar(tgId);
  if (!jar) throw Object.assign(new Error("Журнал не подключён"), { code: "need_connect" });
  if (!fresh && await sessionUser(jar)) return jar;
  if (!refreshing.has(tgId)) {
    refreshing.set(tgId, (async () => {
      try { const r = await login({ jar }); await setEj(tgId, keepJar(r.jar)); return r.jar; }
      catch (e) { if (e.code === "need_password") await setEj(tgId, undefined, "Вход MISIS ID истёк — нужен пароль"); throw e; }
      finally { refreshing.delete(tgId); }
    })());
  }
  return refreshing.get(tgId);
}

/* ---------- данные журнала ---------- */
// Как устроен журнал (разобрано по коду самого сайта, NOTES.md п. 70): страница /student перенаправляет на текущий семестр
// (/student/osenniy_388 — семестр и id учебного года), её данные — id студента, учебный год, семестр, группа. Дальше сайт
// ходит в своё API /api/v2/student/<id>/...: список дисциплин семестра с процентами (посещаемость, итоговый рейтинг, темп
// освоения) и по каждой дисциплине журнал целиком — занятия с отметками присутствия, работы с оценками.

const expired = () => Object.assign(new Error("Вход в журнал устарел"), { code: "expired" });

/**
 * SvelteKit отдаёт данные страницы в /__data.json, упакованными devalue (массив значений со ссылками по номерам).
 * Распаковка — без сторонних пакетов. Обещание (данные, которые страница досылает следом) — заглушка { __promise: id }.
 */
export function unflatten(values) {
  if (!Array.isArray(values)) return values;
  const out = new Array(values.length), done = new Array(values.length).fill(false);
  const h = (i) => {
    if (i === -1) return undefined; if (i === -3) return NaN; if (i === -4) return Infinity; if (i === -5) return -Infinity; if (i === -6) return -0;
    if (done[i]) return out[i];
    done[i] = true;
    const v = values[i];
    if (v === null || typeof v !== "object") return (out[i] = v);
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") { // особые типы devalue
        const [type, ...rest] = v;
        if (type === "Date") return (out[i] = rest[0]);
        if (type === "Set") return (out[i] = rest.map(h));
        if (type === "Map") { const m = {}; for (let k = 0; k < rest.length; k += 2) m[String(h(rest[k]))] = h(rest[k + 1]); return (out[i] = m); }
        if (type === "BigInt") return (out[i] = rest[0]);
        if (type === "Promise") return (out[i] = { __promise: h(rest[0]) });
        if (type === "null") { const o = {}; out[i] = o; for (let k = 0; k < rest.length; k += 2) o[rest[k]] = h(rest[k + 1]); return o; }
        return (out[i] = v);
      }
      const arr = []; out[i] = arr; v.forEach((n, j) => { if (n !== -2) arr[j] = h(n); }); return arr;
    }
    const obj = {}; out[i] = obj; for (const [k, n] of Object.entries(v)) obj[k] = h(n); return obj;
  };
  return h(0);
}

/**
 * Данные страницы журнала: узлы __data.json, распакованные. Ответ — строки JSON: первая — узлы страницы, следующие —
 * досланные обещания (их подставляем на место заглушек). Перенаправление страницы (/student → текущий семестр) проходим
 * сами; перенаправление на вход — значит, вход устарел. Возвращает { path, nodes }, path — после перенаправлений.
 */
export async function pageData(jar, path, hops = 3) {
  const r = await retry(() => req(jar, `${EJ}${path.replace(/\/$/, "")}/__data.json`, { headers: { accept: "application/json" } }));
  if (r.status >= 300 && r.status < 400) { await r.arrayBuffer().catch(() => {}); throw expired(); }
  const lines = (await r.text()).split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const head = lines[0];
  if (head?.type === "redirect") {
    const to = new URL(head.location, EJ);
    if (/^\/(signin|auth)(\/|$)/.test(to.pathname)) throw expired();
    if (hops <= 0) throw new Error("Журнал зациклился на перенаправлениях");
    return pageData(jar, to.pathname, hops - 1);
  }
  if (head?.type !== "data") throw new Error(`Журнал ответил не данными (${r.status})`);
  const chunks = new Map(lines.slice(1).filter((c) => c?.type === "chunk").map((c) => [c.id, "data" in c ? unflatten(c.data) : null]));
  const seen = new Set();
  const fill = (v) => {
    if (!v || typeof v !== "object" || seen.has(v)) return v;
    seen.add(v);
    if (typeof v.__promise === "number") return chunks.get(v.__promise) ?? null;
    for (const k of Object.keys(v)) v[k] = fill(v[k]);
    return v;
  };
  return { path, nodes: (head.nodes || []).map((n) => (n && n.type === "data" ? fill(unflatten(n.data)) : null)) };
}

/** Запрос к API журнала — тому же, которым пользуется сам сайт (/api/v2/<роль>/<id>/...). */
async function apiGet(jar, path) {
  const r = await retry(() => req(jar, `${EJ}${path}`, { headers: { accept: "application/json" } }));
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) { await r.arrayBuffer().catch(() => {}); throw expired(); }
  let j; try { j = JSON.parse(await r.text()); } catch { j = undefined; }
  if (r.status !== 200 || j === undefined) throw new Error(`Журнал: ${j?.message || j?.detail || `ошибка ${r.status}`}`);
  return j;
}

/** Не больше n запросов сразу: журнал — сервер вуза, залпом его не нагружаем. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Типы занятий и работ (workTypes на сайте), формы контроля (Journal.types), семестры (AcademicYear.types).
const KIND = { 1: "Лекция", 2: "Лабораторная", 3: "Практика", 39: "Контрольное мероприятие", 40: "Работа" };
const SHORT = { 1: "Л", 2: "Лаб", 3: "П", 39: "КМ", 40: "ВР" };
const CONTROL = { 1: "Экзамен", 2: "Зачёт с оценкой", 3: "Зачёт" };
const SEMESTER = { osenniy: "Осенний", vesenniy: "Весенний" };
const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const time = (d) => { const t = Date.parse(d ?? ""); return Number.isNaN(t) ? null : t; };

/**
 * Одна дисциплина. Проценты — как их считает сам журнал (statistic из списка дисциплин); подробности — из журнала
 * дисциплины по тем же правилам, что на его страницах «Посещаемость» и «Успеваемость».
 */
function subject(item, j, studId, now) {
  const st = item?.statistic || {};
  const s = {
    id: item.id,
    name: String(item.subject_name || j?.subject_name || "Дисциплина").trim(),
    teachers: [...new Set((item.workers || j?.workers || []).map((w) => w?.worker_name || w?.fio).filter(Boolean))],
    attendance: round1(num(st.attendance)), rating: round1(num(st.final_rating)),
    track: round1(num(st.completion_track)), trackInDate: round1(num(st.completion_track_in_date)),
    control: CONTROL[j?.control_form] ?? null, grade: null, thresholds: null,
    lessons: null, absences: [], works: [], error: null,
  };
  if (!j || j.__error) return { ...s, error: j?.__error || "Журнал дисциплины не загрузился" };

  // Посещаемость. Подгруппа студента — как на сайте: своя из журнала, иначе из списка студентов.
  const me = (j.students || []).find((x) => x?.stud_id === studId);
  const sub = j.my_subgroup?.id ?? me?.subgroup?.id ?? null;
  // Занятия с датой — общие и своей подгруппы; одно занятие (тип + номер) — один раз, своя подгруппа важнее.
  const slots = new Map();
  for (const x of j.attendance_slots || []) {
    if (!x?.date || (sub != null && x.subgroup_id != null && x.subgroup_id !== sub)) continue;
    const key = `${x.type_id}:${x.order_row}`, prev = slots.get(key);
    if (!prev || (x.subgroup_id === sub && prev.subgroup_id !== sub)) slots.set(key, x);
  }
  const marks = new Map(); // занятие → последняя отметка студента (как findLast на сайте)
  for (const a of j.attendance_students || []) if (a?.student_id === studId) marks.set(a.attendance_slot_id, a);
  const lessons = { past: 0, present: 0, absent: 0, unmarked: 0, missedHours: 0 };
  for (const x of [...slots.values()].sort((a, b) => time(a.date) - time(b.date))) {
    const v = marks.get(x.id)?.is_present;
    if (v == null) { if (time(x.date) <= now) { lessons.past++; lessons.unmarked++; } continue; }
    lessons.past++;
    if (v) { lessons.present++; continue; }
    const hours = (x.works || []).reduce((h, w) => h + (num(w?.hours) || 0), 0);
    lessons.absent++; lessons.missedHours += hours;
    s.absences.push({ date: x.date, kind: KIND[x.type_id] ?? "Занятие", n: num(x.order_row), hours });
  }
  s.lessons = lessons;

  // Успеваемость: работы с датой (без даты сайт их не показывает и в рейтинг не берёт) и оценка студента за каждую.
  const got = new Map();
  for (const p of j.performance_students || []) if (p?.student_id === studId && !got.has(p.performance_work_id)) got.set(p.performance_work_id, p);
  const works = (j.performance_works || []).filter((w) => w?.date).sort((a, b) => time(a.date) - time(b.date));
  let failed = false;
  s.works = works.map((w) => {
    const mark = num(got.get(w.id)?.mark), max = num(w.scale), fail = num(w.failure);
    const bad = mark != null && fail != null && mark <= fail;
    if (bad) failed = true;
    return { name: String(w.name || "").trim() || `${SHORT[w.type_id] ?? "Работа"} ${w.order_row ?? ""}`.trim(), kind: SHORT[w.type_id] ?? "", n: num(w.order_row), date: w.date, mark, max, failed: bad };
  });
  // Итоговый рейтинг — как на странице «Успеваемость» (нужен, если в списке дисциплин его нет): вес работы = её часы /
  // часы всех работ того же типа × важность типа (контрольные мероприятия / выполняемые работы); рейтинг = Σ оценка / максимум × вес.
  const imp = { 39: num(j.control_importance), 40: num(j.performed_importance) };
  const byType = {};
  for (const w of works) (byType[w.type_id] ||= []).push(w);
  let r = 0;
  for (const [t, ws] of Object.entries(byType)) {
    const total = ws.reduce((h, w) => h + (num(w.hours) || 1), 0);
    for (const w of ws) r += ((num(got.get(w.id)?.mark) ?? 0) / (num(w.scale) || 1)) * ((num(w.hours) || 1) / total) * (imp[t] ?? 0);
  }
  if (s.rating == null && works.length && Number.isFinite(r)) s.rating = round1(r * 100);
  // Пороги оценок дисциплины (доли или проценты в журнале) — в процентах рейтинга.
  const cut = (v) => { const x = num(v); return x == null ? null : x > 1 ? x / 100 : x; };
  const [p5, p4, p3] = [cut(j.perfect_mark), cut(j.good_mark), cut(j.fine_mark)];
  s.thresholds = p5 != null && p4 != null && p3 != null ? { 3: round1(p3 * 100), 4: round1(p4 * 100), 5: round1(p5 * 100) } : null;
  // Рекомендуемая оценка (как на сайте; с проваленной работой — 2) — только когда все работы семестра позади: до того
  // рейтинг считает будущие работы нулём, и в октябре везде выходило «2» (проверено на журнале владельца 2 окт).
  if (s.rating != null && s.thresholds && works.length && works.every((w) => time(w.date) <= now)) {
    const g = s.rating / 100;
    s.grade = failed ? 2 : g >= p5 ? 5 : g >= p4 ? 4 : g >= p3 ? 3 : 2;
  }
  return s;
}

function summarize({ path, ctx, list, details }) {
  const now = Date.now(), studId = ctx.studId;
  const subjects = list.map((it, i) => subject(it, details[i], studId, now)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const avg = (xs) => { const v = xs.filter((x) => typeof x === "number"); return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const year = ctx.years.find((y) => y?.id === ctx.academicYearId) ?? details.find((j) => j?.academic_year)?.academic_year;
  const yy = (d) => (time(d) == null ? null : String(new Date(d).getFullYear()).slice(-2));
  const years = [...new Set([yy(year?.start_date), yy(year?.end_date)].filter(Boolean))].join("–");
  return {
    at: new Date().toISOString(),
    path,
    semester: SEMESTER[ctx.semester] ? `${SEMESTER[ctx.semester]} семестр${years ? ` ${years} г.` : ""}` : null,
    group: ctx.group ?? list.find((it) => it?.ed_group)?.ed_group?.ed_group_name ?? null,
    summary: {
      attendance: avg(subjects.map((s) => s.attendance)),
      rating: avg(subjects.map((s) => s.rating)),
      absences: subjects.reduce((n, s) => n + s.absences.length, 0),
      missedHours: subjects.reduce((n, s) => n + (s.lessons?.missedHours || 0), 0),
    },
    subjects,
  };
}

/** Снимок сырых данных для разбора (только владельцу, на этот ПК): записи однокурсников вырезаются, секреты скрываются. */
async function dump(dir, tgId, { path, ctx, list, details }) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const studId = ctx.studId;
  const own = (arr, mine) => ({ total: arr?.length ?? 0, keys: arr?.[0] && typeof arr[0] === "object" ? Object.keys(arr[0]) : [], mine: (arr || []).filter(mine) });
  const trimmed = details.map((j) => (!j || j.__error ? j : {
    ...j,
    students: own(j.students, (x) => x?.stud_id === studId),
    attendance_students: own(j.attendance_students, (a) => a?.student_id === studId),
    performance_students: own(j.performance_students, (p) => p?.student_id === studId),
  }));
  const hide = (k, v) => (/token|secret|password|cookie/i.test(k) && typeof v === "string" ? "[скрыто]" : v);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${tgId}.json`), JSON.stringify({ at: new Date().toISOString(), path, ctx, list, details: trimmed }, hide, 2));
}

async function load(tgId, debugDir) {
  const fetchAll = async (jar) => {
    const { path, nodes } = await pageData(jar, "/student");
    // Данные страницы — как их видит сама страница, все узлы вместе. У студента (проверено 2 окт на журнале владельца):
    // корневой узел — session.currentRole { role: "student", studId, groupName } и semester / academic_year_id,
    // узел раздела — filters.academic_years; своего student_id и списка дисциплин в данных страницы нет.
    const merged = Object.assign({}, ...nodes.filter((n) => n && typeof n === "object"));
    const role = merged.session?.currentRole;
    const studId = role?.studId ?? merged.student_id;
    if (studId == null || (role?.role && role.role !== "student")) throw new Error("Журнал открылся не как у студента — у этой учётной записи другая роль");
    const base = `/api/v2/student/${studId}`;
    // Список дисциплин семестра — как его берёт сайт для самого студента: GET /journals?academic_year_id&semester.
    let list = Array.isArray(merged.journalsRequest) ? merged.journalsRequest : null;
    if (!list) {
      const q = new URLSearchParams({ academic_year_id: String(merged.academic_year_id ?? ""), semester: String(merged.semester ?? "") });
      const got = await apiGet(jar, `${base}/journals?${q}`);
      list = Array.isArray(got) ? got : got?.items ?? got?.data ?? [];
    }
    const details = await mapLimit(list, 3, (it) => apiGet(jar, `${base}/journals/${it.id}`).catch((e) => { if (e.code === "expired") throw e; return { __error: e.message }; }));
    const ctx = { studId, semester: merged.semester ?? null, academicYearId: merged.academic_year_id ?? null, years: merged.filters?.academic_years || [], group: role?.groupName ?? null };
    return { path, ctx, list, details };
  };
  let raw;
  try { raw = await fetchAll(await session(tgId)); }
  catch (e) { if (e.code !== "expired") throw e; raw = await fetchAll(await session(tgId, { fresh: true })); }
  if (debugDir) await dump(debugDir, tgId, raw).catch((e) => console.log(`ej dump: ${e.message}`));
  return summarize(raw);
}

/**
 * Посещаемость и успеваемость студента за текущий семестр. Журнал меняется не чаще пар — ответ держим 10 минут
 * (кнопка «Обновить» — force), одновременные запросы одного пользователя ждут одной загрузки.
 */
const cache = new Map();    // tgId → { at, data }
const inflight = new Map(); // tgId → идущая загрузка
const TTL = 10 * 60 * 1000;
// Журнал не ответил — 2 минуты не пробуем снова (кроме «Обновить»): иначе каждое открытие вкладки ждало ~2,5 с той же
// ошибки, прежде чем показать прошлые данные (2 окт). Сетевой сбой подписан как журнал, а не Moodle (общий mfetch).
const failed = new Map();   // tgId → { at, error }
const BACKOFF = 2 * 60 * 1000;
const asJournalError = (e) => (/Moodle не отвечает/.test(e?.message || "")
  ? Object.assign(new Error("Журнал МИСИС не отвечает — показаны последние загруженные данные"), { cause: e }) : e);
export async function journal(tgId, { debugDir, force = false } = {}) {
  const c = cache.get(tgId);
  if (!force && c && Date.now() - c.at < TTL) return c.data;
  const f = failed.get(tgId);
  if (!force && f && Date.now() - f.at < BACKOFF) throw f.error;
  if (!inflight.has(tgId)) {
    inflight.set(tgId, load(tgId, debugDir)
      .then((data) => { cache.set(tgId, { at: Date.now(), data }); failed.delete(tgId); return data; })
      .catch((e) => { const err = asJournalError(e); if (err.code !== "need_password" && err.code !== "need_connect") failed.set(tgId, { at: Date.now(), error: err }); throw err; })
      .finally(() => inflight.delete(tgId)));
  }
  return inflight.get(tgId);
}
/** Забыть сохранённый ответ (журнал подключили заново или пользователь вышел). */
export const forget = (tgId) => { cache.delete(tgId); failed.delete(tgId); };
/** Последние удачно загруженные данные (сколько бы им ни было) — показать, пока журнал не отвечает. */
export const lastGood = (tgId) => cache.get(tgId)?.data ?? null;
