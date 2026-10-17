// Расписание пар с сайта «Дневач» (dnevuch.ru): страница группы содержит массив scheduleData, главная — список групп.
// Кэш по группе 6 часов в памяти и копия на диске (schedule-cache/<группа>.json), чтобы сайт не дёргать и переживать его недоступность.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as official from "./official.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(DIR, "schedule-cache");
const TTL = Number(process.env.SCHEDULE_TTL_MS) || 6 * 3600e3; // переменная — только для тестов
const UA = { "user-agent": "Mozilla/5.0 (JarvisMiniApp)" };

const TYPE = { "Лекционные": "lecture", "Лабораторные": "lab", "Практические": "practice", "Семинарские": "practice" };

/**
 * Массив после `scheduleData =` — по балансу скобок с учётом строк, а не до «;\n»: если сайт уберёт перевод строки или
 * внутри названия пары встретится «;», прежний поиск обрезал бы JSON и расписание пропадало бы целиком.
 */
function extractArray(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) throw new Error("на странице нет расписания");
  const p = html.indexOf("[", i);
  if (p < 0) throw new Error("на странице нет расписания");
  let depth = 0, str = null;
  for (let k = p; k < html.length; k++) {
    const ch = html[k];
    if (str) { if (ch === "\\") k++; else if (ch === str) str = null; continue; }
    if (ch === '"' || ch === "'") str = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { if (--depth === 0) return html.slice(p, k + 1); }
  }
  throw new Error("расписание на странице не дочитано");
}

