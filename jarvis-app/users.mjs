// Пользователи мини-приложения. Ключ — Telegram id из подписанного initData.
// Вход: логин и пароль Moodle → у Moodle берётся персональный токен (login/token.php, как у мобильного приложения);
// пароль не сохраняется нигде, токен шифруется (AES-256-GCM, ключ в users.key) и лежит в users/<tgId>.json.
// Владелец (OWNER_ID) до первого входа пользуется старым токеном из ~/.openclaw/moodle-token.txt — но только пока не нажал
// «Выйти из Moodle» (флаг loggedOut): после выхода старый токен не подставляется, и приложение показывает форму входа.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

const DIR = dirname(fileURLToPath(import.meta.url));
const USERS = join(DIR, "users");
const KEY_FILE = join(DIR, "users.key");
export const BASE = "https://newlms.misis.ru";
export const OWNER_ID = 945210206;
// Белый список для лаб с агентом (тратят подписку Claude владельца): Telegram id через запятую в lab-allowlist.txt.
const ALLOW_FILE = join(DIR, "lab-allowlist.txt");

const readText = (p) => readFile(p, "utf8").then((t) => t.replace(/^﻿/, "").trim()).catch(() => "");

/**
 * Все обращения к Moodle идут через один пул соединений (пакет undici, тот же fetch, что встроен в Node, но с настройками):
 * не больше 3 соединений — параллельные запросы (статусы 28 работ) едут по уже пробившимся, а не открывают 28 новых;
 * мёртвое соединение стоит 1,5 с вместо 10 (живое устанавливается за ~0,13 с при RTT 91 мс); живое держим минуту про запас.
 * Без этого после входа дедлайны грузились ~40 с (замер: 28 параллельных запросов — 55 с встроенным fetch, 11 с пулом с 3 с,
 * повторный залп 0,3 с).
 */
// 6 соединений на всех пользователей сервера: при трёх запросы десяти человек стояли бы друг за другом (каждое обновление
// дедлайнов — около 35 вызовов Moodle), а больше шести — лишняя нагрузка на Moodle с одного адреса.
const agents = new Map(); // "" (обычный маршрут) | локальный адрес (прямой путь) → пул соединений
function agentFor(bind) {
  const k = bind || "";
  // localAddress — именно параметр пула: внутри connect его undici перезаписывает (проверено: привязка молча не применялась).
  // allowH2: false — только HTTP/1.1. undici 8 сам включает HTTP/2, а журнал и MISIS ID рвут HTTP/2-сессии: все повторы
  // уходили в порванную сессию (ERR_HTTP2_SESSION_ERROR), и тихий вход в журнал падал как «сеть не отвечает» (2 окт).
  if (!agents.has(k)) agents.set(k, new Agent({ allowH2: false, connections: 6, connect: { timeout: 1500 }, keepAliveTimeout: 60e3, keepAliveMaxTimeout: 60e3, ...(bind ? { localAddress: bind } : {}) }));
  return agents.get(k);
}

/*
 * Запросы в Moodle идут НАПРЯМУЮ, мимо VPN-клиента на этом ПК (решение пользователя, 1 окт 2026). VPN нужен для Claude,
 * а до Moodle через его зарубежный выход доходила только часть соединений (замер: через VPN 4 из 16, остальное таймауты;
 * напрямую 16 из 16 за ~130 мс). Способ: сокет привязывается к адресу интерфейса, у которого шлюз по умолчанию (Wi-Fi) —
 * VPN-клиент свой трафик заворачивает более узкими маршрутами, а привязанный сокет Windows отправляет через этот интерфейс.
 * Адрес берётся из `route print` и перечитывается каждые 30 с (дом, раздача с телефона — адреса разные).
 * Страховка: три сетевых сбоя прямого пути подряд — 5 минут ходим обычным маршрутом, потом пробуем снова.
 * Выключить совсем: пустой файл moodle-direct.off рядом или переменная MOODLE_DIRECT=0.
 */
