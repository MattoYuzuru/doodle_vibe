// Таблицы преподавателей в курсах Moodle (просьба владельца, 15 окт 2026: «в методах оптимизации есть вкладка журнал
// с эксель таблицей… брать данные для сессии именно оттуда, т. к. в Moodle не всегда актуальная информация»; «если в
// курсе нет информации о баллах или посещениях — смотреть на наличие эксель таблиц»; «многие преподаватели выставляют
// баллы в эксель таблицах курса»).
//
// Где ищем: файлы курса (ресурс, папка, вложения страницы) xlsx / xlsm / xls / csv и ссылки на открытые таблицы —
// Яндекс Диск (disk.yandex.ru/i/…, /d/… — папка) и Google Таблицы (docs.google.com/spreadsheets/…) — в элементах
// «Ссылка», описаниях элементов и разделов, тексте страниц. Скачиваем своим токеном (что студент не видит в курсе, мы
// тоже не видим), разбираем sheet_xls.py → sheets.mjs ищет свою строку по ФИО из Moodle и группе.
//
// Чужие строки наружу не уходят: разобранная книга живёт только в памяти сервера (ключ — адрес файла и время его
// изменения: файл, который студент видит в своём списке, у всех один), на диск не пишется; временный файл удаляется
// сразу после разбора. Наружу — только своя запись (sheets.sheetRecord).
//
// Нагрузка на Moodle: список файлов курса — один пакетный запрос на все нужные курсы, не чаще раза в SHEETS_LIST_MS
// (30 мин) на курс и токен; файл качается заново, только когда в Moodle сменилось время его изменения или размер.
// live=false (фоновые уведомления) — только уже прочитанное.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as moodle from "./moodle.mjs";
import * as mplan from "./moodle-plan.mjs";
import * as sheets from "./sheets.mjs";
import { BASE } from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const PARSER = join(DIR, "sheet_xls.py");
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const LIST_MS = num(process.env.SHEETS_LIST_MS, 30 * 60e3);
const LINK_MS = num(process.env.SHEETS_LINK_MS, 30 * 60e3); // Google не сообщает время изменения — перечитываем по сроку
const BOOK_MS = num(process.env.SHEETS_BOOK_MS, 12 * 3600e3);
const MAX_BYTES = num(process.env.SHEETS_MAX_BYTES, 5 * 1024 * 1024);
const MAX_FILES = num(process.env.SHEETS_MAX_FILES, 8); // на курс
const EXTERNAL = process.env.SHEETS_EXTERNAL !== "0";
const PARSE_TIMEOUT_MS = num(process.env.SHEETS_PARSE_TIMEOUT_MS, 60e3);
const FETCH_TIMEOUT_MS = 30e3;
const SHEET_EXT = /\.(xlsx|xlsm|xls|csv)$/i;
// Название похоже на ведомость — такие файлы смотрим первыми (предел MAX_FILES на курс).
const LIKELY = /журнал|ведомост|балл|рейтинг|брс|итог|успеваем|посещ|оценк|результат|аттестац/i;

