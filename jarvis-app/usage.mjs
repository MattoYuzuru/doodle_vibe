// Расход агента по пользователям и лимиты (просьба владельца, 4 окт 2026).
//
// Откуда цифры. Агент лаб работает через Claude CLI, и тот пишет журнал каждой сессии (~/.claude/projects/<папка агента>/
// *.jsonl) с расходом КАЖДОГО вызова модели. Это и есть источник: ответ `openclaw agent --json` для учёта не годится —
// в нём расход только последнего вызова хода (проверено 4 окт: за лабу из 92 вызовов там набралось 2,5 тыс. токенов
// ответа). Журнал сессии относится к лабе по рабочей папке из первой инструкции (moodle-work\<id> — владелец,
// moodle-work\users\<tg>\<id> — остальные). Одно сообщение модели записано в журнале несколькими строками с одним id —
// считаем его один раз. Вызовы подагентов лежат отдельными журналами (<сессия>\subagents\) и идут в ту же работу.
//
// Что считается. Токены по дням (московским) → токены с весом (WEIGHTS, мера для лимитов) и, справочно, оценка в
// долларах по ценам API из usage/prices.json (сколько эта работа стоила бы по API; при подписке это не списания).
// Итоги по файлам журналов хранятся в usage/data.json и остаются, даже когда Claude CLI удалит старый журнал.
//
// Что входит в расход пользователя: всё, что агент делает в папке его работы, — отчёт, вопросы и правки в чате лабы,
// исправление по замечаниям, «Кратко о работе» (та же сессия лабы), установка программ (сессия окружения) и проверка
// своего отчёта. Не входит: чат бота в Telegram (главный агент) и сессии агента без папки работы — владелец видит их
// отдельной строкой.
//
// Лимиты (usage/limits.json): токенов с весом на пользователя за календарный месяц — общий (default) и личные. Новую
// лабу, исправление и проверку отчёта нельзя начать, когда месяц израсходован на 100 %; сообщения в уже идущей лабе
// принимаются до 125 %, чтобы начатую работу можно было закончить. Владельца лимиты не касаются.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CHAT_TRANSCRIPTS, AGENT_TRANSCRIPTS } from "./agent-account.mjs";
import { StateReadError, readJson as readStateJson, readText as readStateText, writeJsonAtomic } from "./state-file.mjs";
import { OWNER_ID } from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.USAGE_STORE_DIR || join(DIR, "usage"); // переменная — только для тестов
const DATA = join(STORE, "data.json"), LIMITS = join(STORE, "limits.json"), PRICES = join(STORE, "prices.json");
// Папка журналов Claude CLI для рабочей папки агента: путь, в котором всё, кроме букв и цифр, заменено на «-».
// Журналы главного агента OpenClaw (чат бота в Telegram) — соседняя папка; в лимиты не входят (см. scan). Обе — в
// профиле той учётной записи Windows, под которой работает агент (agent-account.mjs): у отдельной учётки doodle-agent
// серверу открыто чтение только этих журналов (ops\migrate\agent-account\1-права.ps1). Нет доступа — папка «не
// существует», и расход считается по ответам OpenClaw (record).
export const CHAT_TRANSCRIPTS = process.env.USAGE_CHAT_TRANSCRIPTS_DIR || AGENT_CHAT_TRANSCRIPTS;
export const TRANSCRIPTS = process.env.USAGE_TRANSCRIPTS_DIR || AGENT_TRANSCRIPTS;
const SCAN_EVERY = 60e3;
const SOFT = 1, HARD = 1.25; // доля лимита: новая работа — до 100 %, сообщения в идущей — до 125 %

// Цены API, доллары за миллион токенов: ввод (in), вывод (out), чтение из кэша (cr; не задано — 0,1 от ввода). Запись в
// кэш на 5 минут — ×1,25 от ввода, на час — ×2. Сверено со справочником Claude API (таблица моделей от 25 сент 2026).
// Модель подбирается по началу названия, более точные записи — выше; default — для неизвестных моделей (как у Sonnet 5.5,
// на которой работает агент лаб). Свои цены владелец может положить в usage/prices.json — они перекроют эти.
const DEFAULT_PRICES = {
  "claude-sonnet-5": { in: 2, out: 10, cr: 0.2 },
  "claude-sonnet-4": { in: 3, out: 15, cr: 0.3 },
  "claude-opus-5-5": { in: 4, out: 20, cr: 0.2 },
  "claude-opus": { in: 5, out: 25, cr: 0.5 },
  "claude-haiku": { in: 1, out: 5, cr: 0.1 },
  "claude-fable": { in: 10, out: 50, cr: 0.25 },
  default: { in: 2, out: 10, cr: 0.2 },
};

/**
 * Чтение JSON. Запасное значение — только когда файла нет. Нечитаемый файл (запись оборвалась, файл занят) — две
 * повторные попытки и ошибка: молча считать «лимитов нет» или «истории нет» нельзя — следующая запись закрепила бы потерю.
 */