const MOODLE_LOCAL = /^(127\.|localhost$|\[?::1\]?$)/.test(new URL(BASE).hostname); // поддельный Moodle на этом же ПК (тесты) — без привязки
const DIRECT_OFF = join(DIR, "moodle-direct.off");
function readUplink() {
  return new Promise((resolve) => {
    execFile("route", ["print", "-4", "0.0.0.0"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      let best = null; // строка «0.0.0.0  0.0.0.0  <шлюз>  <адрес интерфейса>  <метрика>» с наименьшей метрикой
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/);
        if (m && (!best || Number(m[3]) < best.metric)) best = { addr: m[2], metric: Number(m[3]) };
      }
      resolve(best?.addr ?? null);
    });
  });
}
let uplink = null, directDisabled = true;
async function refreshUplink() {
  directDisabled = MOODLE_LOCAL || process.env.MOODLE_DIRECT === "0" || existsSync(DIRECT_OFF);
  const prev = uplink;
  uplink = directDisabled ? null : await readUplink();
  if (prev && prev !== uplink) { try { void agents.get(prev)?.close?.()?.catch?.(() => {}); } catch { /* пул уже закрыт */ } agents.delete(prev); } // сеть сменилась — старый пул не нужен
}
await refreshUplink();
setInterval(() => void refreshUplink(), 30e3).unref();
let directFails = 0, directOffUntil = 0;
const directBind = () => (uplink && Date.now() >= directOffUntil ? uplink : null);
/** Каким путём сейчас идут запросы в Moodle — для /api/health и журнала. */
export const moodleRoute = () => (directBind() ? "direct" : directDisabled ? "default" : uplink ? "default (прямой путь на паузе)" : "default (нет адреса интерфейса)");

async function mfetchRaw(url, opts) {
  const bind = directBind();
  if (!bind) return undiciFetch(url, { ...opts, dispatcher: agentFor(null) });
  try {
    const r = await undiciFetch(url, { ...opts, dispatcher: agentFor(bind) });
    directFails = 0;
    return r;
  } catch (e) {
    if (e.message === "fetch failed" && ++directFails >= 3) {
      directFails = 0;
      directOffUntil = Date.now() + 5 * 60e3;
      console.error("moodle: прямой путь не отвечает три раза подряд — 5 минут идём обычным маршрутом");
    }
    throw e;
  }
}

/*
 * Здоровье сети МИСИС по узлам (newlms, ej) — для плашки «Moodle сейчас не работает» (просьба владельца, 4 окт 2026:
 * 3 окт Moodle полдня не отвечал, в журнале 61 сбой, а студент видел только «ошибка» и не понимал, у кого проблема).
 * Отдельные сбои соединения у МИСИС — норма (их закрывает retry), поэтому «не работает» — это серия подряд: не меньше
 * DOWN_STREAK неудач без единого ответа, тянущаяся дольше DOWN_AFTER_MS. Первый же ответ сервера серию обнуляет.
 * Запросы идут постоянно (быстрый опрос тестов раз в 2 минуты на каждого пользователя), так что состояние свежее.
 */
const DOWN_STREAK = Number(process.env.MOODLE_DOWN_STREAK) || 8;
const DOWN_AFTER_MS = Number(process.env.MOODLE_DOWN_AFTER_MS) || 45e3;
const net = new Map(); // узел → { okAt, streak, streakAt, failAt }
function noteNet(url, ok) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return; }
  const s = net.get(host) || { okAt: 0, streak: 0, streakAt: 0, failAt: 0 };
  const now = Date.now();
  if (ok) { s.okAt = now; s.streak = 0; s.streakAt = 0; }
  else { if (!s.streak) s.streakAt = now; s.streak++; s.failAt = now; }
  net.set(host, s);
}
/** Состояние узла: down — не отвечает (с какого времени — since), okAt — когда отвечал последний раз. */
export function netHealth(host) {
  const s = net.get(host);
  if (!s) return { down: false, since: null, okAt: null };
  const now = Date.now();
  // Серия старше 10 минут без новых попыток — данных нет (никто не спрашивал), сбоем это не считаем.
  const down = s.streak >= DOWN_STREAK && now - s.streakAt >= DOWN_AFTER_MS && now - s.failAt < 10 * 60e3;
  return { down, since: down ? s.streakAt : null, okAt: s.okAt || null };
}

export async function mfetch(url, opts = {}) {
  try {
    const r = await mfetchRaw(url, opts);
    noteNet(url, r.status < 500); // 5xx — узел отвечает, но не работает (техработы, сбой сервера)
    return r;
  } catch (e) {
    if (e.message === "fetch failed" || e.name === "TimeoutError" || e.name === "AbortError") noteNet(url, false);
    throw e;
  }
}