function python() {
  for (const p of [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"]) if (p && existsSync(p)) return p;
  return "python";
}
let running = 0;
const waiting = [];
const slot = async () => { if (running >= 2) await new Promise((r) => waiting.push(r)); running++; };
const free = () => { running--; waiting.shift()?.(); };
/** Буфер файла → книга { sheets, truncated } или { error }. Не больше двух разборов сразу, предел времени. */
async function parseBuffer(buf, ext) {
  await slot();
  let dir = null; // временная папка — внутри try: сбой mkdtemp не должен навсегда занять место разбора
  try {
    dir = await mkdtemp(join(tmpdir(), "doodle-sheet-"));
    const file = join(dir, `book.${ext}`);
    await writeFile(file, buf);
    return await new Promise((resolve, reject) => {
      const env = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python"), PYTHONIOENCODING: "utf-8" };
      const p = spawn(python(), [PARSER, file], { windowsHide: true, env });
      const out = [], err = [];
      // Не уложился, упал или выдал не JSON — дело в самом файле: такая ошибка помнится до смены файла (parse: true),
      // а не повторяется каждые 5 минут (проверка 16 окт).
      const fail = (msg) => reject(Object.assign(new Error(msg), { parse: true }));
      const timer = setTimeout(() => { p.kill(); fail(`sheet_xls.py: не закончил за ${PARSE_TIMEOUT_MS / 1000} с`); }, PARSE_TIMEOUT_MS);
      p.stdout.on("data", (d) => out.push(d));
      p.stderr.on("data", (d) => err.push(d));
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code) return fail(`sheet_xls.py: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `код ${code}`}`);
        try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch { fail("sheet_xls.py: ответ не JSON"); }
      });
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    free();
  }
}
/** Похоже ли содержимое на таблицу того вида, что в имени: xlsx — zip (PK), xls — OLE; csv — не HTML-страница. */
export function looksLike(buf, ext) {
  if (!buf?.length) return false;
  if (ext === "xlsx" || ext === "xlsm") return buf[0] === 0x50 && buf[1] === 0x4b;
  if (ext === "xls") return buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  return !/^\s*</.test(buf.subarray(0, 200).toString("utf8"));
}

// ---------- ссылки ----------
const HREF = /https?:\/\/[^\s"'<>()]+/gi;
const unent = (s) => String(s).replace(/&amp;/g, "&").replace(/&#0*38;/g, "&");
export const hrefs = (html) => [...String(html || "").matchAll(HREF)].map((m) => unent(m[0]).replace(/[.,;:!?»]+$/, ""));
/**
 * Ссылка на открытую таблицу → { kind: "yandex" | "google", url (как скачивать), key }. Остальные ссылки — null.
 * Яндекс Диск: /i/… — файл, /d/… — папка (берём таблицы из неё). Google: /spreadsheets/d/<id>/… — выгрузка xlsx (если
 * доступ «всем по ссылке»), /spreadsheets/d/e/<id>/pub… — опубликованная.
 */
export function extLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (/^(disk\.yandex\.(ru|com|kz|by|ua)|yadi\.sk|disk\.360\.yandex\.ru)$/.test(host)) {
    const m = /^\/(i|d)\/([\w-]+)/.exec(u.pathname);
    if (!m) return null;
    const link = `https://disk.yandex.ru/${m[1]}/${m[2]}`;
    return { kind: "yandex", url: link, key: `ya:${link}`, folder: m[1] === "d" };
  }
  if (host === "docs.google.com") {
    const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
    if (pub) return { kind: "google", url: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx`, key: `gs:e:${pub[1]}` };
    const m = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
    if (m) return { kind: "google", url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`, key: `gs:${m[1]}` };
  }
  return null;
}

/**
 * Таблицы в содержимом курса (core_course_get_contents) и на его страницах (mod_page_get_pages_by_courses). Скрытое от
 * студента пропускается. Возвращает [{ kind: moodle|yandex|google, title, section, file, url, size, modified, view,
 * key }] — сначала похожие на ведомость, потом свежие; не больше MAX_FILES. Чистая функция (для стенда).
 */
export function candidates(courseId, sections, pages = []) {
  const out = [], seen = new Set();
  const add = (x) => { if (!seen.has(x.key)) { seen.add(x.key); out.push(x); } };
  const link = (raw, base) => { if (!EXTERNAL) return; const x = extLink(raw); if (x) add({ ...base, kind: x.kind, url: x.url, key: x.key, folder: !!x.folder, file: null, size: null, modified: 0 }); };
  for (const s of Array.isArray(sections) ? sections : []) {
    if (s?.uservisible === false || s?.visible === 0) continue;
    const sec = String(s.name || "").trim();
    for (const h of hrefs(s.summary)) link(h, { courseId, cmid: null, title: sec || "Раздел курса", section: sec, view: `${BASE}/course/view.php?id=${courseId}` });
    for (const m of s.modules || []) {
      if (m?.uservisible === false || m?.visible === 0) continue;
      const view = m.url || `${BASE}/mod/${m.modname}/view.php?id=${m.id}`;
      const base = { courseId, cmid: m.id ?? null, title: String(m.name || "").trim(), section: sec, view };
      for (const f of m.contents || []) {
        if (m.modname === "url" && f?.fileurl) { link(f.fileurl, base); continue; }
        if (f?.type && f.type !== "file") continue;
        if (!SHEET_EXT.test(f?.filename || "") || !f.fileurl) continue;
        const size = Number(f.filesize) || 0;
        add({ ...base, kind: "moodle", file: String(f.filename), url: String(f.fileurl), size, modified: (Number(f.timemodified) || 0) * 1000,
          key: `md:${String(f.fileurl).replace(/[?#].*$/, "")}|${f.timemodified || 0}|${size}`, tooBig: size > MAX_BYTES });
      }
      for (const h of hrefs(m.description)) link(h, base);
    }
  }
  for (const p of Array.isArray(pages) ? pages : []) {
    if (Number(p?.course) !== Number(courseId) || p.visible === 0) continue;
    const base = { courseId, cmid: p.coursemodule ?? null, title: String(p.name || "").trim(), section: "", view: `${BASE}/mod/page/view.php?id=${p.coursemodule}` };
    for (const h of hrefs(p.content)) link(h, base);
  }
  const score = (x) => (LIKELY.test(`${x.title} ${x.file || ""} ${x.section}`) ? 2 : 0) + (x.kind === "moodle" ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a) || (b.modified || 0) - (a.modified || 0)).slice(0, MAX_FILES);
}

// ---------- внешние таблицы ----------
/** Скачать по ссылке не больше max байт (заголовок content-length больше или тело больше — отказ). */
async function fetchCapped(url, max, headers = {}) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Doodle mini app)", ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
  if (Number(res.headers.get("content-length")) > max) { void res.body?.cancel().catch(() => {}); throw new Error(`больше ${Math.round(max / 1048576)} МБ`); }
  const chunks = [];
  let n = 0;
  for await (const c of res.body) { n += c.length; if (n > max) throw new Error(`больше ${Math.round(max / 1048576)} МБ`); chunks.push(c); }
  return { buf: Buffer.concat(chunks), type: res.headers.get("content-type") || "" };
}
const YA_API = "https://cloud-api.yandex.net/v1/disk/public/resources";
/** Яндекс Диск: файл или таблицы папки → [{ name, size, modified, md5, href }]. */
async function yandexFiles(link) {
  const r = await fetchCapped(`${YA_API}?public_key=${encodeURIComponent(link)}&limit=40&fields=name,type,size,modified,md5,file,_embedded.items.name,_embedded.items.type,_embedded.items.size,_embedded.items.modified,_embedded.items.md5,_embedded.items.file`, 512 * 1024, { accept: "application/json" });
  const j = JSON.parse(r.buf.toString("utf8"));
  const items = j.type === "file" ? [j] : j._embedded?.items || [];
  return items.filter((x) => x.type === "file" && SHEET_EXT.test(x.name || "") && x.file).slice(0, MAX_FILES)
    .map((x) => ({ name: x.name, size: Number(x.size) || 0, modified: Date.parse(x.modified) || 0, md5: x.md5 || "", href: x.file }));
}

