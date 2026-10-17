// Типичные замечания преподавателей — общая база, по которой агент проверяет отчёт перед сдачей (просьба владельца,
// 3 окт 2026: «чтобы отчёт реже возвращали на доработку»).
//
// Откуда: каждые 15 минут server.mjs и так получает из Moodle работы каждого пользователя вместе с замечаниями
// преподавателя (для уведомлений, notify.check). Если пользователь согласился делиться (Профиль → «Делиться
// замечаниями»; у владельца — по умолчанию да), копия замечаний к его работам кладётся сюда. Новых запросов в Moodle
// ради базы нет, и чужие сданные файлы не читаются: только тексты замечаний.
//
// Обезличивание: без автора (имени преподавателя), без ФИО студента в тексте, без оценки и файлов. Источник — только
// псевдоним (хеш Telegram id), чтобы при отказе от согласия убрать замечания этого человека (purge).
// Одинаковые замечания у разных студентов — одна запись с числом источников («встречалось у 3»).
//
// Хранение: lessons/<assignId>.json — { assignId, title, courseId, course, items: [{ tkey, text, srcs, returnedBy, agentBy,
// firstAt, lastAt }] } (returnedBy/agentBy — тоже псевдонимы: после отказа от согласия пометки от этого человека уходят). Для агента — файл «ТИПИЧНЫЕ ЗАМЕЧАНИЯ.md» в папке лабы (writeForLab), его он проверяет перед сдачей.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STORE = process.env.LESSONS_DIR || join(DIR, "lessons");
export const LESSONS_FILE = "ТИПИЧНЫЕ ЗАМЕЧАНИЯ.md";
const MAX_ITEMS = 60; // на одну работу: старые без повторов вытесняются
const MAX_TEXT = 1500;

const sha = (s) => createHash("sha1").update(s).digest("hex");
/** Псевдоним источника: по нему находятся замечания человека при отказе от согласия; Telegram id в базе нет. */
export const srcOf = (tgId) => sha(`doodle-lessons:${Number(tgId)}`).slice(0, 10);
const norm = (t) => t.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const assignOf = (itemId) => { const m = /^moodle:assign:(\d+)$/.exec(String(itemId)); return m ? Number(m[1]) : null; };

// «Принято», «Зачтено», «+» и т. п. — не замечание: проверять по ним нечего.
const PRAISE = /^(принято|принята|зачтено|зачтена|защищено|защищена|защитил[аи]?|хорошо|отлично|молодец|молодцы|ок|ok|окей|верно|правильно|\+|✓|👍|5|отл\.?)[\s.!,)]*$/i;
export function useful(text) {
  const t = String(text || "").trim();
  return t.length >= 12 && !PRAISE.test(t) && /\p{L}{3}/u.test(t);
}

// Фразы про оценку и баллы («Итоговый балл: 4 из 4», «+1 балл за показ — учтено», «Работа проверена», «Замечаний нет»)
// — не замечания: в базу не идут (и оценок в базе быть не должно). Предложение с баллом, но и с претензией
// («оценка снижена: нет графика») остаётся.
const NOISE = [
  /^(работа )?(проверена|принята|зачтена)[.!]?$/i,
  /^замечаний( по отч[её]ту)?( нет| нету)?[.!]?$/i,
  /^без замечаний[.!]?$/i,
  /^замечания (не критичн|по порядку|для информации)/i,
  /балл.*(повыш|начисл|уч[тч][её]н|включ[её]н)/i,
  /^\+?\s*\d+\s*балл/i,
  /итогов\S* балл/i,
  /^(оценка|балл)\s*[:—-]?\s*\d/i,
];
const GRADE = /балл|оценк|(?<![\p{L}\d])\d+(?:[.,]\d+)?\s*из\s*\d+/iu;
const DEFECT = /(?<![\p{L}])(нет|не|надо|нужно)(?![\p{L}])|отсутств|неверн|некоррект|неправильн|ошиб|должн|необходимо|исправ|добав|убер|не хватает|непонятн|обоснов|переделат|не соответств/iu;
export function clean(text) {
  const out = [];
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    const kept = line.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z0-9«"(])/u).map((x) => x.trim()).filter((x) => x && !NOISE.some((r) => r.test(x)) && !(GRADE.test(x) && !DEFECT.test(x)));
    if (kept.length) out.push(kept.join(" "));
  }
  return out.join("\n").trim();
}

