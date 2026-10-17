// Расписание экзаменационной сессии с misis.ru/students/session/ (просьба владельца, 15 окт 2026: «уведомление с датами
// экзаменов»). До сессии страница пустая («будет опубликовано перед сессией»); по распоряжению о сессии учебный отдел
// выкладывает расписание не позднее чем за неделю до её начала — скорее всего, теми же файлами Excel по институтам, что
// и расписание занятий (official.mjs). Точный вид файлов до первой публикации неизвестен: session_xls.py разбирает два
// вероятных устройства листа и на прочих не падает — тогда владельцу уходит сообщение «не разобрал», а студентам ссылка.
//
// Страница проверяется раз в час (SESSION_REFRESH_MS); новый файл скачивается и разбирается один раз, результат —
// schedule-cache/session/<файл>.json, переживает перезапуск. О новых файлах узнают подписчики (onNew) — сервер шлёт
// уведомления. Расписание по группе — examsFor(group).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normGroup } from "./official.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./state-file.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.SESSION_CACHE || join(DIR, "schedule-cache", "session");
export const PAGE = process.env.MISIS_SESSION_URL || "https://misis.ru/students/session/";
const SITE = new URL(PAGE).origin;
const PARSER = join(DIR, "session_xls.py");
const PARSER_VERSION = 1;
const REFRESH_MS = Number(process.env.SESSION_REFRESH_MS) || 60 * 60e3, RETRY_MS = 15 * 60e3;
const UA = { "user-agent": "Mozilla/5.0 (Doodle mini app)" };
const STATE = join(CACHE, "state.json");