async function readJson(p, fallback) {
  for (let i = 0; ; i++) {
    try { return JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/, "")); } // файл, сохранённый Блокнотом, начинается с BOM
    catch (e) {
      if (e.code === "ENOENT") return fallback;
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
}
// Своё имя временного файла у каждой записи (две одновременные не мешают друг другу) и rename с повторами: на Windows
// занятый на миг прежний файл давал EPERM, и запись итогов терялась (state-file.mjs, 15 окт 2026).
async function writeJson(p, v) {
  await mkdir(STORE, { recursive: true });
  await writeJsonAtomic(p, v, { space: 1 });
}

let prices = null;
/** Таблица цен: встроенная, поверх неё — usage/prices.json, если владелец завёл свой (записи файла идут первыми). */
async function loadPrices() {
  if (!prices) {
    const own = await readJson(PRICES, {}).catch((e) => { console.log(`usage: prices.json не читается (${e.message || e}) — берутся встроенные цены`); return {}; });
    prices = { ...own, ...Object.fromEntries(Object.entries(DEFAULT_PRICES).filter(([k]) => !(k in own))) };
  }
  return prices;
}
export const priceOf = (p, model) => { const k = Object.keys(p).find((x) => x !== "default" && String(model || "").startsWith(x)); return p[k] || p.default || DEFAULT_PRICES.default; };
/** Оценка в долларах для набора токенов: { in, out, cr — чтение кэша, cw1h и cw5m — запись в кэш }. */
export function costOf(t, price) {
  const cr = price.cr ?? price.in * 0.1;
  return ((t.in || 0) * price.in + (t.out || 0) * price.out + (t.cr || 0) * cr + (t.cw1h || 0) * price.in * 2 + (t.cw5m || 0) * price.in * 1.25) / 1e6;
}

/*
 * Мера для лимитов — токены с весом (просьба владельца 4 окт 2026: лимит не в долларах, а в токенах). Простая сумма
 * токенов не годится: почти вся она (96,6 %) — повторное чтение переписки из кэша, которое в десять раз легче нового
 * текста, и длинная сессия выглядела бы в разы «тяжелее», чем она есть. Поэтому каждый вид токенов берётся с постоянным
 * весом — тем же, что в ценах Anthropic относительно токена ввода: ввод ×1, ответ модели ×5, чтение из кэша ×0,1, запись
 * в кэш ×1,25 (на 5 минут) и ×2 (на час). Веса зашиты здесь: от таблицы цен (usage/prices.json) и курса доллара мера не
 * зависит, проценты у пользователей при смене цен не «поедут». Это приближение: точную формулу лимитов подписки
 * Anthropic не публикует. Простая сумма (raw) хранится рядом и показывается владельцу справочно — её можно сверить
 * с журналом Claude.
 */
export const WEIGHTS = { in: 1, out: 5, cr: 0.1, cw5m: 1.25, cw1h: 2 };
// Поправка на модель: токен более тяжёлой модели нагружает подписку сильнее. Отношение цены ввода модели к цене ввода
// Sonnet 5.5, на которой работает агент лаб (у неё множитель 1). Подбирается по началу названия, точные записи — выше.
// Считается для каждого вызова по его собственной модели (в одном журнале модели могут меняться).
const MODEL_FACTOR = [["claude-haiku", 0.5], ["claude-sonnet-5", 1], ["claude-sonnet-4", 1.5], ["claude-opus-5-5", 2], ["claude-opus", 2.5], ["claude-fable", 5]];
export const factorOf = (model) => MODEL_FACTOR.find(([k]) => String(model || "").startsWith(k))?.[1] ?? 1;
/** Токены с весом для набора { in, out, cr, cw5m, cw1h }; model — для поправки на модель (не задана — как Sonnet 5.5). */
export const tokensOf = (t, model) => Math.round(Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (Number(t[k]) || 0) * w, 0) * factorOf(model));
const rawOf = (t) => Object.keys(WEIGHTS).reduce((a, k) => a + (Number(t[k]) || 0), 0);
const USD_TO_TOKENS = 1e6 / DEFAULT_PRICES.default.in; // для старого файла лимитов в долларах: $1 = 500 тыс. токенов
const MAX_LIMIT = 1e12;
const RESERVE = 1e6; // запас на уже идущую работу, пока своих данных о средней работе нет (см. guard)

const mskDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date(ms)); // 2026-10-03
export const monthNow = () => mskDay(Date.now()).slice(0, 7);

/**
 * Чья это сессия: по первой инструкции в журнале. Рабочая папка лабы — moodle-work\<id> (владелец) или
 * moodle-work\users\<tg>\<id>; вид — лаба, окружение (env-instruction.md) или проверка своего отчёта.
 * Папка берётся ТОЛЬКО из подписи «Рабочая папка: `…`» / «Папка лабы: `…`», которую пишет сервер: перед ней в инструкции
 * стоят данные студента (группа, вариант), и путь, вписанный туда, не должен увести расход на владельца или на другого
 * человека (группу сервер к тому же проверяет: users.setGroup).
 */