// ---------- кэш ----------
const lists = new Map(); // `${token}:${courseId}` → { at, files, error? }
const listing = new Map(); // `${token}:${courseId}` → промис идущего чтения списка (одновременные запросы ждут его)
const listFail = new Map(); // `${token}:${courseId}` → когда пакет со списком не прочитался целиком
const linkCache = new Map(); // key ссылки Яндекса → { at, files } (что лежит по ссылке)
const books = new Map(); // ключ файла → { at, book, cells, plan? } | { at, error, transient? } — разобранная книга (в памяти)
const inflight = new Map(); // ключ файла → промис разбора
// Своя запись по книге — у каждого студента своя; держится, пока не сменился файл, даже когда сама книга вытеснена
// из памяти: файл не качается заново ради того же ответа (проверка 16 окт: при 40+ файлах каждый запрос качал всё).
const records = new Map(); // `${ключ файла}|${время файла}|${userid}|${группа}` → { status, rec, plan, truncated }
const MAX_CELLS = num(process.env.SHEETS_MAX_CELLS, 3e6), MAX_RECORDS = 5000;
let cellsHeld = 0;
const cellsOf = (book) => (book?.sheets || []).reduce((n, s) => n + (s.rows || []).reduce((m, r) => m + (r?.length || 0), 0), 0);
/** Книга в кэш; память ограничена числом ячеек всех книг, вытесняются давно не нужные. */
function keepBook(key, v) {
  const old = books.get(key);
  if (old) { cellsHeld -= old.cells || 0; books.delete(key); }
  v.cells = v.book ? cellsOf(v.book) : 0;
  books.set(key, v);
  cellsHeld += v.cells;
  while (cellsHeld > MAX_CELLS && books.size > 1) { const [k, x] = books.entries().next().value; books.delete(k); cellsHeld -= x.cells || 0; }
}
/** Книга из кэша с отметкой «нужна» (в конец очереди на вытеснение). */
function touch(key) {
  const v = books.get(key);
  if (v) { books.delete(key); books.set(key, v); }
  return v;
}
// Сколько держать: книгу — BOOK_MS (ключ сменится вместе с файлом), Google — LINK_MS (времени изменения нет), файл не
// таблица или не разобрался — BOOK_MS (тот же файл не исправится), сбой сети или Moodle — RETRY_MS.
const RETRY_MS = 5 * 60e3;
const ttl = (key, v) => (v.transient ? RETRY_MS : v.book && key.startsWith("gs:") ? LINK_MS : BOOK_MS);
/** Разобрать один раз на ключ: одновременные запросы ждут того же разбора. */
function bookOnce(key, load, force = false) {
  const c = touch(key);
  if (!force && c && Date.now() - c.at < ttl(key, c)) return Promise.resolve(c);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const { buf, ext } = await load();
      if (!looksLike(buf, ext)) return { at: Date.now(), error: "по ссылке не таблица (доступ закрыт или страница входа)" };
      const book = await parseBuffer(buf, ext);
      return book.error ? { at: Date.now(), error: `не разобрать: ${book.error}` } : { at: Date.now(), book };
    } catch (e) {
      return { at: Date.now(), error: String(e?.message || e).slice(0, 200), transient: !e?.tooBig && !e?.parse };
    }
  })().then((v) => {
    // Сбой при перечитывании (Google по сроку) — остаётся прежняя книга, новая попытка через RETRY_MS.
    if (v.transient && c?.book) { const keep = { ...c, at: Date.now() - ttl(key, c) + RETRY_MS }; keepBook(key, keep); return keep; }
    keepBook(key, v);
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
const extOf = (name, fallback = "xlsx") => (/\.(xlsx|xlsm|xls|csv)$/i.exec(name || "")?.[1].toLowerCase() || fallback);
const TOO_BIG = () => `файл больше ${Math.round(MAX_BYTES / 1048576)} МБ`;

/**
 * Книги одного кандидата (у папки Яндекса их несколько): [{ src, at, book } | { src, error } | { src, memo }].
 * memo(src) — своя запись, уже посчитанная по этой версии файла: тогда файл не нужен вовсе. live=false — только из
 * кэша; Moodle не работает — тоже (даже устаревшая книга лучше скачиваний с повторами во время сбоя).
 */
async function booksOf(c, token, { live, fresh = false, memo }) {
  if (c.tooBig) return [{ src: c, error: TOO_BIG() }];
  if (c.kind === "moodle") {
    const m = !fresh && memo(c);
    if (m) return [{ src: c, memo: m }];
    const cached = touch(c.key);
    if (!live || moodle.health().down) return cached ? [{ src: c, ...cached }] : [];
    const v = await bookOnce(c.key, async () => ({ buf: await moodle.downloadFile(c.url, token, { maxBytes: MAX_BYTES }), ext: extOf(c.file) }));
    return [{ src: c, ...v }];
  }
  if (c.kind === "google") {
    const cached = touch(c.key);
    if (!live) return cached ? [{ src: { ...c, modified: cached.at }, ...cached }] : [];
    // Версия Google-таблицы — время её выгрузки: пока она свежая, своя запись по ней уже посчитана.
    const m = !fresh && cached?.book && Date.now() - cached.at < ttl(c.key, cached) && memo({ ...c, modified: cached.at });
    if (m) return [{ src: { ...c, modified: cached.at }, memo: m }];
    const v = await bookOnce(c.key, async () => ({ buf: (await fetchCapped(c.url, MAX_BYTES)).buf, ext: "xlsx" }), fresh);
    return [{ src: { ...c, modified: v.at }, ...v }];
  }
  // Яндекс Диск: что лежит по ссылке — раз в LINK_MS; книга — по md5/времени файла.
  let lc = linkCache.get(c.key);
  if (live && (fresh || !(lc && Date.now() - lc.at < LINK_MS))) {
    try { lc = { at: Date.now(), files: await yandexFiles(c.url) }; linkCache.set(c.key, lc); }
    catch (e) { if (!lc) return [{ src: c, error: `Яндекс Диск: ${String(e?.message || e).slice(0, 120)}` }]; }
  }
  if (!lc) return [];
  const out = [];
  for (const f of lc.files) {
    const key = `${c.key}|${f.name}|${f.md5 || f.modified}`;
    const src = { ...c, file: f.name, size: f.size, modified: f.modified, key };
    if (f.size > MAX_BYTES) { out.push({ src, error: TOO_BIG() }); continue; }
    const m = memo(src);
    if (m) { out.push({ src, memo: m }); continue; }
    const cached = touch(key);
    if (!live) { if (cached) out.push({ src, ...cached }); continue; }
    out.push({ src, ...(await bookOnce(key, async () => ({ buf: (await fetchCapped(f.href, MAX_BYTES)).buf, ext: extOf(f.name) }))) });
  }
  return out;
}

/**
 * Список таблиц курсов: из кэша или одним пакетным запросом (содержимое курсов + страницы). Курс, список которого уже
 * читается другим запросом, — ждём того же чтения (на старте приложения «Журнал» и «Сессия» спрашивают одновременно).
 * Курс, которого Moodle не отдал, — пустой список с повтором через RETRY_MS, а не на каждом запросе. live=false или
 * Moodle не работает — только прочитанное раньше. Сбой — прежний список остаётся.
 */
async function listCourses(token, ids, live, fresh = false) {
  const now = Date.now(), key = (id) => `${token}:${id}`;
  // Ждать чужого чтения — только живому запросу: запасной путь «что уже прочитано» (live=false, после waitMs) не должен
  // ждать медленный Moodle (проверка 16 окт: ответ «не дольше 8 с» приходил через время чтения). Весь пакет не
  // прочитался — повтор не раньше RETRY_MS (listFail), а не на каждом открытии, пока Moodle не признан «лежащим».
  const busy = [], need = [];
  for (const id of ids) {
    if (listing.has(key(id))) { if (live) busy.push(listing.get(key(id))); }
    else if (fresh || (!(now - (lists.get(key(id))?.at || 0) < LIST_MS) && !(now - (listFail.get(key(id)) || 0) < RETRY_MS))) need.push(id);
  }
  if (live && need.length && !moodle.health().down) {
    const p = (async () => {
      try {
        const res = await moodle.callMany(token, [...need.map((id) => ({ fn: "core_course_get_contents", params: { courseid: id } })), { fn: "mod_page_get_pages_by_courses", params: { courseids: need } }]);
        const pages = res[need.length]?.data?.pages || [];
        need.forEach((id, i) => {
          listFail.delete(key(id));
          const d = res[i]?.data;
          if (Array.isArray(d)) lists.set(key(id), { at: now, files: candidates(id, d, pages) });
          else lists.set(key(id), { at: now - LIST_MS + RETRY_MS, files: lists.get(key(id))?.files ?? [], error: String(res[i]?.error?.message || res[i]?.error || "нет ответа").slice(0, 160) });
        });
      } catch (e) {
        console.log(`course-sheets: список файлов не прочитан: ${String(e?.message || e).slice(0, 160)}`);
        for (const id of need) listFail.set(key(id), Date.now());
      }
    })();
    for (const id of need) listing.set(key(id), p);
    try { await p; } finally { for (const id of need) if (listing.get(key(id)) === p) listing.delete(key(id)); }
  }
  if (busy.length) await Promise.all(busy);
  return new Map(ids.map((id) => [id, lists.get(key(id))?.files ?? null]));
}

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
// ref — какой именно файл (две Google-таблицы со страницы курса — разные источники, хотя ссылка на элемент одна).
const pub = (s) => ({ kind: s.kind, title: s.title || null, file: s.file || null, section: s.section || null, url: s.view || null, modified: s.modified || null, ref: s.key ? String(s.key).slice(0, 300) : null });
/**
 * Своя запись в таблицах курсов. ids — курсы Moodle; group — группа студента. Возвращает Map courseId → {
 *   record: лучшая запись с баллами или посещениями (sheets.sheetRecord + src — откуда) | null,
 *   attendance: { …, src } | null — посещения (из той же таблицы или другой),
 *   plan: пороги из таблицы-плана (moodle-plan.parsePlan) | null,
 *   files: [{ title, file, url, modified, status, error?, sheet? }] — что нашлось и чем кончилось (для пояснений) }.
 * Курсы, у которых список ещё не читали (и live=false), в Map не попадают.
 */
export async function forCourses(token, courseIds, { live = true, group = null, waitMs = 0, fresh = false } = {}) {
  // waitMs — экран не ждёт медленный Moodle дольше этого: дальше отдаётся уже прочитанное, а начатое чтение
  // доделывается в фоне и пригодится при следующем открытии.
  // fresh — «Обновить»: список файлов и ссылки перечитываются сразу, без срока.
  if (!live || !waitMs) return collect(token, courseIds, { live, group, fresh });
  const full = collect(token, courseIds, { live, group, fresh });
  full.catch(() => {});
  let timer;
  const late = new Promise((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); }).then(() => collect(token, courseIds, { live: false, group }));
  try { return await Promise.race([full, late]); } finally { clearTimeout(timer); }
}
/** Своя запись и пороги по книге (считается один раз на версию файла и студента — разбор большой книги не быстрый). */
function analyse(g, me, group) {
  const rec = sheets.sheetRecord(g.book, me, { group, fileName: g.src.file || "", title: g.src.title || "", modified: g.src.modified || g.at });
  // Пороги оценок — из любой книги курса: отдельный рейтинг-план в Excel или шкала на листе журнала. Один раз на книгу.
  const cached = books.get(g.src.key);
  let plan = cached?.book === g.book ? cached.plan : undefined;
  if (plan === undefined) {
    const p = mplan.parsePlan(sheets.planText(g.book));
    plan = p.status === "ok" ? p : null;
    if (cached?.book === g.book) cached.plan = plan;
  }
  return { status: rec.status, rec: rec.status === "ok" ? rec : null, plan, truncated: !!g.book.truncated };
}
async function collect(token, courseIds, { live, group, fresh = false }) {
  const ids = [...new Set((courseIds || []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!token || !ids.length) return out;
  const me = await moodle.whoAmI(token, { live }).catch(() => null);
  const who = me ? `${me.userid}|${group || ""}` : null;
  const memoKey = (src) => (who && src.modified ? `${src.key}|${src.modified}|${who}` : null);
  const memo = (src) => { const k = memoKey(src); return k ? records.get(k) ?? null : null; };
  const listed = await listCourses(token, ids, live, live && fresh);
  await Promise.all(ids.map(async (id) => {
    const files = listed.get(id);
    if (!files) return;
    const entries = [];
    for (const c of files) {
      let got;
      try { got = await booksOf(c, token, { live, fresh: live && fresh, memo }); } catch (e) { got = [{ src: c, error: String(e?.message || e).slice(0, 160) }]; }
      for (const g of got) {
        if (g.memo) { entries.push({ src: g.src, ...g.memo }); continue; }
        if (!g.book) { entries.push({ src: g.src, status: "error", error: g.error || "не прочитана", transient: !!g.transient }); continue; }
        if (!me) { entries.push({ src: g.src, status: "no_name", rec: null, plan: null }); continue; }
        const r = analyse(g, me, group);
        const k = memoKey(g.src.modified ? g.src : { ...g.src, modified: g.at });
        if (k) { records.set(k, r); while (records.size > MAX_RECORDS) records.delete(records.keys().next().value); }
        entries.push({ src: g.src, ...r });
      }
    }
    const ok = entries.filter((e) => e.rec);
    const rank = (e) => [e.rec.have != null ? 1 : 0, RANK[e.rec.confidence] || 0, e.rec.attendance ? 1 : 0, e.src.modified || 0];
    const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
    ok.sort(cmp);
    const best = ok[0] || null;
    const att = best?.rec.attendance ? best : ok.find((e) => e.rec.attendance) || null;
    out.set(id, {
      record: best ? { ...best.rec, src: pub(best.src) } : null,
      attendance: att ? { ...att.rec.attendance, sheet: att.rec.attendanceSheet || att.rec.sheet, groupRel: att.rec.groupRel, match: att.rec.match, group: att.rec.groupCode ?? null, src: pub(att.src) } : null,
      plan: entries.find((e) => e.plan)?.plan ?? null,
      files: entries.map((e) => ({ ...pub(e.src), status: e.status, error: e.error || null, transient: !!e.transient, sheet: e.rec?.sheet || null })),
    });
  }));
  return out;
}

/** Забыть списки файлов токена (выход, отзыв токена). Разобранные книги общие — их держит срок. */
export function forget(token) {
  for (const m of [lists, listFail]) for (const k of [...m.keys()]) if (k.startsWith(`${token}:`)) m.delete(k);
}
/** Для стенда: сбросить всё. */
export function _reset() { lists.clear(); listing.clear(); listFail.clear(); linkCache.clear(); books.clear(); inflight.clear(); records.clear(); cellsHeld = 0; }