/**
 * Повтор сетевых сбоев при обращении к Moodle. У МИСИС (замечено 1 окт 2026) около половины TCP-соединений не
 * устанавливаются, причём результат зависит от исходящего порта (многопутевой маршрут с мёртвыми путями) — новая попытка
 * идёт с нового соединения и обычно проходит. Повторяем только сетевые ошибки и таймауты; ошибки самого Moodle
 * (неверный пароль, нет токена) отдаём сразу.
 */
export async function retry(fn, { attempts = 5, pause = 500 } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const network = e.message === "fetch failed" || e.name === "TimeoutError" || e.name === "AbortError";
      if (!network) throw e;
      if (i >= attempts) throw new Error("Moodle не отвечает (сеть МИСИС). Попробуйте ещё раз через минуту.", { cause: e });
      await new Promise((r) => setTimeout(r, pause));
    }
  }
}

// Ключ читается (или создаётся) один раз на процесс — одним общим обещанием. Раньше при первом запуске несколько
// одновременных входов каждый создавал свой ключ, файл перезаписывался, и часть токенов потом не расшифровывалась.
let keyPromise = null;
function getKey() {
  keyPromise ??= (async () => {
    let hex = await readText(KEY_FILE);
    if (!hex) { hex = randomBytes(32).toString("hex"); await writeFile(KEY_FILE, hex, { flag: "wx" }).catch(async () => { hex = await readText(KEY_FILE); }); }
    return Buffer.from(hex, "hex");
  })();
  return keyPromise;
}
async function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", await getKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}
async function decrypt(blob) {
  const [iv, tag, enc] = blob.split(".").map((h) => Buffer.from(h, "hex"));
  const d = createDecipheriv("aes-256-gcm", await getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const file = (tgId) => join(USERS, `${tgId}.json`);
const cache = new Map();

/*
 * Одновременные запросы одного пользователя (приложение при старте шлёт /api/me, /api/group, /api/deadlines разом):
 * на пользователя должен быть ОДИН объект в памяти и одна очередь записи. Иначе два запроса читали файл независимо,
 * каждый правил свою копию, и поздняя запись затирала раннюю (пропадало имя, группа или токен); а две записи в один
 * временный файл перемешивались или падали на rename.
 */
const loading = new Map(); // tgId → идущее чтение файла
async function load(tgId) {
  if (cache.has(tgId)) return cache.get(tgId);
  if (!loading.has(tgId)) {
    loading.set(tgId, readFile(file(tgId), "utf8").then(JSON.parse).catch(() => null).then((u) => {
      if (u && !cache.has(tgId)) cache.set(tgId, u);
      loading.delete(tgId);
      return cache.get(tgId) ?? null;
    }));
  }
  return loading.get(tgId);
}
/** Запись пользователя для изменения: существующая или новая, но всегда один и тот же объект для всех запросов. */
async function ensure(tgId) {
  const u = await load(tgId);
  if (u) return u;
  if (!cache.has(tgId)) cache.set(tgId, { tgId, createdAt: Date.now() });
  return cache.get(tgId);
}
const writing = new Map(); // tgId → очередь записи
async function save(u) {
  await mkdir(USERS, { recursive: true });
  u.updatedAt = Date.now();
  cache.set(u.tgId, u);
  // Через временный файл: при нехватке места (ENOSPC, уже случалось) прежняя запись с токеном остаётся целой, а не пустой.
  // Имя временного файла своё на каждую запись, записи одного пользователя идут по очереди.
  const run = async () => {
    const tmp = `${file(u.tgId)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(u, null, 2));
    await rename(tmp, file(u.tgId));
  };
  const q = (writing.get(u.tgId) || Promise.resolve()).catch(() => {}).then(run);
  writing.set(u.tgId, q);
  await q;
  return u;
}

/** Токен Moodle пользователя (расшифрованный) или null. Владелец без учётки — из файла OpenClaw, пока не выходил (loggedOut). */
export async function moodleToken(tgId) {
  const u = await load(tgId);
  if (u?.token) return decrypt(u.token);
  if (tgId === OWNER_ID && !u?.loggedOut) return (await readText(join(homedir(), ".openclaw", "moodle-token.txt"))) || null;
  return null;
}

/** Открытые данные пользователя для приложения (без токена). */
export async function profile(tgId) {
  const u = await load(tgId);
  const hasToken = !!(u?.token) || (tgId === OWNER_ID && !!(await moodleToken(tgId)));
  // Владелец входит старым токеном OpenClaw без учётки — имя берём из Moodle один раз и запоминаем.
  if (tgId === OWNER_ID && hasToken && !u?.fullName) {
    try {
      const token = await moodleToken(tgId);
      const info = await retry(() => mfetch(`${BASE}/webservice/rest/server.php`, { method: "POST", body: new URLSearchParams({ wstoken: token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }), signal: AbortSignal.timeout(5000) }).then((x) => x.json()));
      if (info.userid) { await save(Object.assign(await ensure(tgId), { moodleUserId: info.userid, fullName: info.fullname, username: info.username })); return profile(tgId); }
    } catch { /* Moodle недоступен — покажем без имени */ }
  }
  return {
    tgId, loggedIn: hasToken,
    moodle: u?.fullName ? { userId: u.moodleUserId, fullName: u.fullName, username: u.username } : (hasToken ? { fullName: "вход выполнен" } : null),
    group: u?.group ?? null, groupCandidates: u?.groupCandidates ?? [], subgroup: u?.subgroup ?? "1", variant: u?.variant ?? null,
    labsAllowed: await labsAllowed(tgId),
    labRequest: u?.labRequest ?? null, isOwner: tgId === OWNER_ID,
    courseOverrides: u?.courseOverrides ?? {},
    ej: !!u?.ej,
    shareRemarks: shares(tgId, u),
    notify: prefsOf(u),
  };
}

/*
 * Согласие делиться замечаниями преподавателя к своим работам (обезличенно) — для общей базы типичных замечаний,
 * по которой агент проверяет отчёты (lessons.mjs). У владельца — по умолчанию да (это его просьба), у остальных — только
 * если включили сами (Профиль → «Делиться замечаниями»).
 */
const shares = (tgId, u) => (tgId === OWNER_ID ? u?.shareRemarks ?? true : u?.shareRemarks === true);
export async function remarksConsent(tgId) {
  const u = await load(tgId);
  return { share: shares(tgId, u), fullName: u?.fullName || "" };
}
export async function setShareRemarks(tgId, on) {
  const u = await ensure(tgId);
  u.shareRemarks = !!on;
  u.shareRemarksAt = Date.now();
  await save(u);
}

/*
 * Какие сообщения бота пользователь хочет получать (Профиль → «Уведомления бота»): news — объявления преподавателей и
 * новые материалы курсов (news.mjs), journal — пропуски и посещаемость из электронного журнала (attendance.mjs).
 * По умолчанию всё включено; о новых работах, сроках, оценках и замечаниях бот пишет всегда.
 */
const NOTIFY_KEYS = ["news", "journal"];
const prefsOf = (u) => Object.fromEntries(NOTIFY_KEYS.map((k) => [k, u?.notifyOff?.[k] !== true]));
export async function notifyPrefs(tgId) { return prefsOf(await load(tgId)); }
export async function setNotifyPref(tgId, key, on) {
  if (!NOTIFY_KEYS.includes(key)) throw new Error("Неизвестная настройка уведомлений");
  const u = await ensure(tgId);
  u.notifyOff = { ...(u.notifyOff || {}) };
  if (on) delete u.notifyOff[key]; else u.notifyOff[key] = true;
  await save(u);
  return prefsOf(u);
}

/** Ручной выбор курсов пользователя: { [courseId]: true | false }; без записи — автоматика (moodle.courseAuto). */
export async function courseOverrides(tgId) { return (await load(tgId))?.courseOverrides ?? {}; }
export async function setCourse(tgId, courseId, active) {
  const u = await ensure(tgId);
  u.courseOverrides = { ...(u.courseOverrides || {}) };
  if (active === null || active === undefined) delete u.courseOverrides[courseId]; else u.courseOverrides[courseId] = !!active;
  await save(u);
  return u.courseOverrides;
}

/** Имя в Telegram (из подписанного initData) — чтобы владелец видел, кто просит доступ. Пишем только при изменении. */
export async function touchTelegram(tgId, tgUser) {
  if (!tgUser?.id) return;
  const u = await ensure(tgId);
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ");
  if (u.tgName === name && u.tgUsername === (tgUser.username || null)) return;
  u.tgName = name; u.tgUsername = tgUser.username || null;
  await save(u);
}

/** Пользователь просит доступ к отчётам с агентом (кнопка в приложении). */
export async function requestLabAccess(tgId) {
  const u = await ensure(tgId);
  u.labRequest = Date.now();
  await save(u);
}

async function readAllow() {
  const raw = await readText(ALLOW_FILE);
  const lines = raw ? raw.split(/\r?\n/) : [];
  const comments = lines.filter((l) => l.trim().startsWith("#"));
  const ids = lines.filter((l) => !l.trim().startsWith("#")).join(" ").split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  return { comments, ids };
}

/** Владелец разрешает или закрывает отчёты пользователю: правим lab-allowlist.txt (комментарии сохраняем). */
let allowQueue = Promise.resolve(); // правки белого списка — по очереди: две одновременные читали бы один файл и теряли бы чужую правку
export async function setLabAccess(tgId, allowed) {
  const run = async () => {
    const { comments, ids } = await readAllow();
    const set = new Set(ids);
    if (allowed) set.add(Number(tgId)); else set.delete(Number(tgId));
    const tmp = `${ALLOW_FILE}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, [...comments, ...[...set].map(String)].join("\n") + "\n");
    await rename(tmp, ALLOW_FILE);
  };
  allowQueue = allowQueue.catch(() => {}).then(run);
  await allowQueue;
  const u = await load(tgId);
  if (u) { delete u.labRequest; await save(u); }
}

/** Все известные пользователи (без токенов) — для экрана владельца «Доступ к отчётам». */
export async function listUsers() {
  const ids = (await readdir(USERS).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5)));
  const { ids: allow } = await readAllow();
  const out = [];
  for (const id of ids) {
    const u = await load(id);
    if (!u) continue;
    out.push({ tgId: id, tgName: u.tgName || null, tgUsername: u.tgUsername || null, fullName: u.fullName || null, group: u.group || null,
      loggedIn: !!(await moodleToken(id)), allowed: id === OWNER_ID || allow.includes(id), isOwner: id === OWNER_ID, labRequest: u.labRequest || null, updatedAt: u.updatedAt || null });
  }
  return out.sort((a, b) => (b.labRequest || 0) - (a.labRequest || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Вход: логин и пароль → токен Moodle. Пароль дальше этой функции не живёт. */
export async function login(tgId, username, password) {
  // Ответы здесь маленькие, а мёртвое соединение не ответит никогда — 5 с на попытку, дальше retry() берёт новое соединение.
  const j = await retry(() => mfetch(`${BASE}/login/token.php`, {
    method: "POST", body: new URLSearchParams({ username, password, service: "moodle_mobile_app" }), signal: AbortSignal.timeout(5000),
  }).then((r) => r.json().catch(() => ({}))));
  if (!j.token) throw new Error(j.error || "Moodle не выдал токен");
  const info = await retry(() => mfetch(`${BASE}/webservice/rest/server.php`, {
    method: "POST", body: new URLSearchParams({ wstoken: j.token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }),
    signal: AbortSignal.timeout(5000),
  }).then((x) => x.json()));
  if (!info.userid) throw new Error("Токен получен, но профиль Moodle недоступен");
  const token = await encrypt(j.token);
  const u = await ensure(tgId);
  Object.assign(u, { token, moodleUserId: info.userid, fullName: info.fullname, username: info.username });
  delete u.loggedOut;
  await save(u);
  return profile(tgId);
}

/**
 * Вход в электронный журнал (ej.mjs): cookies журнала и MISIS ID — зашифрованно, как токен Moodle. Пароль не хранится.
 * ejAt — когда вход последний раз проверен; ejError — почему не удалось войти (показывается во вкладке «Журнал»).
 */
export async function ejJar(tgId) {
  const u = await load(tgId);
  if (!u?.ej) return null;
  try { return JSON.parse(await decrypt(u.ej)); } catch { return null; }
}
export async function setEj(tgId, jar, error = null) {
  const u = await ensure(tgId);
  if (jar) u.ej = await encrypt(JSON.stringify(jar)); else if (jar === null) delete u.ej;
  u.ejAt = Date.now();
  if (error) u.ejError = String(error).slice(0, 200); else delete u.ejError;
  await save(u);
}
export async function ejState(tgId) {
  const u = await load(tgId);
  return { connected: !!u?.ej, at: u?.ejAt ?? null, error: u?.ejError ?? null, email: u?.username ?? null };
}

export async function logout(tgId) {
  const u = await ensure(tgId);
  delete u.token;
  delete u.ej; // выход из бота — выход и из журнала
  // Без флага владельцу «Выйти» ничего не давало: moodleToken() тут же подставлял старый токен OpenClaw, и вход оставался.
  u.loggedOut = true;
  await save(u);
  return profile(tgId);
}

/** Группа для расписания (подтверждённая пользователем или найденная сама), подгруппа и вариант для титульного листа. */
/*
 * Название группы: буквы, цифры, пробел и . , ( ) + _ - (в списке МИСИС встречаются «ММТМ-25-11А_Джоте Й.С., Оладимеджи Т.Д.»).
 * Группа попадает в инструкцию агенту рядом с рабочей папкой, поэтому путь или служебный текст в неё вписать нельзя:
 * по папке из инструкции расход относится к пользователю (usage.mjs whoOf).
 */
export const GROUP_NAME = /^[\p{L}\p{N} .,()+_-]{2,60}$/u;
export async function setGroup(tgId, group, subgroup, variant) {
  const u = await ensure(tgId);
  if (group !== undefined) {
    const g = String(group ?? "").trim();
    if (g && !GROUP_NAME.test(g)) throw new Error("Неверное название группы");
    u.group = g || null;
  }
  if (subgroup !== undefined) u.subgroup = subgroup === "2" ? "2" : "1";
  if (variant !== undefined) u.variant = String(variant ?? "").trim().slice(0, 12) || null;
  await save(u);
  return profile(tgId);
}

/**
 * Автоопределение группы: имена групп пользователя в его активных курсах Moodle («БИСТ-24-2») → группы «Дневача»
 * («БИСТ-24-ПО-2»). Сопоставляем по префиксу и году; если кандидат один — ставим сразу, иначе предлагаем выбрать.
 */
export async function detectGroup(tgId, moodleGroupNames, dnevuchGroups) {
  const u = await ensure(tgId);
  const counts = new Map();
  for (const name of moodleGroupNames) {
    const m = name.match(/([А-ЯA-Z]{2,6})-(\d\d)-([\wА-Яа-я-]+)/u);
    if (!m) continue;
    const k = `${m[1]}-${m[2]}-${m[3]}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  let candidates = [];
  for (const k of ranked) {
    const [, pref, year, rest] = k.match(/^([А-ЯA-Z]+)-(\d\d)-(.+)$/u);
    if (dnevuchGroups.includes(k)) { candidates = [k]; break; }
    const same = dnevuchGroups.filter((g) => g.startsWith(`${pref}-${year}-`));
    const byTail = same.filter((g) => g.endsWith(`-${rest}`));
    if (byTail.length) { candidates = byTail; break; }
    if (same.length) { candidates = same; break; }
  }
  u.groupCandidates = candidates;
  if (!u.group && candidates.length === 1) u.group = candidates[0];
  await save(u);
  return { group: u.group ?? null, candidates };
}

/*
 * Календарь в телефоне (calendar.mjs): у каждого пользователя своя секретная ссылка подписки. Секрет — случайная строка
 * в его записи (cal.token); по ней сервер узнаёт, чей календарь отдавать, — подписи Telegram у календарных программ нет.
 * reset — выдать новую ссылку (старая перестаёт работать): если ссылка попала к постороннему.
 */
const calIndex = new Map(); // секрет → tgId (заполняется при первом обращении и при выдаче)
export async function calToken(tgId, { reset = false } = {}) {
  const u = await ensure(tgId);
  if (!u.cal?.token || reset) {
    if (u.cal?.token) calIndex.delete(u.cal.token);
    u.cal = { token: randomBytes(18).toString("base64url"), at: Date.now() };
    await save(u);
  }
  calIndex.set(u.cal.token, tgId);
  return u.cal.token;
}
/** Чей это календарь: Telegram id по секрету из ссылки, или null. */
export async function byCalToken(token) {
  if (!/^[\w-]{20,40}$/.test(String(token || ""))) return null;
  if (calIndex.has(token)) return calIndex.get(token);
  const ids = (await readdir(USERS).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5)));
  for (const id of ids) { const u = await load(id); if (u?.cal?.token) calIndex.set(u.cal.token, id); }
  return calIndex.get(token) ?? null;
}

export async function labsAllowed(tgId) {
  if (tgId === OWNER_ID) return true;
  const list = (await readText(ALLOW_FILE)).split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join(" ").split(/[\s,;]+/).filter(Boolean).map(Number);
  return list.includes(Number(tgId));
}

/** Все пользователи с токеном (для ежечасных напоминаний). */
export async function allLoggedIn() {
  const ids = (await readdir(USERS).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5)));
  if (!ids.includes(OWNER_ID)) ids.push(OWNER_ID);
  const out = [];
  for (const id of ids) { const t = await moodleToken(id); if (t) out.push({ tgId: id, token: t, overrides: (await load(id))?.courseOverrides ?? {} }); }
  return out;
}