const LABELLED = /(?:Рабочая папка|Папка лабы): `[^`\n]*?moodle-work[\\/]+(?:users[\\/]+(\d+)[\\/]+)?(?:check-)?(\d+)/;
// Подписи верим только в настоящей инструкции сервера: текст начинается с заголовка шаблона (перед ним OpenClaw может
// поставить метку времени в квадратных скобках). Журнал-продолжение начинается с очередного сообщения — в нём подпись мог
// написать сам студент, поэтому там работает только запасной способ (whoIn). Всё, что подставляется в инструкцию до
// подписи (название работы, курс, ФИО, группа, вариант), сервер чистит от «`» и переводов строк (lab.mjs newJob),
// а сообщение студента, начинающееся с «#», получает приставку «Сообщение студента:» (lab.mjs message).
const HEADER = /^\s*(?:\[[^\]\n]{0,80}\]\s*)*# (?:Лабораторная |Окружение для |Проверка отчёта студента)/;
export function whoOf(firstText) {
  const m = HEADER.test(firstText || "") && LABELLED.exec(firstText);
  if (!m) return { tgId: null, id: null, kind: "other" };
  const kind = /Ты — агент окружения/.test(firstText) ? "env" : /Проверка отчёта студента/.test(firstText) ? "check" : "lab";
  return { tgId: m[1] ? Number(m[1]) : OWNER_ID, id: m[2], kind };
}

/**
 * Запасной способ, когда первая запись журнала — не инструкция (4 окт 2026: журнал продолжения лабы после сна ПК начался
 * с заметки «ПК был в спящем режиме… продолжай», папки в ней нет — 0,76 млн токенов остались ничьими). Тогда берём
 * рабочую папку, которая чаще всех встречается в действиях самого агента (он читает и пишет в ней файлы): в разборе
 * журнала сюда передаются только записи модели, текст студента в счёт не идёт. Реже трёх раз — случайное упоминание.
 */
