// Пользователи мини-приложения. Ключ — Telegram id из подписанного initData.
// Вход: логин и пароль Moodle → у Moodle берётся персональный токен (login/token.php, как у мобильного приложения);
// токен шифруется (AES-256-GCM, ключ в users.key) и лежит в users/<tgId>.json. Для Moodle пароль не нужен; с 16 окт 2026
// он хранится зашифрованно только для повторного входа в электронный журнал (ejCred ниже).
// Владелец (OWNER_ID) до первого входа пользуется старым токеном из ~/.openclaw/moodle-token.txt — но только пока не нажал
// «Выйти из Moodle» (флаг loggedOut): после выхода старый токен не подставляется, и приложение показывает форму входа.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { Agent, fetch as undiciFetch } from "undici";
import * as pace from "./moodle-pace.mjs";
import { CONSENT_V } from "./terms.mjs";
import { StateReadError, isStateReadError, readJson, readText as readStateText, writeJsonAtomic, writeTextAtomic } from "./state-file.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const USERS = join(DIR, "users");
const KEY_FILE = join(DIR, "users.key");
export const BASE = "https://newlms.misis.ru";
export const OWNER_ID = 945210206;
// Белый список для лаб с агентом (тратят подписку Claude владельца): Telegram id через запятую в lab-allowlist.txt.
const ALLOW_FILE = join(DIR, "lab-allowlist.txt");

// Текстовые файлы (users.key, lab-allowlist.txt, токен OpenClaw). До 15 окт 2026 любая ошибка чтения давала «»: занятый
// на миг белый список выглядел пустым, и setLabAccess переписывал его одним id — остальные теряли доступ к лабам. Теперь
// «» — только когда файла нет (ENOENT); занятый файл читается повторно, а не вышло — StateReadError (запрос получит 424).
const readText = async (p) => ((await readStateText(p)) ?? "").trim();

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

/*
 * Каждый запрос к сайтам МИСИС проходит через ограничитель (moodle-pace.mjs): очередь с паузами вместо пачек, счётчик
 * запросов, остановка фоновых обходов при отказах. Фоновый запрос во время паузы в сеть не уходит (PausedError).
 */
export async function mfetch(url, { timeoutMs, ...opts } = {}) {
  const u = String(url);
  const what = opts.body instanceof URLSearchParams ? opts.body.get("wsfunction") || (u.includes("/login/token.php") ? "login" : "post")
    : /pluginfile/.test(u) ? "file" : /upload\.php/.test(u) ? "upload" : "page";
  const turn = await pace.enter(u, what, u.includes("/webservice/rest/server.php") || u.includes("/login/token.php"));
  // Пока запрос ждал очереди, его срок мог истечь — это не сбой сети: в сеть не идём и сбоем не считаем.
  if (opts.signal?.aborted) { pace.cancel(turn); throw opts.signal.reason ?? new Error("истёк срок ожидания запроса"); }
  // Срок запроса (timeoutMs) отсчитывается отсюда — когда запрос дождался очереди и уходит в сеть. Раньше он шёл и в
  // очереди: при медленном Moodle запросы истекали, не успев уйти, и это считалось сбоем сети.
  if (timeoutMs) { const t = AbortSignal.timeout(timeoutMs); opts.signal = opts.signal ? AbortSignal.any([opts.signal, t]) : t; }
  try {
    const r = await mfetchRaw(url, opts);
    noteNet(url, r.status < 500); // 5xx — узел отвечает, но не работает (техработы, сбой сервера)
    pace.leave(turn, { status: r.status, retryAfter: r.headers.get("retry-after") });
    return r;
  } catch (e) {
    const network = e.message === "fetch failed" || e.name === "TimeoutError" || e.name === "AbortError";
    if (network) noteNet(url, false);
    pace.leave(turn, { error: network ? e : null });
    throw e;
  }
}

/**
 * Повтор сетевых сбоев при обращении к Moodle. У МИСИС (замечено 1 окт 2026) около половины TCP-соединений не
 * устанавливаются, причём результат зависит от исходящего порта (многопутевой маршрут с мёртвыми путями) — новая попытка
 * идёт с нового соединения и обычно проходит. Повторяем только сетевые ошибки и таймауты; ошибки самого Moodle
 * (неверный пароль, нет токена) отдаём сразу.
 */