/**
 * Убирает из текста ФИО студента (во всех падежах — по основе слова), почту и телефоны. names — полное ФИО
 * («Иванов Иван Иванович»). Основа: слово без последних 1–2 букв и с выпавшей гласной («Павел» → «Павл-»), не короче 4 букв.
 */
export function anonymize(text, names = "") {
  let t = String(text || "").replace(/\r/g, "").trim();
  const stems = new Set();
  for (const w of String(names).split(/\s+/).filter((x) => x.length >= 3)) {
    const lw = w.toLowerCase();
    for (const s of [lw, lw.slice(0, -1), lw.slice(0, -2), lw.replace(/[еоё](\p{L})$/u, "$1")]) if (s.length >= 4 || s === lw) stems.add(s);
  }
  for (const s of [...stems].sort((a, b) => b.length - a.length)) {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Короткая основа («лев», «вера») совпала бы с обычными словами («левый», «веранда») — её ищем только с заглавной буквы.
    const re = s.length <= 4
      ? new RegExp(`(?<![\\p{L}])${esc[0].toUpperCase()}${esc.slice(1)}\\p{L}{0,3}(?![\\p{L}])`, "gu")
      : new RegExp(`(?<![\\p{L}])${esc}\\p{L}{0,3}(?![\\p{L}])`, "giu");
    t = t.replace(re, ""); // метка, а не «[студент]»: иначе следующая основа (фамилия «Студентов») совпала бы с самой меткой
  }
  t = t.replace(//g, "[студент]");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[почта]").replace(/(?<!\d)(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, "[телефон]");
  return t.replace(/(\[студент\][\s,]*){2,}/g, "[студент] ").slice(0, MAX_TEXT);
}

// Запись — по очереди: сбор (каждые 15 минут) и отказ от согласия (кнопка в приложении) могут прийти одновременно.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.catch(() => {}).then(fn));
const fileOf = (assignId) => join(STORE, `${Number(assignId)}.json`);
const readStore = (assignId) => readFile(fileOf(assignId), "utf8").then(JSON.parse).catch(() => null);
async function writeStore(data) {
  await mkdir(STORE, { recursive: true });
  const tmp = `${fileOf(data.assignId)}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, fileOf(data.assignId));
}

/**
 * Сбор после очередной проверки Moodle. items/courses — из moodle.deadlines (у работ remarks, submission, courseId).
 * fullName — ФИО студента (для обезличивания); agentMade(assignId) — делал ли отчёт агент (тогда замечание — сигнал,
 * что агент ошибся, и оно помечается). Возвращает число новых записей.
 */
export function harvest(tgId, items, courses, { fullName = "", agentMade = async () => false } = {}) {
  return serial(async () => {
    const src = srcOf(tgId), names = new Map((courses || []).map((c) => [c.id, c.name]));
    let added = 0;
    for (const x of items || []) {
      const assignId = assignOf(x.id);
      if (!assignId || !x.remarks?.length) continue;
      const remarks = x.remarks.map((r) => ({ ...r, text: anonymize(clean(r.text), fullName) })).filter((r) => useful(r.text));
      if (!remarks.length) continue;
      const data = (await readStore(assignId)) || { assignId, title: x.title || null, courseId: x.courseId ?? null, course: names.get(x.courseId) || null, items: [] };
      data.title = x.title || data.title; data.courseId = x.courseId ?? data.courseId; data.course = names.get(x.courseId) || data.course;
      // Работу вернули на доработку (Moodle: «повторная попытка» или «черновик» после проверки) — замечания весомее.
      const returned = ["reopened", "draft"].includes(x.submission?.status);
      const agent = await agentMade(assignId).catch(() => false);
      let changed = false;
      for (const r of remarks) {
        const text = r.text;
        const tkey = sha(norm(text)).slice(0, 12);
        const at = r.at || Date.now();
        let it = data.items.find((i) => i.tkey === tkey);
        if (!it) { it = { tkey, text, srcs: [], returnedBy: [], agentBy: [], firstAt: at, lastAt: at }; data.items.push(it); added++; changed = true; }
        for (const [list, on] of [[it.srcs, true], [it.returnedBy, returned], [it.agentBy, agent]]) if (on && !list.includes(src)) { list.push(src); changed = true; }
        if (at > it.lastAt) { it.lastAt = at; changed = true; }
      }
      if (!changed) continue;
      data.items.sort((a, b) => b.lastAt - a.lastAt);
      data.items = data.items.slice(0, MAX_ITEMS);
      data.updatedAt = Date.now();
      await writeStore(data);
    }
    return added;
  });
}

/** Отказ от согласия: замечания этого человека убираются из базы (запись остаётся, если то же было у других). */
export function purge(tgId) {
  return serial(async () => {
    const src = srcOf(tgId);
    let removed = 0;
    for (const f of (await readdir(STORE).catch(() => [])).filter((n) => /^\d+\.json$/.test(n))) {
      const data = await readStore(Number(f.slice(0, -5)));
      if (!data?.items?.some((i) => i.srcs.includes(src))) continue;
      for (const i of data.items) for (const k of ["srcs", "returnedBy", "agentBy"]) i[k] = i[k].filter((s) => s !== src);
      const before = data.items.length;
      data.items = data.items.filter((i) => i.srcs.length);
      removed += before - data.items.length;
      data.updatedAt = Date.now();
      await writeStore(data);
    }
    return removed;
  });
}

const rank = (a, b) => (!!b.agentBy.length - !!a.agentBy.length) || (!!b.returnedBy.length - !!a.returnedBy.length) || (b.srcs.length - a.srcs.length) || (b.lastAt - a.lastAt);
const line = (i, n) => {
  const tags = [i.agentBy.length && "к отчёту, который делал агент", i.returnedBy.length && "работу вернули на доработку", i.srcs.length > 1 && `встречалось у ${i.srcs.length}`].filter(Boolean);
  return `${n}. ${tags.length ? `[${tags.join("; ")}] ` : ""}${i.text.replace(/\n{2,}/g, "\n").replace(/\n/g, "\n   ")}`;
};

/**
 * Текст файла для агента: замечания по этой работе, затем — по другим работам того же курса (обычно об оформлении).
 * courseId / course — курс работы: другие работы курса ищутся по id курса, а если он неизвестен — по названию.
 * Возвращает { text, count } или null, если замечаний нет.
 */
export async function forLab(assignId, course = "", courseIdHint = null) {
  const own = await readStore(assignId);
  const others = [];
  const courseId = own?.courseId ?? courseIdHint ?? null, courseName = String(own?.course || course || "").trim().toLowerCase();
  for (const f of (await readdir(STORE).catch(() => [])).filter((n) => /^\d+\.json$/.test(n) && Number(n.slice(0, -5)) !== Number(assignId))) {
    const d = await readStore(Number(f.slice(0, -5)));
    if (!d?.items?.length) continue;
    if ((courseId && d.courseId === courseId) || (courseName && String(d.course || "").trim().toLowerCase() === courseName)) others.push(d);
  }
  const mine = (own?.items || []).slice().sort(rank).slice(0, 25);
  const rest = others.flatMap((d) => d.items.map((i) => ({ ...i, from: d.title }))).sort(rank).slice(0, 15);
  if (!mine.length && !rest.length) return null;
  const parts = ["# Типичные замечания преподавателя (обезличено)", "",
    "Собраны из проверенных работ студентов, согласившихся ими поделиться: без имён, оценок и файлов. Это не образец отчёта, а список того, за что преподаватель уже снижал баллы или возвращал работу.", ""];
  if (mine.length) parts.push(`## По этой работе${own?.title ? ` («${own.title}»)` : ""}`, "", ...mine.map((i, k) => line(i, k + 1)), "");
  if (rest.length) parts.push("## По другим работам этого курса (чаще всего — оформление и общие требования)", "", ...rest.map((i, k) => line(i, k + 1) + (i.from ? `\n   (работа «${i.from}»)` : "")), "");
  return { text: parts.join("\n"), count: mine.length + rest.length };
}

/** Кладёт актуальный список в папку лабы перед ходом агента; возвращает число пунктов (0 — замечаний пока нет). */
export async function writeForLab(dir, assignId, course, courseId = null) {
  const r = await forLab(assignId, course, courseId).catch(() => null);
  const path = join(dir, LESSONS_FILE);
  if (!r) {
    await writeFile(path, "# Типичные замечания преподавателя\n\nПо этой работе и этому курсу замечаний пока не собрано. Проверь отчёт по методичке и общим правилам оформления.\n").catch(() => {});
    return 0;
  }
  await writeFile(path, r.text);
  return r.count;
}