const WORK_DIR = /moodle-work[\\/]+(?:users[\\/]+(\d+)[\\/]+)?(check-)?(\d+)(?=[\\/"'`\s]|$)/g;
export function whoIn(records) {
  const count = new Map();
  // Папка считается не больше одного раза на запись модели: один файл, в который модель записала чужой путь сорок раз
  // (например, по просьбе студента «добавь список путей»), не должен перевесить десяток настоящих действий в своей папке.
  for (const rec of Array.isArray(records) ? records : String(records || "").split("\n")) {
    const seen = new Set();
    for (const m of String(rec).matchAll(WORK_DIR)) seen.add(`${m[1] || ""}:${m[2] ? "check" : "lab"}:${m[3]}`);
    for (const k of seen) count.set(k, (count.get(k) || 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 3) return null;
  const [tg, kind, id] = best[0].split(":");
  return { tgId: tg ? Number(tg) : OWNER_ID, id, kind };
}

const blankTokens = () => ({ in: 0, out: 0, cr: 0, cw1h: 0, cw5m: 0 });
/**
 * Разбор одного журнала: кому относится, модель и токены по дням. Чистая функция от текста файла; mtime — время файла,
 * на случай записей без метки времени. В каждом дне: суммы пяти видов токенов, число вызовов, tok — токены с весом
 * (каждый вызов — с множителем своей модели), models — те же пять сумм по моделям (для оценки в долларах).
 */
export function parseTranscript(text, { mtime = 0 } = {}) {
  const byId = new Map(); // id сообщения модели → { usage, at, model }
  let first = null, lastTs = 0, firstTs = 0;
  const own = []; // записи самой модели — для whoIn
  for (const line of text.split("\n")) {
    if (!line) continue;
    let x;
    try { x = JSON.parse(line); } catch { continue; }
    lastTs = Date.parse(x.timestamp) || lastTs;
    firstTs ||= lastTs;
    if (first === null && x.type === "user") {
      const c = x.message?.content;
      first = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("\n") : "";
    }
    if (x.type !== "assistant") continue;
    own.push(line);
    const u = x.message?.usage;
    if (!u || !x.message.id) continue;
    const prev = byId.get(x.message.id);
    // Одно сообщение записано несколькими строками (по блокам ответа) — берём строку с наибольшим числом токенов ответа.
    // Запись без метки времени получает время соседней записи (иначе при перечитывании журнала она «переезжала» бы в сегодня).
    if (!prev || (u.output_tokens || 0) >= (prev.usage.output_tokens || 0)) byId.set(x.message.id, { usage: u, at: Date.parse(x.timestamp) || prev?.at || lastTs, model: x.message.model || prev?.model });
  }
  const days = {};
  let model = null;
  for (const { usage: u, at, model: m } of byId.values()) {
    const mm = m && !/synthetic/.test(m) ? m : null;
    if (mm) model = mm;
    // Без метки времени и до первой метки в файле — время первой метки (не «сегодня»: иначе вызов переезжал бы в новый
    // день при каждой дозаписи журнала); меток нет вовсе — время файла.
    const d = (days[mskDay(at || firstTs || mtime || Date.now())] ||= { ...blankTokens(), calls: 0, tok: 0, models: {} });
    const cw = u.cache_creation_input_tokens || 0, h1 = u.cache_creation?.ephemeral_1h_input_tokens;
    const one = { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0,
      cw1h: h1 ?? 0, cw5m: h1 == null ? cw : (u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, cw - h1)) };
    const dm = (d.models[mm || ""] ||= blankTokens());
    for (const k of Object.keys(one)) { d[k] += one[k]; dm[k] += one[k]; }
    d.tok += tokensOf(one, mm);
    d.calls += 1;
  }
  const who = whoOf(first);
  return { who: who.tgId ? who : whoIn(own) || who, model, days };
}

const PARSER = 5; // версия разбора: журналы, разобранные прежней версией, перечитываются (пока Claude CLI их не удалил)
/*
 * Итоги по журналам (data.json). 15 окт 2026: раньше ЛЮБАЯ ошибка считалась порчей — файл, занятый дольше ~0,2 с,
 * откладывался (а если rename не удавался — перезаписывался без копии) и подменялся пустым, и пустой результат жил
 * в кэше до перезапуска: пропадали итоги по журналам, которые Claude CLI уже удалил, и manual-записи, лимиты переставали
 * срабатывать. Теперь занятый файл — повторы и ошибка (summary/guard получат её, guard ответит текстом), в кэш ничего
 * не кладётся. Испорченный JSON — копия data.json.bad-<время> (state-file.mjs), JSON не того вида — копия data.json.bad;
 * не удалось сделать копию — ошибка, с пустого не начинаем. Итоги — производные от журналов: дальше собираются заново.
 */
let data = null, dataLoading = null, scannedAt = 0, scanning = null;
async function load() {
  if (data) return data;
  dataLoading ??= (async () => {
    let d = await readStateJson(DATA, { missing: () => ({ files: {}, manual: [] }) });
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      try { await copyFile(DATA, `${DATA}.bad`); } catch (e) { throw new StateReadError(DATA, e); }
      console.log("usage: в data.json не то (не объект) — отложен как data.json.bad, итоги собираются заново");
      d = { files: {}, manual: [] };
    }
    d.files ||= {}; d.manual ||= [];
    return (data ??= d);
  })().finally(() => { dataLoading = null; });
  return dataLoading;
}

/**
 * Перечитать изменившиеся журналы. force — не ждать минуту с прошлого раза. Кроме журналов агента лаб читаются журналы
 * главного агента (чат бота в Telegram): к пользователям и лимитам они не относятся (вид chat), владелец видит их
 * отдельной строкой — чтобы было понятно, что ещё тратит подписку. Журналы подагентов (<сессия>\subagents\*.jsonl)
 * относятся туда же, куда сессия, которая их запустила.
 */
export async function scan({ force = false } = {}) {
  const d = await load();
  if (!force && Date.now() - scannedAt < SCAN_EVERY) return d;
  if (scanning) return scanning;
  scanning = (async () => {
    let changed = false;
    const take = async (path, key, who) => {
      const st = await stat(path).catch(() => null);
      const known = d.files[key];
      if (!st || (known && known.v === PARSER && known.size === st.size && known.mtime === st.mtimeMs)) return;
      try {
        const p = parseTranscript(await readFile(path, "utf8"), { mtime: st.mtimeMs });
        d.files[key] = { v: PARSER, size: st.size, mtime: st.mtimeMs, ...p, ...(who ? { who } : {}) };
        changed = true;
      } catch (e) { console.log(`usage: журнал ${key}: ${e.message || e}`); }
    };
    const CHAT = { tgId: null, id: null, kind: "chat" };
    for (const [dir, prefix] of [[TRANSCRIPTS, ""], [CHAT_TRANSCRIPTS, "chat/"]]) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl")) await take(join(dir, e.name), prefix + e.name, prefix ? CHAT : null);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        for (const f of (await readdir(join(dir, e.name, "subagents")).catch(() => [])).filter((x) => x.endsWith(".jsonl"))) await take(join(dir, e.name, "subagents", f), `${prefix}${e.name}/subagents/${f}`, prefix ? CHAT : null);
      }
    }
    // Подагент — в ту же работу, что и сессия, которая его запустила (она могла быть отнесена позже самого подагента).
    // Собственному тексту подагента не верим (поручение ему пишет модель): пока родитель не отнесён — он «служебный».
    for (const [key, f] of Object.entries(d.files)) {
      const m = /^([^/]+)\/subagents\//.exec(key);
      if (!m) continue;
      const parent = d.files[`${m[1]}.jsonl`]?.who;
      const want = parent?.tgId ? parent : { tgId: null, id: null, kind: "other" };
      if (f.who?.tgId !== want.tgId || f.who?.id !== want.id || f.who?.kind !== want.kind) { f.who = { ...want }; changed = true; }
    }
    if (changed) await writeJson(DATA, d).catch((e) => console.log(`usage: ${e.message || e}`));
    scannedAt = Date.now();
    return d;
  })().finally(() => { scanning = null; });
  return scanning;
}