// С 5 окт 2026: паузы между попытками растут (0,5 → 1 → 1,5 с со случайным разбросом), а у фоновых обходов попыток три,
// а не пять: когда Moodle действительно не отвечает, бот не должен стучаться впятеро чаще (3–4 окт так прошли сутки).
// Долгий сбой останавливает фоновые обходы целиком — moodle-pace.mjs.
// maxSent — предел для попыток, при которых запрос мог дойти до сервера (таймаут, обрыв уже установленного соединения):
// тяжёлый запрос сервер доработает и без нас, повторять его много раз нельзя. Несостоявшееся соединение (запрос не
// ушёл) в этот счёт не идёт — только в общий.
const NO_CONNECT = /^(UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ENOTFOUND|EAI_AGAIN)$/;
export async function retry(fn, { attempts, pause, maxSent } = {}) {
  const bg = pace.isBackground();
  const max = attempts ?? (bg ? 3 : 5), base = pause ?? (bg ? 1000 : 500);
  let sent = 0;
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const network = e.message === "fetch failed" || e.name === "TimeoutError" || e.name === "AbortError";
      if (!network) throw e;
      if (!(e.message === "fetch failed" && NO_CONNECT.test(String(e.cause?.code || "")))) sent++;
      if (i >= max || (maxSent && sent >= maxSent)) throw new Error("Moodle не отвечает (сеть МИСИС). Попробуйте ещё раз через минуту.", { cause: e });
      await new Promise((r) => setTimeout(r, base * i * (0.75 + Math.random() * 0.5)));
    }
  }
}

// Ключ читается (или создаётся) один раз на процесс — одним общим обещанием. Раньше при первом запуске несколько
// одновременных входов каждый создавал свой ключ, файл перезаписывался, и часть токенов потом не расшифровывалась.
// 15 окт 2026: новый ключ создаётся только когда файла нет (ENOENT). Занятый файл раньше читался как «», запись с wx
// падала (файл есть), и при повторном «» ключ выходил нулевой длины — до перезапуска не расшифровывался ни один токен
// (обещание с плохим ключом хранилось вечно). Теперь ошибка чтения бросается, обещание сбрасывается, и следующий вызов
// читает файл заново; ключ не из 32 байт — тоже ошибка (испорченный файл не заменяем: старые токены новым не открыть).
let keyPromise = null;
function getKey() {
  keyPromise ??= (async () => {
    let hex = await readText(KEY_FILE);
    if (!hex) {
      const fresh = randomBytes(32).toString("hex");
      try { await writeFile(KEY_FILE, fresh, { flag: "wx" }); hex = fresh; }
      catch (e) { if (e?.code !== "EEXIST") throw e; hex = await readText(KEY_FILE); } // одновременный вызов успел создать файл первым
    }
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) throw new Error(`users.key: ключ не 32 байта (${key.length}) — файл испорчен, токены не расшифровать`);
    return key;
  })().catch((e) => { keyPromise = null; throw e; });
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
/*
 * Шифрование кэшей с личными данными на диске (15 окт 2026: копия дедлайнов, moodle.mjs) — тем же ключом users.key,
 * AES-256-GCM, содержимое сжато. aad («связанные данные») в файл не пишется: копия открывается, только если совпало
 * всё, к чему её привязали (токен, выбор курсов, семестр, версия кода), — иначе расшифровка падает. Сам токен в файл
 * не попадает.
 */