function python() {
  for (const p of [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"]) if (p && existsSync(p)) return p;
  return "python";
}
// Предел на разбор одного файла (15 окт 2026): зависший session_xls.py держал проверку страницы вечно — check() отдавал
// тот же незавершённый промис, и новые файлы до перезапуска больше не искались. По пределу процесс убивается, файл
// записывается с ошибкой, и владелец получает «разобрать не удалось». Обычный файл института разбирается за секунды.
const PARSE_TIMEOUT_MS = 5 * 60e3;
function parse(file) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python"), PYTHONIOENCODING: "utf-8" };
    const p = spawn(python(), [PARSER, file], { windowsHide: true, env });
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill(); reject(new Error(`session_xls.py: не закончил за ${PARSE_TIMEOUT_MS / 60e3} мин`)); }, PARSE_TIMEOUT_MS);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code) return reject(new Error(`session_xls.py: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `код ${code}`}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch (e) { reject(e); }
    });
  });
}

let state = null; // { at, files: { "<имя>": { url, title, seenAt, parsed, groups, skipped, error } } }
const exams = new Map(); // нормализованная группа → { file, title, seenAt, list }
const meta = new Map(); // имя разобранного файла → { groups: [группы как в файле], until: последняя дата экзамена }
const listeners = [];
// checking — вся проверка страницы вместе с рассылкой подписчикам; reading — только её первая часть (страница,
// скачивание, разбор, запись state.json), без рассылки: её и только её недолго ждёт files().
let checking = null, reading = null, lastTry = 0, loading = null;

/*
 * Состояние страницы сессии (15 окт 2026). Раньше любая ошибка чтения state.json давала пустое состояние, и оно
 * запоминалось до перезапуска: все файлы страницы считались новыми — скачивались и разбирались заново, а подписчики
 * (admission.announce) получали их снова. Теперь «файла нет» — только ENOENT (новое состояние); занятый файл —
 * StateReadError наверх, и ничего не запоминается (следующий вызов прочитает снова); испорченный JSON откладывается в
 * .bad-* и дальше — как новое состояние. В память состояние попадает целиком, уже с разобранными файлами (одновременный
 * вызов ждёт того же чтения, а не видит полусобранный список экзаменов).
 */
async function loadState() {
  if (state) return state;
  return (loading ??= (async () => {
    await mkdir(CACHE, { recursive: true });
    const s = await readJson(STATE, { missing: () => ({ at: 0, files: {} }) });
    const st = { at: 0, ...(s && typeof s === "object" && !Array.isArray(s) ? s : {}) };
    if (!st.files || typeof st.files !== "object") st.files = {};
    for (const name of Object.keys(st.files)) await absorb(name, st).catch(() => {});
    state = st;
    return st;
  })().finally(() => { loading = null; }));
}
// Атомарно (временный файл + rename): обрыв записи раньше оставлял испорченный JSON — а с ним и «всё заново» при старте.
const saveState = () => writeJsonAtomic(STATE, state);
/**
 * Разобранный файл с диска → в общий список по группам. Группа может быть в нескольких файлах (институт и общий
 * список): записи складываются; один и тот же экзамен (дата + дисциплина) из более поздней выкладки заменяет прежний.
 */
async function absorb(name, st = state) {
  const f = st.files[name];
  if (!f?.parsed) return;
  const j = await readFile(join(CACHE, `${name}.json`), "utf8").then(JSON.parse);
  const all = Object.values(j.groups || {}).flat().map((e) => e.date).filter(Boolean).sort();
  meta.set(name, { groups: Object.keys(j.groups || {}), until: all.at(-1) || null });
  const ek = (e) => `${e.date}|${String(e.name).toLowerCase()}`;
  for (const [g, list] of Object.entries(j.groups || {})) {
    const key = normGroup(g), cur = exams.get(key);
    const merged = new Map((cur?.list || []).map((e) => [ek(e), e]));
    for (const e of list) if (!merged.has(ek(e)) || (cur?.seenAt ?? 0) <= f.seenAt) merged.set(ek(e), e);
    const all = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "99").localeCompare(String(b.time || "99")));
    const newest = !cur || cur.seenAt <= f.seenAt;
    exams.set(key, { file: newest ? name : cur.file, title: newest ? f.title : cur.title, url: newest ? f.url : cur.url, seenAt: Math.max(cur?.seenAt ?? 0, f.seenAt), list: all });
  }
}

/** Ссылки на файлы расписания со страницы: Excel — все, PDF — только с «сессия/экзамен» в подписи или имени. */
export function parseLinks(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+\.(xlsx?|pdf))"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1], ext = m[2].toLowerCase(), title = m[3].replace(/<[^>]+>/g, " ").replace(/&nbsp;|­/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
    const name = decodeURIComponent(href.split("/").pop());
    if (ext === "pdf" && !/сесси|экзам|session|ekz|sess/i.test(`${title} ${name}`)) continue;
    if (!out.some((x) => x.name === name)) out.push({ name, title, url: new URL(href, SITE).href, ext });
  }
  return out;
}

/**
 * Проверка страницы: новые файлы скачиваются и разбираются; возвращает список новых [{ name, title, url, groups,
 * parsed, error }] (подписчикам onNew он же уходит). Ошибка сети — пустой список и повтор через RETRY_MS.
 */
export async function check() {
  if (checking) return checking;
  checking = (async () => {
    const read = readPage();
    reading = read;
    let fresh;
    try { fresh = await read; } finally { if (reading === read) reading = null; }
    for (const f of fresh) for (const cb of listeners) { try { await cb(f); } catch (e) { console.log(`session: подписчик: ${e.message || e}`); } }
    return fresh;
  })().finally(() => { checking = null; });
  return checking;
}
/** Первая часть check: страница, новые файлы (скачать, разобрать), state.json. Возвращает список новых файлов. */
async function readPage() {
  await loadState();
  let links;
  try {
    const html = await fetch(PAGE, { headers: UA, signal: AbortSignal.timeout(25000) }).then((r) => { if (!r.ok) throw new Error(`misis.ru ${r.status}`); return r.text(); });
    links = parseLinks(html);
  } catch (e) { console.log(`session: страница сессии не получена (${e.message})`); lastTry = Date.now(); return []; }
  const fresh = [];
  for (const l of links) {
    if (state.files[l.name]) continue;
    const rec = { url: l.url, title: l.title, seenAt: Date.now(), parsed: false, groups: 0, skipped: [], error: null, ext: l.ext };
    try {
      const path = join(CACHE, l.name);
      const r = await fetch(l.url, { headers: UA, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await writeFile(`${path}.part`, Buffer.from(await r.arrayBuffer()));
      await rename(`${path}.part`, path);
      if (l.ext !== "pdf") {
        const j = await parse(path);
        await writeTextAtomic(`${path}.json`, JSON.stringify({ version: PARSER_VERSION, ...j }));
        rec.parsed = true; rec.groups = Object.keys(j.groups || {}).length; rec.skipped = j.skipped || [];
      }
      console.log(`session: новый файл ${l.name} («${l.title}»): групп ${rec.groups}${rec.skipped.length ? `, пропущено листов ${rec.skipped.length}` : ""}`);
    } catch (e) { rec.error = e.message; console.log(`session: ${l.name}: ${e.message}`); }
    state.files[l.name] = rec;
    if (rec.parsed) await absorb(l.name).catch(() => {});
    fresh.push({ name: l.name, title: l.title, url: l.url, ext: l.ext, parsed: rec.parsed, groups: rec.parsed ? Object.keys(JSON.parse(await readFile(join(CACHE, `${l.name}.json`), "utf8")).groups || {}) : [], skipped: rec.skipped, error: rec.error });
  }
  state.at = Date.now();
  await saveState();
  return fresh;
}
/** Подписка на новые файлы расписания сессии. */
export const onNew = (cb) => { listeners.push(cb); };
/**
 * Найденные файлы страницы — для повторной рассылки дат экзаменов (admission.tick: тем, кому рассылка при публикации не
 * дошла). Только чтение: [{ name, title, url, seenAt, parsed, groups: [группы как в файле], until: последняя дата
 * экзамена }].
 * Отдаёт то, что известно сейчас (15 окт 2026). Сначала здесь ждали всю идущую проверку страницы, а в неё входят
 * скачивание, разбор через python без предела по времени и рассылка подписчикам (announce по всем, минуты при новом
 * файле): tick (раз в 5 минут) стоял на этом ожидании, напоминания «Сегодня экзамен в 9:00» опаздывали, а зависший
 * разбор останавливал их совсем. Теперь — не дольше READ_WAIT_MS и только первую часть проверки (страница, разбор),
 * рассылку не ждём никогда. Файл, который ещё не разобран, сюда попадает без групп и даты (meta заполняет absorb
 * вместе со списком экзаменов) — tick его пропустит; файл, рассылка по которому идёт сейчас, досылке не мешает:
 * от дубля защищает отметка exams:<файл> в admission.announceOne.
 */
const READ_WAIT_MS = 3000;
export async function files() {
  const r = reading;
  if (r) await Promise.race([r.catch(() => {}), new Promise((resolve) => setTimeout(resolve, READ_WAIT_MS).unref?.())]);
  await loadState();
  return Object.entries(state.files).map(([name, f]) => ({ name, title: f.title, url: f.url, seenAt: f.seenAt || 0, parsed: !!f.parsed, groups: meta.get(name)?.groups || [], until: meta.get(name)?.until || null }));
}

/** Экзамены группы: { file, title, url, seenAt, list: [{ date, time, name, kind, place, teacher }] } или null — расписания ещё нет. */
export async function examsFor(group) {
  await loadState();
  return exams.get(normGroup(group)) || null;
}
/** Что известно о странице: когда проверялась, какие файлы найдены. */
export async function info() {
  await loadState();
  return { page: PAGE, at: state.at, files: Object.entries(state.files).map(([name, f]) => ({ name, title: f.title, url: f.url, seenAt: f.seenAt, parsed: f.parsed, groups: f.groups, error: f.error })) };
}

// Первая проверка вскоре после запуска, дальше по расписанию; после сбоя — не раньше RETRY_MS.
if (process.env.SESSION_WATCH !== "0") {
  const tick = () => { if (Date.now() - lastTry >= RETRY_MS || !state?.at) void check().catch(() => {}); };
  setTimeout(tick, 20e3).unref?.();
  setInterval(tick, Math.min(REFRESH_MS, 3600e3)).unref?.();
}