/**
 * Запасной учёт для случая, когда журналов Claude CLI на этом ПК нет (тестовый стенд, другой способ запуска агента):
 * расход из ответа OpenClaw. Когда журналы есть, эта запись не ведётся — иначе расход посчитался бы дважды.
 */
export async function record(tgId, id, kind, u) {
  if (!u || existsSync(TRANSCRIPTS)) return;
  const d = await load();
  d.manual.push({ at: Date.now(), tgId: Number(tgId) || OWNER_ID, id: String(id), kind, in: Number(u.input) || 0, out: Number(u.output) || 0, cr: Number(u.cacheRead) || 0, cw5m: Number(u.cacheWrite) || 0, cw1h: 0, calls: 1 });
  if (d.manual.length > 20000) d.manual.splice(0, d.manual.length - 20000);
  await writeJson(DATA, d).catch(() => {});
}

/** Все записи расхода одной лентой: { tgId, id, kind, day, tok — токены с весом, raw — простая сумма, usd, calls, tokens }. */
async function rows() {
  const d = await scan(), p = await loadPrices();
  const out = [];
  for (const f of Object.values(d.files)) {
    if (!f.who?.tgId) continue;
    for (const [day, t] of Object.entries(f.days || {})) {
      // Запись старого разбора (журнал уже удалён, перечитать нельзя) — одна модель на весь журнал.
      const usd = t.models ? Object.entries(t.models).reduce((a, [m, x]) => a + costOf(x, priceOf(p, m || f.model)), 0) : costOf(t, priceOf(p, f.model));
      out.push({ ...f.who, day, calls: t.calls, tokens: t, tok: t.tok ?? tokensOf(t, f.model), raw: rawOf(t), usd });
    }
  }
  for (const m of d.manual || []) out.push({ tgId: m.tgId, id: m.id, kind: m.kind, day: mskDay(m.at), calls: m.calls || 1, tokens: m, tok: tokensOf(m), raw: rawOf(m), usd: costOf(m, priceOf(p, null)) });
  return out;
}
const round = (x) => Math.round(x * 100) / 100;

/**
 * Лимиты из usage/limits.json. Единица — токены с весом (пометка unit: "tokens"). Файл без пометки записан ещё в долларах
 * (первая версия, 4 окт 2026) — пересчитываем: $1 = 500 тыс. токенов (цена ввода Sonnet 5.5, $2 за миллион).
 * Файл, который читается, но содержит не то (не объект, лимит «5 млн» строкой, отрицательное число), считается таким же
 * испорченным, как нечитаемый: молча отбросить значение значило бы открыть работу без лимита.
 */
const limitValue = (v) => v == null || (typeof v === "number" ? Number.isFinite(v) && v >= 0 : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()));
function validLimits(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!limitValue(s.default)) return false;
  if (s.users != null && (typeof s.users !== "object" || Array.isArray(s.users) || !Object.values(s.users).every((v) => v != null && limitValue(v)))) return false;
  return true;
}
async function limits({ repair = false } = {}) {
  // Файл занят или не читается — не порча (15 окт 2026): ошибка уходит наверх как есть, и даже сохранение лимита
  // владельцем (repair) файл не трогает. Раньше временная блокировка в этот момент стирала лимиты всех пользователей и
  // отметки о предупреждениях. Владелец увидит ошибку и нажмёт ещё раз; студенту guard ответит понятным текстом.
  const text = await readStateText(LIMITS);
  let stored;
  try {
    stored = text === null ? {} : JSON.parse(text);
    if (!validLimits(stored)) throw new Error("в файле неверные значения");
    // Файл без пометки unit считается старым долларовым; если в него вручную вписали токены, после пересчёта выйдет
    // немыслимое число (то есть «лимита нет») — такой файл тоже считаем испорченным.
    const scale = stored.unit === "tokens" ? 1 : stored.unit === undefined ? USD_TO_TOKENS : NaN;
    if (!([stored.default, ...Object.values(stored.users || {})].every((v) => v == null || Number(v) * scale <= MAX_LIMIT))) throw new Error("в файле неверная единица или слишком большое значение");
  }
  catch (e) {
    // Файл испорчен (правили руками, оборвалась запись). Молча считать, что лимитов нет, нельзя. Студентам — отказ
    // с понятным текстом (guard), владелец видит это на своём экране; сохранение лимита владельцем (repair)
    // откладывает испорченный файл как limits.json.bad и начинает заново.
    if (!repair) throw Object.assign(new Error(`Файл лимитов usage/limits.json не читается (${e.message || e})`), { limitsBroken: true });
    // Испорченный файл не удалось отложить (занят) — с пустого не начинаем: иначе он был бы перезаписан без копии.
    try { await rename(LIMITS, `${LIMITS}.bad`); } catch (re) { if (re?.code !== "ENOENT") throw new StateReadError(LIMITS, re); }
    console.log(`usage: limits.json не читается (${e.message || e}) — отложен как limits.json.bad, лимиты задаются заново`);
    stored = { repaired: true };
  }
  const l = { default: null, users: {}, alerted: {}, ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) };
  const k = l.unit === "tokens" ? 1 : USD_TO_TOKENS;
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v) * k));
  l.default = num(l.default);
  l.users = Object.fromEntries(Object.entries(l.users || {}).map(([id, v]) => [id, num(v)]).filter(([, v]) => v !== null));
  l.alerted = l.alerted && typeof l.alerted === "object" && !Array.isArray(l.alerted) ? l.alerted : {};
  l.unit = "tokens";
  return l;
}
/**
 * Все изменения limits.json — по очереди: прочитать, изменить, записать. Иначе сохранение лимита владельцем и отметка
 * о предупреждении (alerts) затирали бы друг друга. fn возвращает { value, write } — писать ли файл.
 */