export async function seal(obj, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", await getKey(), iv);
  c.setAAD(Buffer.from(String(aad), "utf8"));
  const enc = Buffer.concat([c.update(gzipSync(JSON.stringify(obj))), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}
/** Обратное к seal; не тот aad, чужой ключ или порча — исключение. */
export async function unseal(blob, aad) {
  const [iv, tag, enc] = String(blob).split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", await getKey(), iv);
  d.setAAD(Buffer.from(String(aad), "utf8"));
  d.setAuthTag(tag);
  return JSON.parse(gunzipSync(Buffer.concat([d.update(enc), d.final()])).toString("utf8"));
}

const file = (tgId) => join(USERS, `${tgId}.json`);
const cache = new Map();

/*
 * Одновременные запросы одного пользователя (приложение при старте шлёт /api/me, /api/group, /api/deadlines разом):
 * на пользователя должен быть ОДИН объект в памяти и одна очередь записи. Иначе два запроса читали файл независимо,
 * каждый правил свою копию, и поздняя запись затирала раннюю (пропадало имя, группа или токен); а две записи в один
 * временный файл перемешивались или падали на rename.
 */
/*
 * Баг «ошибка чтения файла = новый пользователь» (15 окт 2026): раньше любая ошибка чтения (файл на миг занят антивирусом
 * или копией — EBUSY/EPERM, BOM после Блокнота) значила «файла нет». ensure() создавал пустую запись и клал её в кэш,
 * а первая же запись (touchTelegram на каждом /api/me, profile владельца, calToken) затирала настоящий файл: пропадали
 * токен Moodle, группа, ссылка календаря, журнал. Теперь «нет файла» — только ENOENT (state-file.mjs). Занятый файл —
 * повторы ≈1 с, затем StateReadError (424): запрос просит повторить, обход пропускает человека, ничего не пишется и ничего
 * не запоминается — следующий вызов читает файл заново. Испорченный JSON откладывается в «<id>.json.bad-<время>» и дальше
 * считается отсутствующим: человек входит заново, прежние данные лежат в копии для ручного восстановления.
 */
const loading = new Map(); // tgId → идущее чтение файла
// Файл испорчен и уже отложен в .bad-* (null, а файл есть): до первой записи не перечитываем — иначе каждый обход
// (materialsTick — раз в 15 с) делал бы новую копию. Отметку снимает save.
const quarantined = new Set();
async function load(tgId) {
  if (cache.has(tgId)) return cache.get(tgId);
  if (quarantined.has(tgId)) return null;
  if (!loading.has(tgId)) {
    const p = readJson(file(tgId), { missing: null }).then((u) => {
      if (u && !cache.has(tgId)) cache.set(tgId, u);
      else if (!u && existsSync(file(tgId))) quarantined.add(tgId);
      return cache.get(tgId) ?? null;
    }).finally(() => loading.delete(tgId)); // и при ошибке: неудачное чтение не запоминается
    loading.set(tgId, p);
  }
  return loading.get(tgId);
}
/**
 * Запись пользователя для изменения: существующая или новая, но всегда один и тот же объект для всех запросов.
 * Новая — только после однозначного «файла нет»: при ошибке чтения load бросает, и сюда дело не доходит.
 */
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
  quarantined.delete(u.tgId);
  // Через временный файл: при нехватке места (ENOSPC, уже случалось) прежняя запись с токеном остаётся целой, а не пустой.
  // Имя временного файла своё на каждую запись, записи одного пользователя идут по очереди. rename с повторами
  // (state-file.mjs, 15 окт 2026): на Windows занятый на миг прежний файл давал EPERM, и запись терялась.
  const run = () => writeJsonAtomic(file(u.tgId), u, { space: 2 });
  const q = (writing.get(u.tgId) || Promise.resolve()).catch(() => {}).then(run);
  writing.set(u.tgId, q);
  await q;
  return u;
}

/*
 * Согласие на обработку персональных данных (21 окт 2026, письмо системного администратора МИСИС). Отдельный документ
 * (terms.mjs CONSENT), подтверждается кнопкой в боте (consent.mjs); хранится запись { v: редакция, at: когда }. Пока
 * согласия нет (или оно дано на прежнюю редакцию), moodleToken() отдаёт null — а через него идут ВСЕ чтения Moodle и
 * журнала: приложение, команды бота, фоновые обходы, календарь, беседы. Владелец (автор сервиса) — оператор, а не
 * пользователь: его согласие считается данным. CONSENT_ENFORCE=0 выключает запрет (откат, если что-то пошло не так).
 */
const CONSENT_ENFORCE = process.env.CONSENT_ENFORCE !== "0";
export async function hasConsent(tgId) {
  tgId = Number(tgId);
  if (!CONSENT_ENFORCE || tgId === OWNER_ID) return true;
  return (await load(tgId))?.consent?.v === CONSENT_V;
}
/** Согласие дано: записываются редакция и время; счётчик напоминаний сбрасывается. */
export async function giveConsent(tgId) {
  const u = await ensure(Number(tgId));
  u.consent = { v: CONSENT_V, at: Date.now() };
  delete u.consentAsk; delete u.consentRevokedAt;
  await save(u);
  return u.consent;
}
/** Отзыв согласия: запись стирается, а вход — как «Выйти»: токен, сеанс и пароль журнала удаляются с сервера. */
export async function revokeConsent(tgId) {
  const u = await ensure(Number(tgId));
  delete u.consent; delete u.consentAsk;
  u.consentRevokedAt = Date.now();
  await save(u);
  return logout(Number(tgId));
}
export async function consentInfo(tgId) { const c = (await load(Number(tgId)))?.consent; return c ? { v: c.v, at: c.at, current: c.v === CONSENT_V } : null; }
/** Вошедшие без действующего согласия: им бот присылает запрос. ask — прежние запросы { at, n } (не чаще раза в сутки, не больше трёх). */
export async function consentPending() {
  if (!CONSENT_ENFORCE) return [];
  const out = [];
  for (const id of await userIds()) {
    if (id === OWNER_ID) continue;
    try { const u = await load(id); if (u?.token && u.consent?.v !== CONSENT_V) out.push({ tgId: id, ask: u.consentAsk || null }); }
    catch (e) { skipped(id, e); }
  }
  return out;
}
export async function noteConsentAsk(tgId) {
  const u = await ensure(Number(tgId));
  u.consentAsk = { at: Date.now(), n: (u.consentAsk?.n || 0) + 1 };
  await save(u);
}

/** Токен Moodle пользователя (расшифрованный) или null. Владелец без учётки — из файла OpenClaw, пока не выходил (loggedOut). Без согласия — null. */
export async function moodleToken(tgId) {
  const u = await load(tgId);
  if (!(await hasConsent(tgId))) return null;
  if (u?.token) return decrypt(u.token);
  if (tgId === OWNER_ID && !u?.loggedOut) return (await readText(join(homedir(), ".openclaw", "moodle-token.txt"))) || null; // занят — ошибка, а не «не вошёл»
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
      const info = await retry(() => mfetch(`${BASE}/webservice/rest/server.php`, { method: "POST", body: new URLSearchParams({ wstoken: token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }), timeoutMs: 5000 }).then((x) => x.json()));
      if (info.userid) { await save(Object.assign(await ensure(tgId), { moodleUserId: info.userid, fullName: info.fullname, username: info.username })); return profile(tgId); }
    } catch { /* Moodle недоступен — покажем без имени */ }
  }
  const consented = await hasConsent(tgId);
  return {
    tgId, loggedIn: hasToken && consented, consent: consented,
    moodle: u?.fullName ? { userId: u.moodleUserId, fullName: u.fullName, username: u.username } : (hasToken ? { fullName: "вход выполнен" } : null),
    group: u?.group ?? null, groupCandidates: u?.groupCandidates ?? [], subgroup: u?.subgroup ?? "1", variant: u?.variant ?? null,
    labsAllowed: await labsAllowed(tgId),
    labRequest: u?.labRequest ?? null, isOwner: tgId === OWNER_ID,
    courseOverrides: u?.courseOverrides ?? {},
    ej: !!(u?.ej || u?.ejCred),
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

/*
 * Уточнения «Сессии» самим студентом (просьба владельца, 15 окт 2026: «пусть пользователь сам уточняет, чтобы не
 * гадать»): какую дисциплину по выбору взял (electives: { "Б1.В.ДВ.01": "Б1.В.ДВ.01.02" }), записан ли на факультатив
 * (optional: { "ФТД.02": true | false }), что из списка не его — перезачтено или не изучает (hidden: { ключ: true }).
 * Ключи и значения приходят из приложения — только короткие строки и не больше SESSION_MAX записей каждого вида.
 */
const SESSION_KINDS = { elective: "electives", optional: "optional", hidden: "hidden" };
const SESSION_MAX = 60;
// Служебные имена объектов («__proto__», «constructor») ключом не бывают: kind «constructor» иначе проходил бы проверку
// через Object.prototype и записывал мусор (проверка 15 окт).
const shortKey = (s) => typeof s === "string" && s.length > 0 && s.length <= 160 && !/[\u0000-\u001f]/.test(s) && !(s in Object.prototype) && s !== "__proto__";
const ownMap = (m) => (m && typeof m === "object" && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).filter(([k]) => shortKey(k))) : {});
export async function sessionChoices(tgId) {
  const c = (await load(tgId))?.sessionChoices || {};
  return { electives: ownMap(c.electives), optional: ownMap(c.optional), hidden: ownMap(c.hidden) };
}
/**
 * value: elective — индекс варианта или null (снова автоматически); optional — true | false | null; hidden — true | null.
 * «Не моё» (hidden) хранится временем отметки (с 16 окт 2026; раньше — true): с ответом бота о той же дисциплине журнала
 * решает последнее слово студента (admission.notMineNow).
 */
