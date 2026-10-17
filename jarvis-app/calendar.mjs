// Календарь в телефоне (просьба владельца, 4 окт 2026): лента в формате iCalendar (.ics) для подписки из обычного
// календаря — пары группы на шесть недель и сроки сдачи из Moodle. Календарная программа сама перечитывает ленту, так что
// новые работы и изменения расписания появляются без участия студента. Ссылка у каждого своя, с секретом (users.calToken):
// подписи Telegram у календарных программ нет.
//
// Адрес. У приложения он временный (быстрый туннель Cloudflare меняет его при каждом запуске), а подписке нужен постоянный.
// Поэтому лента отдаётся через постоянный адрес из calendar-base.txt (бесплатный домен ngrok; его держит cal-tunnel.mjs,
// и снаружи через него открыт только путь /cal/). Нет такого файла — подписки нет, приложение предлагает разовый файл.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as moodle from "./moodle.mjs";
import * as official from "./official.mjs";
import { schedule } from "./schedule.mjs";
import * as users from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(DIR, "cal-cache");
const BASE_FILE = join(DIR, "calendar-base.txt");
const WEEKS = 6;                 // пары: текущая неделя и пять следующих (ближние три — с переносами «Дневача»)
const TTL = 10 * 60e3;           // одну ленту пересобираем не чаще раза в 10 минут
const CAL_DATA_MS = 2 * 3600e3;  // дедлайны для ленты: уже прочитанные не старше этого — без нового чтения Moodle (см. collect)
const DAY = 864e5;

/**
 * Постоянный адрес для подписки («https://….ngrok-free.dev») или "" — тогда подписки нет.
 * Переменная CAL_BASE (17 окт 2026, VPS) перекрывает calendar-base.txt: ngrok не пускает агентов с российских IP,
 * и на сервере CAL_BASE пустая — приложение предлагает разовый файл, а не подписку на мёртвый адрес.
 */
export const stableBase = () => (process.env.CAL_BASE !== undefined
  ? Promise.resolve(process.env.CAL_BASE.trim().replace(/[/]+$/, "")) : fileBase());
const fileBase = () => readFile(BASE_FILE, "utf8").then((t) => t.replace(/^\uFEFF/, "").trim().replace(/[/]+$/, ""), () => "");