let limitsQueue = Promise.resolve();
function changeLimits(fn, { repair = false } = {}) {
  const run = limitsQueue.then(async () => {
    const l = await limits({ repair });
    const r = await fn(l);
    if (r.write) { delete l.repaired; await writeJson(LIMITS, l); }
    return r.value;
  });
  limitsQueue = run.catch(() => {});
  return run;
}
/** Лимит пользователя в токенах за месяц: личный, иначе общий; null — без лимита. Владелец — всегда без лимита. */
function limitOf(l, tgId) {
  if (Number(tgId) === OWNER_ID) return { limit: null, own: false };
  const own = l.users[String(tgId)];
  return own !== undefined ? { limit: own, own: true } : { limit: l.default ?? null, own: false };
}
// Процент — с округлением вниз: «100 %» появляется ровно тогда, когда срабатывает запрет, а не на 99,6 %.
const percentOf = (used, limit) => (limit > 0 ? Math.floor((used * 100) / limit) : 100);

/**
 * Сводка для экрана владельца: по каждому пользователю — этот месяц и всего (токены с весом — monthTok, totalTok; оценка
 * в долларах — month, total), сколько работ, лимит в токенах.
 */
export async function summary() {
  const all = await rows(), month = monthNow();
  // Испорченный файл лимитов не должен прятать от владельца сам расход: показываем без лимитов и с пометкой.
  let limitsBroken = false;
  const l = await limits().catch((e) => { if (!e.limitsBroken) throw e; limitsBroken = true; return { default: null, users: {}, alerted: {} }; });
  const users = new Map();
  const blank = (tgId) => ({ tgId, month: 0, total: 0, monthTok: 0, totalTok: 0, calls: 0, labs: new Set(), monthLabs: new Set(), last: "" });
  for (const r of all) {
    const u = users.get(r.tgId) || users.set(r.tgId, blank(r.tgId)).get(r.tgId);
    u.total += r.usd; u.totalTok += r.tok; u.calls += r.calls; u.labs.add(r.id);
    if (r.day.startsWith(month)) { u.month += r.usd; u.monthTok += r.tok; u.monthLabs.add(r.id); }
    if (r.day > u.last) u.last = r.day;
  }
  // Пользователи с личным лимитом, но ещё без расхода, тоже видны.
  for (const id of Object.keys(l.users)) if (!users.has(Number(id))) users.set(Number(id), blank(Number(id)));
  const list = [...users.values()].map((u) => ({ tgId: u.tgId, month: round(u.month), total: round(u.total), monthTok: u.monthTok, totalTok: u.totalTok, calls: u.calls, labs: u.labs.size, monthLabs: u.monthLabs.size, last: u.last || null, ...limitOf(l, u.tgId) }))
    .sort((a, b) => b.monthTok - a.monthTok || b.totalTok - a.totalTok);
  const sum = (k) => list.reduce((a, u) => a + u[k], 0);
  // Что тратит подписку помимо работ пользователей (в лимиты не входит): чат бота в Telegram — главный агент OpenClaw —
  // и сессии агента лаб без папки работы (проверки связи, разовые поручения).
  const other = { chat: { monthTok: 0, totalTok: 0 }, service: { monthTok: 0, totalTok: 0 } };
  for (const f of Object.values((await scan()).files)) {
    if (f.who?.tgId) continue;
    const o = f.who?.kind === "chat" ? other.chat : other.service;
    for (const [day, t] of Object.entries(f.days || {})) { const tok = t.tok ?? tokensOf(t, f.model); o.totalTok += tok; if (day.startsWith(month)) o.monthTok += tok; }
  }
  return { month, defaultLimit: l.default ?? null, users: list, monthTotal: round(sum("month")), total: round(sum("total")), monthTok: sum("monthTok"), totalTok: sum("totalTok"),
    monthRaw: all.filter((r) => r.day.startsWith(month)).reduce((a, r) => a + r.raw, 0), totalRaw: all.reduce((a, r) => a + r.raw, 0),
    other, weights: WEIGHTS, limitsBroken, source: existsSync(TRANSCRIPTS) ? "transcripts" : "reported" };
}