export async function setSessionChoice(tgId, kind, key, value) {
  const field = Object.hasOwn(SESSION_KINDS, kind) ? SESSION_KINDS[kind] : null;
  if (!field || !shortKey(key)) throw new Error("Неверное уточнение");
  if (value !== null && !(kind === "elective" ? shortKey(value) : kind === "optional" ? typeof value === "boolean" : value === true)) throw new Error("Неверное значение");
  const u = await ensure(tgId);
  const c = await sessionChoices(tgId);
  const map = { ...c[field] };
  if (value === null) delete map[key];
  else { if (!Object.hasOwn(map, key) && Object.keys(map).length >= SESSION_MAX) throw new Error("Слишком много уточнений"); map[key] = kind === "hidden" ? Date.now() : value; }
  u.sessionChoices = { ...c, [field]: map };
  await save(u);
  return sessionChoices(tgId);
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

// Белый список: нет файла — пустой; занят или не читается — StateReadError (424), а не «ни у кого нет доступа».
async function readAllow() {
  const raw = await readText(ALLOW_FILE);
  const lines = raw ? raw.split(/\r?\n/) : [];
  const comments = lines.filter((l) => l.trim().startsWith("#"));
  const ids = lines.filter((l) => !l.trim().startsWith("#")).join(" ").split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  allowLast = ids; // последнее удачное чтение — см. allowIds
  return { comments, ids };
}
/*
 * 15 окт 2026 (проверка после правки «ошибка чтения = новый пользователь»): строгое чтение белого списка сделало его общей
 * точкой отказа. profile() зовут почти все пути — /api/me, проверка расписания в каждом обходе уведомлений, лента
 * календаря, команды бота, рассылка дат экзаменов, — и занятый на секунду lab-allowlist.txt (антивирус, копия, rename
 * из setLabAccess) давал 424 всем, хотя нужен этот файл только лабам. Теперь помним последний удачно прочитанный список:
 * labsAllowed и profile при StateReadError берут его (в журнал — не чаще раза в минуту). Ещё ни разу не прочитали (сразу
 * после запуска) — по-прежнему ошибка: «нет доступа» вслепую показало бы кнопку «Попросить доступ» и прислало бы
 * владельцу лишний запрос. Правка списка (setLabAccess) и экран владельца (listUsers) читают строго — правка идёт только
 * поверх свежего удачного чтения, после неудачного ничего не пишется.
 */
let allowLast = null, allowToldAt = 0;
async function allowIds() {
  try { return (await readAllow()).ids; }
  catch (e) {
    if (!isStateReadError(e) || !allowLast) throw e;
    if (Date.now() - allowToldAt >= 60e3) {
      allowToldAt = Date.now();
      console.error(`users: ${ALLOW_FILE} сейчас не читается (${String(e?.cause?.code || e?.message || e).slice(0, 120)}) — доступ к лабам по последнему прочитанному списку`);
    }
    return allowLast;
  }
}

/** Владелец разрешает или закрывает отчёты пользователю: правим lab-allowlist.txt (комментарии сохраняем). */
let allowQueue = Promise.resolve(); // правки белого списка — по очереди: две одновременные читали бы один файл и теряли бы чужую правку
export async function setLabAccess(tgId, allowed) {
  // Не прочитали файл — не пишем ничего (15 окт 2026: раньше пустое чтение переписывало список одним этим id).
  const run = async () => {
    const { comments, ids } = await readAllow();
    const set = new Set(ids);
    if (allowed) set.add(Number(tgId)); else set.delete(Number(tgId));
    await writeTextAtomic(ALLOW_FILE, [...comments, ...[...set].map(String)].join("\n") + "\n");
    allowLast = [...set]; // записали — запомненный список тот же, что на диске (иначе при занятом файле был бы список до правки)
  };
  allowQueue = allowQueue.catch(() => {}).then(run);
  await allowQueue;
  const u = await load(tgId);
  if (u) { delete u.labRequest; await save(u); }
}

/*
 * Списки и обходы по всем пользователям (15 окт 2026): ошибка чтения одного файла раньше обрывала цикл для всех —
 * один занятый users/<id>.json, и уведомления, календарь, экран владельца переставали работать у каждого. Теперь
 * нечитаемый человек пропускается (с записью в журнал не чаще раза в 10 минут на человека), остальные идут как обычно.
 * strict — папку users не прочитали (не «нет папки») — ошибка, а не пустой список.
 */
async function userIds({ strict = false } = {}) {
  const names = await readdir(USERS).catch((e) => { if (strict && e?.code !== "ENOENT") throw new StateReadError(USERS, e); return []; });
  return names.filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
}
const skipTold = new Map(); // tgId → когда о его пропуске последний раз писали в журнал
function skipped(tgId, e) {
  if (Date.now() - (skipTold.get(tgId) || 0) < 10 * 60e3) return;
  skipTold.set(tgId, Date.now());
  console.error(`users ${tgId}: пропущен — ${String(e?.message || e).slice(0, 200)}`);
}

/** Все известные пользователи (без токенов) — для экрана владельца «Доступ к отчётам». Нечитаемый файл пропускается. */
export async function listUsers() {
  const ids = await userIds();
  const { ids: allow } = await readAllow();
  const out = [];
  for (const id of ids) {
    try {
      const u = await load(id);
      if (!u) continue;
      out.push({ tgId: id, tgName: u.tgName || null, tgUsername: u.tgUsername || null, fullName: u.fullName || null, group: u.group || null,
        loggedIn: !!(await moodleToken(id)), allowed: id === OWNER_ID || allow.includes(id), isOwner: id === OWNER_ID, labRequest: u.labRequest || null, updatedAt: u.updatedAt || null });
    } catch (e) { skipped(id, e); }
  }
  return out.sort((a, b) => (b.labRequest || 0) - (a.labRequest || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Telegram id всех записей пользователей — строго: непрочитанная папка users — ошибка (для учёта пробных, lab-trial.mjs). */
export const knownUserIds = () => userIds({ strict: true });
/** Номер учётной записи Moodle (site_info.userid при входе) или null. Занятый файл — ошибка, а не «не входил». */
export async function moodleUserIdOf(tgId) {
  const u = await load(Number(tgId));
  return u?.moodleUserId ?? null;
}

/** Вход: логин и пароль → токен Moodle. Пароль дальше этой функции не живёт. */
export async function login(tgId, username, password) {
  // Ответы здесь маленькие, а мёртвое соединение не ответит никогда — 5 с на попытку, дальше retry() берёт новое соединение.
  const j = await retry(() => mfetch(`${BASE}/login/token.php`, {
    method: "POST", body: new URLSearchParams({ username, password, service: "moodle_mobile_app" }), timeoutMs: 5000,
  }).then((r) => r.json().catch(() => ({}))), { attempts: 3 }); // пароль не шлём больше трёх раз: неверный пароль с повторами — путь к блокировке входа
  if (!j.token) throw new Error(j.error || "Moodle не выдал токен");
  const info = await retry(() => mfetch(`${BASE}/webservice/rest/server.php`, {
    method: "POST", body: new URLSearchParams({ wstoken: j.token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }),
    timeoutMs: 5000,
  }).then((x) => x.json()));
  if (!info.userid) throw new Error("Токен получен, но профиль Moodle недоступен");
  const token = await encrypt(j.token);
  const u = await ensure(tgId);
  // Под тем же Telegram вошла другая учётная запись — журнал и пароль прежней забываются: иначе, если журнал новой не
  // подключится сразу, Doodle продолжал бы входить в журнал прежней её сохранённым паролем.
  if (u.username && info.username && String(u.username).toLowerCase() !== String(info.username).toLowerCase()) {
    delete u.ej; delete u.ejCred; delete u.ejCredRejected; delete u.ejCredFails; delete u.ejError; delete u.ejAt;
  }
  Object.assign(u, { token, moodleUserId: info.userid, fullName: info.fullname, username: info.username });
  delete u.loggedOut;
  bumpEjEpoch(tgId); // подключение журнала от прежнего входа (могла быть другая учётная запись) уже не запишется
  await save(u);
  return profile(tgId);
}

/**
 * Вход в электронный журнал (ej.mjs): cookies журнала и MISIS ID — зашифрованно, как токен Moodle.
 * ejAt — когда вход последний раз проверен; ejError — почему не удалось войти (показывается во вкладке «Журнал»).
 */
export async function ejJar(tgId) {
  const u = await load(tgId);
  if (!u?.ej) return null;
  try { return JSON.parse(await decrypt(u.ej)); } catch { return null; }
}
/*
 * Пароль для журнала (решение владельца, 16 окт 2026: «войти в журнал один раз и всё»). Вход MISIS ID без пароля живёт
 * ровно 48 ч от ввода пароля и не продлевается (NOTES.md п. 138), поэтому раз в двое суток журнал просил пароль снова.
 * Теперь почта и пароль хранятся зашифрованно (seal, привязка к tgId: чужому файлу не подставить) и нужны только ej.mjs —
 * войти заново, когда вход MISIS ID истёк. Наружу — в API, журналы сервера, ответы бота — не отдаются. Удаляются при
 * выходе, при входе другой учётной записью Moodle и когда MISIS ID их не принял (неверный пароль повторно не шлём:
 * так недолго заблокировать вход).
 */
const credAad = (tgId) => `ej-cred:${tgId}`;
export async function ejCred(tgId) {
  const u = await load(tgId);
  if (!u?.ejCred) return null;
  try {
    const c = await unseal(u.ejCred, credAad(tgId));
    return c?.email && c?.password ? { email: String(c.email), password: String(c.password) } : null;
  } catch (e) { if (isStateReadError(e)) throw e; return null; } // занятый users.key — ошибка, а не «пароля нет»
}
/*
 * Поколение входа (в памяти): меняется при входе в бот и при выходе. Подключение журнала идёт секунды и в фоне — начатое
 * до выхода или до входа другой учётной записью, оно свой вход и пароль уже не записывает (setEj с epoch).
 */
const ejEpochs = new Map();
export const ejEpoch = (tgId) => ejEpochs.get(tgId) ?? 0;
const bumpEjEpoch = (tgId) => ejEpochs.set(tgId, ejEpoch(tgId) + 1);
/**
 * cred: { email, password } — запомнить пароль журнала, null — забыть, не передан — не трогать.
 * epoch — поколение входа на момент начала подключения: сменилось — ничего не пишем (false).
 */
export async function setEj(tgId, jar, error = null, cred, { epoch } = {}) {
  const u = await ensure(tgId);
  const ej = jar ? await encrypt(JSON.stringify(jar)) : null;
  const sealed = cred ? await seal({ email: String(cred.email), password: String(cred.password) }, credAad(tgId)) : null;
  if (epoch !== undefined && epoch !== ejEpoch(tgId)) return false; // проверка — после всех ожиданий, перед правкой
  if (ej) u.ej = ej; else if (jar === null) delete u.ej;
  if (sealed) { u.ejCred = sealed; delete u.ejCredRejected; } else if (cred === null) delete u.ejCred;
  if (sealed || (ej && !error)) delete u.ejCredFails; // новый пароль или удачный вход — счёт неудач с начала
  u.ejAt = Date.now();
  if (error) u.ejError = String(error).slice(0, 200); else delete u.ejError;
  await save(u);
  return true;
}
/**
 * MISIS ID не принял сохранённый пароль — забыть его. Если за это время пароль уже заменили (человек ввёл новый),
 * новый не трогаем. true — забыли.
 */
export async function dropEjCred(tgId, used, error) {
  const cur = await ejCred(tgId);
  if (!cur || cur.email !== used?.email || cur.password !== used?.password) return false;
  const u = await ensure(tgId);
  delete u.ejCred; delete u.ejCredFails;
  u.ejCredRejected = Date.now(); // приложение скажет «сохранённый пароль не подошёл», а не «вход истёк»
  u.ejAt = Date.now();
  if (error) u.ejError = String(error).slice(0, 200);
  await save(u);
  console.log(`ej ${tgId}: MISIS ID не принял сохранённый пароль — он забыт, нужен новый`); // без пароля и почты
  return true;
}
/**
 * Вход по сохранённому паролю не завершился, хотя MISIS ID пароль принял (ej.mjs, ACCEPT_FAILS) — посчитать. Счётчик на
 * диске: перезапуск сервера его не сбрасывает. Пароль за это время заменили — не считаем (0).
 */
export async function noteEjCredFail(tgId, used) {
  const cur = await ejCred(tgId);
  if (!cur || cur.email !== used?.email || cur.password !== used?.password) return 0;
  const u = await ensure(tgId);
  u.ejCredFails = (Number(u.ejCredFails) || 0) + 1;
  await save(u);
  return u.ejCredFails;
}
/**
 * connected — журнал подключён или есть пароль, чтобы подключить его самим; saved — пароль сохранён; rejected — MISIS ID
 * не принял сохранённый пароль (нужен новый).
 */
export async function ejState(tgId) {
  const u = await load(tgId);
  return { connected: !!(u?.ej || u?.ejCred), saved: !!u?.ejCred, rejected: !u?.ejCred && !!u?.ejCredRejected, at: u?.ejAt ?? null, error: u?.ejError ?? null, email: u?.username ?? null };
}

export async function logout(tgId) {
  const u = await ensure(tgId);
  delete u.token;
  delete u.ej; // выход из бота — выход и из журнала
  delete u.ejCred; delete u.ejCredRejected; delete u.ejCredFails; // и пароль журнала
  bumpEjEpoch(tgId); // идущее подключение журнала их уже не вернёт
  // Без флага владельцу «Выйти» ничего не давало: moodleToken() тут же подставлял старый токен OpenClaw, и вход оставался.
  u.loggedOut = true;
  await save(u);
  return profile(tgId);
}

/**
 * Отзыв согласия (21 окт 2026): из записи уходит всё, что относится к человеку, — ФИО, логин, имя и @username в Telegram,
 * группа, выбор дисциплин, настройки, терминал, номер учётки Moodle. Остаётся пустая запись: номер Telegram, время
 * создания, отметка об отзыве и «вышел». Из белого списка лаб он тоже убирается. Вызывать после logout (purge-user.mjs).
 */
export async function eraseProfile(tgId) {
  tgId = Number(tgId);
  const u = await ensure(tgId);
  if (u.cal?.token) calIndex.delete(u.cal.token);
  const keep = { tgId, createdAt: u.createdAt, consentRevokedAt: u.consentRevokedAt || Date.now(), loggedOut: true };
  for (const k of Object.keys(u)) delete u[k];
  Object.assign(u, keep);
  await save(u);
  if ((await labsAllowed(tgId).catch(() => false))) await setLabAccess(tgId, false);
}
/** Обезличенный ключ для учёта, который нельзя стирать (пробный отчёт): HMAC от значения ключом users.key. */
export async function pseudonym(value) {
  return "h:" + createHmac("sha256", await getKey()).update(String(value)).digest("hex").slice(0, 32);
}

/** Группа для расписания (подтверждённая пользователем или найденная сама), подгруппа и вариант для титульного листа. */
/*
 * Терминал для снимков в отчётах (правило владельца, 5 окт 2026): берётся из методички, а если она молчит — агент
 * спрашивает студента. Ответ студента запоминается здесь, чтобы не переспрашивать: по курсу (в той же дисциплине вопрос
 * больше не задаётся полгода) и последний ответ (в другом курсе агент предложит его первым вариантом). То, что среду
 * назвала методичка, сюда не пишется — это свойство работы, а не предпочтение студента.
 */
export const TERMINALS = { powershell: "Windows PowerShell", cmd: "командная строка Windows", wsl: "Linux (Ubuntu в WSL)", linux: "Linux", macos: "Терминал macOS" };
const TERMINAL_FRESH_MS = 183 * 24 * 3600e3;
export async function setTerminal(tgId, courseId, value) {
  if (!Object.hasOwn(TERMINALS, value)) return false;
  const u = await ensure(tgId);
  const rec = { value, at: Date.now() };
  const byCourse = { ...(u.terminal?.byCourse || {}) };
  if (courseId) byCourse[String(courseId)] = rec;
  u.terminal = { last: rec, byCourse };
  await save(u);
  return true;
}
/** Что известно о терминале студента: { value, at, scope: "course" | "other" } или null (ответы старше полугода не в счёт). */
export async function terminalOf(tgId, courseId) {
  const t = (await load(tgId))?.terminal;
  const fresh = (r) => r && Object.hasOwn(TERMINALS, r.value) && Date.now() - r.at < TERMINAL_FRESH_MS;
  const own = courseId ? t?.byCourse?.[String(courseId)] : null;
  if (fresh(own)) return { ...own, scope: "course" };
  return fresh(t?.last) ? { ...t.last, scope: "other" } : null;
}

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
/** «Выйти» (21 окт 2026): секретная ссылка календаря стирается, старая перестаёт работать; при входе выдаётся новая. */
export async function dropCalToken(tgId) {
  const u = await load(Number(tgId));
  if (!u?.cal) return;
  if (u.cal.token) calIndex.delete(u.cal.token);
  delete u.cal;
  await save(u);
}
/**
 * Чей это календарь: Telegram id по секрету из ссылки, или null. Если секрет не нашёлся, а чей-то файл не прочитался,
 * — StateReadError (424), а не «не найден»: секрет мог быть как раз в нём, а на 404 сервер считает промах и после
 * нескольких таких блокирует адрес, с которого календарная программа опрашивает ленту.
 */
export async function byCalToken(token) {
  if (!/^[\w-]{20,40}$/.test(String(token || ""))) return null;
  if (calIndex.has(token)) return calIndex.get(token);
  let unreadable = null;
  for (const id of await userIds({ strict: true })) {
    try { const u = await load(id); if (u?.cal?.token) calIndex.set(u.cal.token, id); }
    catch (e) { unreadable ??= e; skipped(id, e); }
  }
  if (calIndex.has(token)) return calIndex.get(token);
  if (unreadable) throw isStateReadError(unreadable) ? unreadable : new StateReadError(USERS, unreadable);
  return null;
}

/**
 * Доступ к лабам с агентом. Белый список сейчас не читается — по последнему удачно прочитанному (см. allowIds); ещё ни
 * разу не прочитали — ошибка (424), а не «нет доступа» (и лишний запрос владельцу).
 */
export async function labsAllowed(tgId) {
  if (tgId === OWNER_ID) return true;
  return (await allowIds()).includes(Number(tgId));
}

/** Все пользователи с токеном (для ежечасных напоминаний). Нечитаемый пропускается до следующего обхода — см. userIds. */
export async function allLoggedIn() {
  const ids = await userIds();
  if (!ids.includes(OWNER_ID)) ids.push(OWNER_ID);
  const out = [];
  for (const id of ids) {
    try { const t = await moodleToken(id); if (t) out.push({ tgId: id, token: t, overrides: (await load(id))?.courseOverrides ?? {} }); }
    catch (e) { skipped(id, e); }
  }
  return out;
}