// ---------- формат iCalendar ----------
const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Строка не длиннее 75 байт; продолжение — с пробела (RFC 5545). Режем по символам, чтобы не разорвать букву UTF-8. */
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20261005T060000Z
const uid = (...parts) => `${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 20)}@doodle-misis`;
function vevent(e, now) {
  return ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`, `SUMMARY:${esc(e.summary)}`,
    e.location ? `LOCATION:${esc(e.location)}` : "", e.description ? `DESCRIPTION:${esc(e.description)}` : "", e.url ? `URL:${e.url}` : "",
    `CATEGORIES:${esc(e.category)}`, "TRANSP:" + (e.busy ? "OPAQUE" : "TRANSPARENT"), "END:VEVENT"].filter(Boolean);
}
export function ics(name, events, now = Date.now()) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Doodle//MISIS//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, "X-WR-TIMEZONE:Europe/Moscow", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ...events.flatMap((e) => vevent(e, now)), "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------- события ----------
const TYPE_SHORT = { lecture: "лек.", lab: "лаб.", practice: "пр." };
/** Пара: время в расписании московское (UTC+3 круглый год). */
export function lessonEvent(group, l) {
  const at = (hm) => Date.parse(`${l.date}T${hm}:00+03:00`);
  const note = l.change === "place" ? `Изменение: аудитория ${l.place || "не указана"} (была ${l.was || "не указана"}).` : l.change === "added" ? "Изменение в расписании: новая или перенесённая пара." : "";
  return {
    uid: uid("lesson", group, l.date, l.start, l.name, l.subgroup || ""),
    start: at(l.start), end: at(l.end),
    summary: `${l.name}${TYPE_SHORT[l.type] ? ` (${TYPE_SHORT[l.type]})` : ""}`,
    location: l.place || "",
    description: [l.typeLabel, l.teacher, l.subgroup ? `подгруппа ${l.subgroup}` : "", note].filter(Boolean).join("\n"),
    category: "Пара", busy: true,
  };
}
/** Срок сдачи: получасовое событие, которое кончается в момент срока (срок 00:00 — как 23:59 накануне, как в приложении). */
export function deadlineEvent(x, course) {
  const msk = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(x.due));
  const end = msk === "00:00" ? x.due - 60e3 : x.due;
  const kind = x.kind === "test" ? "Тест до" : "Срок";
  return {
    uid: uid("deadline", x.id),
    start: end - 30 * 60e3, end,
    summary: `${kind}: ${x.title}${course ? ` · ${course}` : ""}`,
    description: [course, x.kind === "test" && x.opensAt ? `Тест открыт с ${new Date(x.opensAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}` : "", x.url ? `Открыть в Moodle: ${x.url}` : ""].filter(Boolean).join("\n"),
    url: x.url || "", category: "Срок сдачи", busy: false,
  };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** События пользователя: пары его группы и подгруппы и открытые работы Moodle. parts — что удалось получить. */
async function collect(tgId) {
  const p = await users.profile(tgId);
  const events = [], parts = { lessons: null, deadlines: null };
  if (p.group) {
    try {
      const near = await schedule(p.group);
      const mine = (l) => !l.subgroup || l.subgroup === (p.subgroup || "1");
      const list = near.lessons.filter((l) => l.change !== "removed" && mine(l));
      // Дальше трёх недель «Дневача» не бывает — только официальное расписание МИСИС (праздники и конец семестра оно знает само).
      const from = addDays(official.mondayOf(official.todayMsk()), 21);
      const far = await official.lessonsFor(p.group, from, WEEKS - 3, { wait: false }).catch(() => null);
      const seen = new Set(list.map((l) => `${l.date}|${l.start}|${l.name}`));
      for (const l of far?.lessons || []) if (mine(l) && !seen.has(`${l.date}|${l.start}|${l.name}`)) list.push(l);
      for (const l of list) events.push(lessonEvent(p.group, l));
      parts.lessons = list.length;
    } catch (e) { parts.lessonsError = String(e.message || e); }
  } else parts.lessons = 0;
  const token = await users.moodleToken(tgId);
  if (token) {
    try {
      moodle.setOverrides(token, await users.courseOverrides(tgId), tgId);
      // Опрос подписки (раз в час у каждого) идёт в очереди людей, наравне с открывающими приложение (15 окт 2026):
      // уже прочитанное моложе 2 часов (и копия с диска после перезапуска) годится — сданная работа просто повисит
      // событием чуть дольше. Старше — читаем, а если Moodle не ответил, берём то, что есть.
      const have = moodle.staleDeadlines(token);
      const d = have && Date.now() - (have.updated || 0) < CAL_DATA_MS ? have
        : await moodle.deadlines(token, false, { allowDisk: true }).catch((e) => { if (have) return have; throw e; });
      const course = new Map(d.courses.map((c) => [c.id, c.short || c.name]));
      const open = d.items.filter((x) => x.status === "open" && x.due && x.due > Date.now() - 7 * DAY);
      for (const x of open) events.push(deadlineEvent(x, course.get(x.courseId)));
      parts.deadlines = open.length;
    } catch (e) { parts.deadlinesError = String(e.message || e); }
  } else parts.deadlines = 0;
  events.sort((a, b) => a.start - b.start);
  return { events, parts, group: p.group };
}

const mem = new Map(); // tgId → { at, body }
const file = (tgId) => join(CACHE_DIR, `${tgId}.ics`);
/**
 * Лента пользователя. Собирается не чаще раза в 10 минут. Если расписание или Moodle сейчас не ответили, отдаём прошлую
 * удачную ленту (она лежит и на диске): неполная лента стёрла бы из календаря телефона все события недоступной части.
 */
export async function feed(tgId) {
  const c = mem.get(tgId);
  if (c && Date.now() - c.at < TTL) return c.body;
  const { events, parts, group } = await collect(tgId);
  const complete = parts.lessons !== null && parts.deadlines !== null;
  if (!complete) {
    const prev = c?.body ?? await readFile(file(tgId), "utf8").catch(() => null);
    console.log(`calendar ${tgId}: ${parts.lessonsError ? `расписание: ${parts.lessonsError}` : ""}${parts.deadlinesError ? ` Moodle: ${parts.deadlinesError}` : ""} — ${prev ? "отдаю прошлую ленту" : "отдаю, что есть"}`);
    if (prev) { mem.set(tgId, { at: Date.now() - TTL + 60e3, body: prev }); return prev; } // через минуту попробуем снова
  }
  const body = ics(`Doodle · ${group || "МИСИС"}`, events);
  if (complete) {
    mem.set(tgId, { at: Date.now(), body });
    await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
    const tmp = `${file(tgId)}.tmp`;
    await writeFile(tmp, body).then(() => rename(tmp, file(tgId))).catch(() => {});
  }
  return body;
}
/** Группа, подгруппа или список курсов изменились — ленту собрать заново при следующем запросе. */
export const forget = (tgId) => { mem.delete(tgId); };

/**
 * Ссылки для экрана «Календарь в телефоне». stable — есть ли постоянный адрес (тогда подписка обновляется сама);
 * без него — только разовый файл по временному адресу приложения (appUrl).
 */
export async function links(tgId, appUrl, { reset = false } = {}) {
  const [token, base] = await Promise.all([users.calToken(tgId, { reset }), stableBase()]);
  if (reset) forget(tgId);
  const path = `/cal/${token}.ics`;
  const host = (base || appUrl || "").replace(/^https?:\/\//, "");
  const webcal = `webcal://${host}${path}`;
  return {
    stable: !!base,
    url: `${base || appUrl || ""}${path}`,
    webcal,
    // Страницы-прокладки на адресе приложения: календарная ссылка webcal:// из Telegram сама не открывается.
    apple: appUrl ? `${appUrl}/go/calendar?to=apple&t=${token}` : webcal,
    google: appUrl ? `${appUrl}/go/calendar?to=google&t=${token}` : `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    file: `${appUrl || base || ""}${path}?download=1`,
  };
}