/**
 * Расход по работам: каждая работа — сколько вызовов, токенов (tok — с весом, raw — простая сумма) и долларов; по видам
 * (лаба, окружение, проверка) — kinds в долларах, kindsTok в токенах.
 */
export async function byLab() {
  const map = new Map();
  for (const r of await rows()) {
    const k = `${r.tgId}:${r.id}`;
    const x = map.get(k) || map.set(k, { tgId: r.tgId, id: r.id, usd: 0, tok: 0, raw: 0, calls: 0, in: 0, out: 0, cr: 0, cw: 0, kinds: {}, kindsTok: {}, days: new Set() }).get(k);
    x.usd += r.usd; x.tok += r.tok; x.raw += r.raw; x.calls += r.calls;
    x.in += r.tokens.in || 0; x.out += r.tokens.out || 0; x.cr += r.tokens.cr || 0; x.cw += (r.tokens.cw1h || 0) + (r.tokens.cw5m || 0);
    x.kinds[r.kind] = round((x.kinds[r.kind] || 0) + r.usd); x.kindsTok[r.kind] = (x.kindsTok[r.kind] || 0) + r.tok; x.days.add(r.day);
  }
  return [...map.values()].map((x) => ({ ...x, usd: round(x.usd), days: [...x.days].sort() })).sort((a, b) => b.tok - a.tok);
}

/**
 * Сколько токенов пользователь израсходовал в этом месяце и каков его лимит (для его профиля и для проверки перед
 * работой). level: ok — можно всё; start — закрыты новый отчёт, исправление и проверка (100 % и больше); all — закрыты
 * и сообщения в начатой работе (125 % и больше); closed — владелец поставил лимит 0.
 */
export async function own(tgId) {
  if (Number(tgId) === OWNER_ID) return { limit: null, used: null, percent: null, level: "ok" }; // до чтения лимитов: владельца не закрывает даже испорченный файл
  const { limit } = limitOf(await limits(), tgId);
  if (limit == null) return { limit: null, used: null, percent: null, level: "ok" };
  const month = monthNow();
  const used = (await rows()).filter((r) => r.tgId === Number(tgId) && r.day.startsWith(month)).reduce((a, r) => a + r.tok, 0);
  return { limit, used, percent: percentOf(used, limit), level: limit === 0 ? "closed" : used >= limit * HARD ? "all" : used >= limit * SOFT ? "start" : "ok" };
}

/** Запас на одну уже идущую работу: типичная (медианная) работа по накопленным данным; данных нет — миллион токенов. */
async function reserve() {
  const toks = (await byLab()).map((l) => l.tok).sort((a, b) => a - b);
  return toks.length ? toks[Math.floor(toks.length / 2)] : RESERVE;
}

/**
 * Проверка перед тратой: level "start" — новая лаба, исправление, проверка отчёта (до 100 % лимита); "message" — сообщение
 * в идущей лабе и «Кратко о работе» (до 125 %). Сверх лимита — ошибка с понятным текстом для студента.
 * running — сколько других работ этого пользователя уже идёт: их расход ещё не посчитан (он появляется в журналах по ходу
 * дела), поэтому на каждую держим в запасе среднюю работу — иначе у самой границы лимита можно запустить несколько сразу.
 */
export async function guard(tgId, level = "start", { running = 0 } = {}) {
  const o = await own(tgId).catch((e) => { if (e.limitsBroken) throw new Error("Лимиты сейчас не читаются — напишите владельцу бота, это чинится за минуту."); throw e; });
  if (o.limit == null) return;
  if (o.level === "closed") throw new Error("Работа агента для вас сейчас закрыта владельцем бота.");
  if (level === "message") {
    if (o.level === "all") throw new Error(`Лимит отчётов на этот месяц исчерпан (израсходовано ${o.percent} %). Продолжить можно будет с 1-го числа или когда владелец бота увеличит лимит. Готовый отчёт можно прикрепить и отправить и сейчас.`);
    // Несколько начатых работ, которым ответили разом, не должны все вместе уйти далеко за предел: пока идёт другая
    // работа, на неё держится запас — относительно того же порога в 125 %.
    if (running > 0 && o.used + running * (await reserve()) >= o.limit * HARD) throw new Error(`У вас уже идёт другая работа, а оставшегося лимита (израсходовано ${o.percent} %) может не хватить на обе сразу. Дождитесь её окончания и отправьте сообщение ещё раз.`);
    return;
  }
  if (o.level !== "ok") throw new Error(`Лимит отчётов на этот месяц исчерпан (израсходовано ${o.percent} %). Новый отчёт, исправление по замечаниям и проверка отчёта откроются 1-го числа — или попросите владельца бота увеличить лимит.${o.level === "start" ? " В уже начатой работе писать агенту пока можно." : ""}`);
  if (running > 0 && o.used + running * (await reserve()) >= o.limit) throw new Error(`У вас уже идёт работа, а оставшегося лимита (израсходовано ${o.percent} %) может не хватить на две сразу. Дождитесь её окончания — тогда будет видно, хватит ли на следующую.`);
}