function parse(html) {
  const days = JSON.parse(extractArray(html, "scheduleData"));
  const out = [];
  // Каждый день — массив слотов, но иногда день приходит одним объектом; пустые слоты («Место для заметок») пропускаем.
  for (const day of days) for (const slot of Array.isArray(day) ? day : [day]) {
    if (!slot || !slot.time || !Array.isArray(slot.classes)) continue;
    const [start, end] = slot.time.split(/\s*-\s*/);
    for (const c of slot.classes) {
      const sub = (c.subGroup || "").match(/\((\d*)\)\s*$/)?.[1] || "";
      out.push({ date: slot.date, start, end, name: c.name, type: TYPE[c.lessonType] || "other", typeLabel: c.lessonType || "",
        teacher: c.teacher || "", place: (c.place || "").replace(/^ауд\.\s*/i, ""), subgroup: sub });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

const mem = new Map(); // группа → { at, group, lessons }
const safe = (g) => g.replace(/[^\p{L}\p{N}-]/gu, "_");

// Сайт расписания бывает недоступен с ПК (2 окт: не отвечал вовсе) — тогда каждый запрос ждал ~10 с ошибки и только
// потом отдавал копию. Теперь: есть копия — отдаём сразу (устаревшую обновляем в фоне); после сбоя 5 минут сайт не
// дёргаем; ждём сайт только без копии или при ручном обновлении, когда он отвечает.
const BACKOFF = 5 * 60e3;
const failed = new Map();   // группа → { at, error }
const inflight = new Map(); // группа → идущий запрос к сайту

function fetchFresh(group) {
  if (!inflight.has(group)) {
    inflight.set(group, (async () => {
      try {
        const res = await fetch(`https://dnevuch.ru/raspisanie-misis?group=${encodeURIComponent(group)}`, { headers: UA, signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`dnevuch ${res.status}`);
        const data = { at: Date.now(), group, source: "dnevuch.ru", lessons: parse(await res.text()) };
        mem.set(group, data);
        failed.delete(group);
        await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
        await writeFile(join(CACHE_DIR, `${safe(group)}.json`), JSON.stringify(data)).catch(() => {});
        return data;
      } catch (e) {
        failed.set(group, { at: Date.now(), error: String(e.message || e) });
        throw e;
      } finally { inflight.delete(group); }
    })());
  }
  return inflight.get(group);
}

async function dnevuch(group, force = false) {
  let m = mem.get(group);
  if (!m) {
    m = await readFile(join(CACHE_DIR, `${safe(group)}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (m) mem.set(group, m);
  }
  const fresh = m && Date.now() - m.at < TTL;
  const fail = failed.get(group);
  const down = fail && Date.now() - fail.at < BACKOFF;
  const stale = () => ({ ...m, stale: true, ...(fail ? { error: fail.error } : {}) });
  if (m && fresh && !force) return m;
  if (m && (down || !force)) {
    if (!down) fetchFresh(group).catch(() => {});
    return fresh ? m : stale();
  }
  try { return await fetchFresh(group); }
  catch (e) { if (m) return stale(); throw e; }
}

/*
 * Расписание группы (решение владельца, 3 окт 2026): основа — официальное расписание МИСИС (official.mjs) на
 * WEEKS_AHEAD недель — текущую и две следующие. «Дневач» показывает переносы и замены: в неделе, где у него есть хоть
 * одна пара, день сверяется с официальным, и где они расходятся — берётся «Дневач», а пара помечается: change
 * "added" (новая или перенесена сюда), "removed" (отменена или перенесена отсюда; остаётся в списке, чтобы её показать
 * зачёркнутой), "place" (другая аудитория, was — прежняя). Об изменениях пишет бот (notify.checkSchedule). Группы
 * нет в официальных файлах — только «Дневач»; «Дневача» нет — только официальное.
 */
const WEEKS_AHEAD = 3;
const nameKey = (n) => String(n || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 14);
const placeKey = (p) => String(p || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const samePair = (a, b) => a.start === b.start && nameKey(a.name) === nameKey(b.name);
/**
 * Пары одного дня: официальные (основа) против «Дневача». Совпало — показываем пару из расписания МИСИС; на «Дневаче»
 * другая аудитория — его вариант этой пары (change: "place", was — прежняя); пары нет в МИСИС — новая (change: "added");
 * пары МИСИС нет на «Дневаче» — отменена (change: "removed", приложение показывает её зачёркнутой).
 * Подгруппы источники пишут по-разному (лекция одной строкой или по подгруппам) — пару узнаём по времени и предмету.
 */
export function diffDay(off, dn) {
  const out = [];
  const target = new Map(); // пара «Дневача» → официальная, с которой она совпала
  for (const l of dn) {
    const peers = off.filter((o) => samePair(o, l));
    if (!peers.length) { out.push({ ...l, source: "dnevuch", change: "added" }); continue; }
    target.set(l, peers.find((p) => (p.subgroup || "") === (l.subgroup || "")) || peers[0]);
  }
  const moved = (l, o) => !!placeKey(o.place) && !!placeKey(l.place) && placeKey(o.place) !== placeKey(l.place);
  // Официальная пара, у которой хоть одна подгруппа сменила аудиторию, целиком заменяется вариантом «Дневача».
  const replaced = new Set([...target].filter(([l, o]) => moved(l, o)).map(([, o]) => o));
  for (const [l, o] of target) if (replaced.has(o)) out.push(moved(l, o) ? { ...l, source: "dnevuch", change: "place", was: o.place } : { ...l, source: "dnevuch" });
  for (const o of off) {
    if (replaced.has(o)) continue;
    out.push(dn.some((l) => samePair(o, l)) ? { ...o, source: "official" } : { ...o, source: "official", change: "removed" });
  }
  return out;
}
/**
 * Недели, которые «Дневач» показывает целиком: в них его день главнее официального (отличия — изменения). Неделя, где у
 * «Дневача» меньше трёх пар или меньше половины официальных, считается ещё не выложенной (он выкладывает неделю не
 * сразу) — иначе все её остальные пары выглядели бы отменёнными и пришло бы ложное уведомление.
 */
export function coveredWeeks(real, offLessons) {
  const count = (list) => list.reduce((m, l) => m.set(official.mondayOf(l.date), (m.get(official.mondayOf(l.date)) || 0) + 1), new Map());
  const dn = count(real), of = count(offLessons);
  return new Set([...dn].filter(([w, n]) => n >= 3 && n >= (of.get(w) || 0) / 2).map(([w]) => w));
}
export async function schedule(group, force = false) {
  if (!group) throw new Error("группа не задана");
  let base = null, error = null;
  try { base = await dnevuch(group, force); } catch (e) { error = e; }
  const real = base?.lessons || [];
  if (real.length) void official.calibrate(group, real).catch(() => {});
  const from = official.mondayOf(official.todayMsk());
  // Пока официальные файлы готовятся (первый запуск), ответ с «Дневача» не задерживаем; ждём их, только если «Дневача» нет.
  const off = await official.lessonsFor(group, from, WEEKS_AHEAD, { wait: !base }).catch(() => null);
  if (!base && !off) throw error || new Error("расписание группы не найдено");
  const covered = coveredWeeks(real, off?.lessons || []);
  const days = new Map(); // дата → { off: [], dn: [] }
  const day = (d) => days.get(d) || days.set(d, { off: [], dn: [] }).get(d);
  for (const l of off?.lessons || []) day(l.date).off.push(l);
  for (const l of real) day(l.date).dn.push(l);
  const lessons = [];
  for (const [date, d] of days) {
    if (!off) lessons.push(...d.dn); // группы нет в официальных файлах (или они ещё грузятся) — «Дневач» как есть
    else if (!covered.has(official.mondayOf(date))) lessons.push(...d.off);
    else lessons.push(...diffDay(d.off, d.dn));
  }
  lessons.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || (a.change === "removed") - (b.change === "removed"));
  const changes = lessons.filter((l) => l.change).length;
  return { ...(base || { at: Date.now(), group, source: "misis.ru" }), lessons, changes, official: off ? { file: off.file, updated: off.stamp } : null };
}

let groupsCache = null;
/** Все группы: «Дневач» и официальные файлы МИСИС (у «Дневача» — его написание). */
export async function groupList(force = false) {
  let err = null;
  const [dn, off] = await Promise.all([dnevuchGroups(force).catch((e) => { err = e; return []; }), official.groups().catch(() => [])]);
  const seen = new Set(dn.map(official.normGroup));
  const all = [...dn, ...off.filter((g) => !seen.has(official.normGroup(g)))];
  if (!all.length) throw err || new Error("список групп не найден");
  return all;
}
/** Список всех групп на «Дневаче» (кэш 24 ч, копия на диске). */
async function dnevuchGroups(force = false) {
  if (!force && groupsCache && Date.now() - groupsCache.at < 24 * 3600e3) return groupsCache.groups;
  try {
    const html = await fetch("https://dnevuch.ru/raspisanie-misis", { headers: UA, signal: AbortSignal.timeout(25000) }).then((r) => r.text());
    const groups = [...html.matchAll(/"number":"([^"]+)"/g)].map((m) => m[1]);
    if (!groups.length) throw new Error("список групп не найден");
    groupsCache = { at: Date.now(), groups };
    await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
    await writeFile(join(CACHE_DIR, "_groups.json"), JSON.stringify(groupsCache)).catch(() => {});
    return groups;
  } catch (e) {
    if (groupsCache) return groupsCache.groups;
    const disk = await readFile(join(CACHE_DIR, "_groups.json"), "utf8").then(JSON.parse).catch(() => null);
    if (disk) { groupsCache = disk; return disk.groups; }
    throw e;
  }
}