/**
 * Владелец меняет лимит (в токенах за месяц): tgId = null — общий для всех; value = null — снять (у пользователя:
 * вернуться к общему); 0 — закрыть пользователю работу агента. Если действующий лимит у кого-то изменился, отметки
 * о предупреждениях этого месяца у него снимаются: о 80 % и 100 % нового лимита владелец узнает заново. Сохранение того
 * же значения ничего не меняет (иначе каждое нажатие «Сохранить» присылало бы прежние предупреждения повторно).
 */
export async function setLimit(tgId, value) {
  if (value != null && typeof value !== "number" && typeof value !== "string") throw new Error("Лимит — неотрицательное число (в токенах за месяц) или пусто, если лимит не нужен");
  const v = value === null || value === undefined || (typeof value === "string" && value.trim() === "") ? null : Number(value);
  if (v !== null && (!Number.isFinite(v) || v < 0 || v > MAX_LIMIT)) throw new Error("Лимит — неотрицательное число (в токенах за месяц) или пусто, если лимит не нужен");
  await changeLimits((l) => {
    const ids = new Set([...Object.keys(l.alerted).map((k) => k.split(":")[0]), ...Object.keys(l.users), ...(tgId == null ? [] : [String(tgId)])]);
    const before = new Map([...ids].map((id) => [id, limitOf(l, id).limit]));
    const next = v === null ? null : Math.round(v);
    const stored = tgId == null ? l.default ?? null : l.users[String(tgId)] ?? null;
    if (tgId == null) l.default = next;
    else if (next === null) delete l.users[String(tgId)];
    else l.users[String(tgId)] = next;
    for (const key of Object.keys(l.alerted)) {
      const id = key.split(":")[0];
      if (limitOf(l, id).limit !== before.get(id)) delete l.alerted[key];
    }
    return { write: stored !== next || l.repaired === true };
  }, { repair: true });
}

/**
 * Кого из пользователей пора показать владельцу: израсходовано 80 % и 100 % месячного лимита — по одному разу на порог
 * и месяц (после смены лимита — заново). Возвращает [{ tgId, percent, used, limit, level, closed }] (used и limit —
 * в токенах; closed — расход уже за 125 %, закрыта и начатая работа).
 * mark: false — только посмотреть: отметку «сообщено» ставит markAlerted после того, как сообщение действительно ушло.
 */
export async function alerts({ mark = true } = {}) {
  const s = await summary(); // до очереди: пересчёт журналов может занять секунды
  if (s.limitsBroken) throw Object.assign(new Error("файл лимитов usage/limits.json не читается"), { limitsBroken: true });
  return changeLimits((l) => {
    const out = [];
    for (const u of s.users) {
      const { limit } = limitOf(l, u.tgId); // лимит — свежий, на момент записи
      if (limit == null || limit <= 0) continue;
      for (const level of [100, 80]) {
        if (u.monthTok >= (limit * level) / 100 && !l.alerted[`${u.tgId}:${s.month}:${level}`]) {
          out.push({ tgId: u.tgId, level, month: s.month, percent: percentOf(u.monthTok, limit), used: u.monthTok, limit, closed: u.monthTok >= limit * HARD });
          break;
        }
      }
    }
    if (mark) setMarks(l, out);
    return { value: out, write: mark && out.length > 0 };
  });
}
function setMarks(l, list) {
  for (const a of list) {
    if (limitOf(l, a.tgId).limit !== a.limit) continue; // лимит за это время сменили — отметка относилась бы уже к новому лимиту
    l.alerted[`${a.tgId}:${a.month}:${a.level}`] = Date.now();
    if (a.level === 100) l.alerted[`${a.tgId}:${a.month}:80`] ||= Date.now(); // о 80 % после 100 % уже не пишем
  }
  // Отметки прошлых месяцев не копим.
  const month = monthNow();
  for (const k of Object.keys(l.alerted)) if (k.split(":")[1] !== month) delete l.alerted[k];
}
/** Отметить, что о пороге владельцу сообщено (после успешной отправки): list — записи из alerts({ mark: false }). */
export async function markAlerted(list) {
  if (!list?.length) return;
  await changeLimits((l) => { setMarks(l, list); return { write: true }; });
}
