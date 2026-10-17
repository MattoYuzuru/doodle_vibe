// Напоминания и уведомления в Telegram (через `openclaw message send`, модель не нужна), по каждому пользователю.
// Каждые 15 минут server.mjs вызывает check(tgId, items, courses): новые работы (внезапные тесты), напоминания за сутки и за 3 часа по настройкам
// пользователя, новые оценки из Moodle. Что уже отправлено — в notify/<tgId>.json, чтобы не дублировать.
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(DIR, "notify");
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const HOUR = 3600e3, DAY = 24 * HOUR;
const DEFAULT_REMINDER = "day";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const fmt = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
};
// Срок 00:00 показываем как 23:59 накануне (как в приложении).
const effective = (ms) => { const p = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)); return p === "00:00" ? ms - 60e3 : ms; };

const BOT_TOKEN = await readFile(join(DIR, "bot-token.txt"), "utf8").then((t) => t.replace(/^﻿/, "").trim()).catch(() => "");
/** Адрес мини-приложения (пишет tunnel-url.mjs); нужен для кнопки «В Джарвисе». */
const appUrl = () => readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
/** Кнопка «Открыть лабу» под сообщением бота: мини-приложение откроется сразу на чате этой лабораторной. */
export const labButton = (assignId) => appButton("Открыть лабу в Doodle", `lab:${assignId}`);
/** Кнопка, открывающая мини-приложение на нужном экране (?open=…, см. App.tsx). */
export async function appButton(text, open) {
  const app = await appUrl();
  return app ? [[{ text, web_app: { url: `${app}/?open=${open}` } }]] : undefined;
}

/**
 * Сообщение пользователю в Telegram. Бот может писать только тем, кто хоть раз нажал Start.
 * buttons — inline-кнопки Bot API (массив рядов). И текст, и вложение (media — путь к файлу, уходит документом) идут
 * напрямую в Bot API. Раньше вложение отправлялось через `openclaw message send --media`, а OpenClaw не отдаёт файлы
 * вне своих разрешённых папок: 1 окт 2026 отчёты других пользователей (moodle-work\users\…) в Telegram не дошли
 * («Local media path is not under an allowed directory»). openclaw остаётся запасным путём.
 */
export async function send(tgId, text, media, buttons) {
  if (media && BOT_TOKEN) {
    try {
      const form = new FormData();
      form.set("chat_id", String(tgId));
      // Подпись к документу — до 1024 знаков; длинный текст уходит отдельным сообщением перед файлом.
      if (text.length <= 1024) { form.set("caption", text); if (buttons?.length) form.set("reply_markup", JSON.stringify({ inline_keyboard: buttons })); }
      else await send(tgId, text, undefined, buttons);
      form.set("document", new Blob([await readFile(media)], { type: "application/pdf" }), basename(media));
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return true;
      console.error("telegram sendDocument:", j.description || r.status);
    } catch (e) { console.error("telegram sendDocument:", e.message); }
  }
  if (!media && BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ chat_id: tgId, text, disable_web_page_preview: true, ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return true;
      console.error("telegram sendMessage:", j.description || r.status);
    } catch (e) { console.error("telegram sendMessage:", e.message); }
  }
  return new Promise((resolve) => {
    const args = [OPENCLAW, "message", "send", "--channel", "telegram", "--target", String(tgId), "-m", text];
    if (media) args.push("--media", media, "--force-document");
    const p = spawn(process.execPath, args, { windowsHide: true });
    const t = setTimeout(() => p.kill(), 60e3);
    p.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

const stateFile = (tgId) => join(STATE_DIR, `${tgId}.json`);
// Поля по умолчанию добавляем и к прочитанному файлу: запись старого формата без grades/sent роняла всю проверку пользователя.
async function loadState(tgId) { return { sent: {}, grades: {}, prefs: {}, ...(await readFile(stateFile(tgId), "utf8").then(JSON.parse).catch(() => ({}))) }; }
// Полная проверка (15 мин) и быстрый опрос (2 мин) могут совпасть по времени: оба читают и пишут один файл состояния,
// и поздний писал бы поверх раннего (потерянные «виденные» → повторное «Новый тест»). Поэтому на пользователя — очередь.
const locks = new Map();
function withLock(tgId, fn) {
  const next = (locks.get(tgId) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(tgId, next);
  next.finally(() => { if (locks.get(tgId) === next) locks.delete(tgId); }).catch(() => {});
  return next;
}
// Пишем во временный файл и переименовываем: при нехватке места (ENOSPC) прежний файл остаётся целым, а не пустым.
// Пустой файл состояния однажды превратился в 22 «новых задания» — после сброса список «виденного» заполнялся заново.
async function saveState(tgId, s) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = stateFile(tgId) + ".tmp";
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, stateFile(tgId));
}

/**
 * Состояние уведомлений пользователя для других модулей (объявления и материалы — news.mjs, журнал — attendance.mjs):
 * fn получает состояние, может менять его — оно сохранится. Очередь та же, что у проверок работ, поэтому внутри fn
 * не должно быть долгих запросов к Moodle: сначала сходить в сеть, потом сравнить и записать.
 */
export const withState = (tgId, fn) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const out = await fn(state);
  await saveState(tgId, state);
  return out;
});

/** Настройки напоминаний пользователя: { "<deadlineId>": "day" | "3h" | "none" }. */
export async function loadPrefs(tgId) { return (await loadState(tgId)).prefs || {}; }
export const savePrefs = (tgId, prefs) => withLock(tgId, async () => { const s = await loadState(tgId); s.prefs = prefs; await saveState(tgId, s); });

/**
 * items — дедлайны пользователя (id, title, due, status, grade, gradeMax); courses — { id, short }.
 * Напоминание уходит, когда до срока осталось меньше окна (24 ч или 3 ч) и больше 0, один раз на дедлайн и окно.
 */
/** Кнопки под уведомлением о работе: открыть её в Moodle и в Джарвисе (карточка дедлайна). Работают в iOS, Android и Desktop. */
export async function buttonsFor(x) {
  const rows = [];
  if (!x) return rows; // сводное сообщение без конкретной работы
  const app = await appUrl();
  // Через страницу-прокладку сервера: она открывает приложение Moodle (moodlemobile://), а без него — сайт.
  if (x.url) rows.push([{ text: x.kind === "test" ? "Открыть тест в Moodle" : "Открыть в Moodle", url: app ? `${app}/go/moodle?u=${encodeURIComponent(x.url)}` : x.url }]);
  return rows;
}

/**
 * Новые работы: сравниваем с тем, что уже видели (state.seen). Тест в Moodle может появиться внезапно и с коротким окном —
 * сообщаем сразу. Первая проверка только запоминает, что есть, чтобы не засыпать пользователя всем списком.
 * У работы без срока (due = null) пишем «срок не указан».
 */
function noteNew(state, items, courseShort, now, out, mode = "full") {
  const ids = items.map((x) => x.id);
  // Первый проход каждого вида (полная проверка / быстрый опрос тестов) только запоминает — отдельные флаги, потому что
  // наборы разные: быстрый опрос видит тесты без срока, полная проверка — задания. Иначе один проход «засевал» бы
  // список, а другой считал бы всё остальное новым (так и пришла пачка уведомлений).
  const flag = mode === "quick" ? "seededQuick" : "seededFull";
  if (!Array.isArray(state.seen) || !state[flag]) {
    state.seen = [...new Set([...(Array.isArray(state.seen) ? state.seen : []), ...ids])];
    state[flag] = true;
    return;
  }
  const seen = new Set(state.seen);
  const fresh = items.filter((x) => !seen.has(x.id) && x.status === "open");
  // Предохранитель от потока: больше 5 «новых» разом — это не внезапные тесты, а смена списка (новый курс, сброс
  // состояния) — одно сообщение вместо пачки.
  if (fresh.length > 5) {
    const list = fresh.slice(0, 5).map((x) => `• ${x.title}`).join("\n");
    out.push({ x: null, text: `🆕 Появилось сразу ${fresh.length} новых работ (похоже, обновился список курсов):\n${list}\n…смотрите вкладку «Дедлайны».` });
    state.seen = [...new Set([...state.seen, ...ids])];
    return;
  }
  for (const x of fresh) {
    if (seen.has(x.id) || x.status !== "open") continue;
    const left = x.due ? effective(x.due) - now : null;
    const soon = left != null && left > 0 && left <= DAY ? `
⚠️ Осталось ${left < 2 * HOUR ? Math.max(1, Math.round(left / 60e3)) + " мин" : Math.round(left / HOUR) + " ч"}` : "";
    if (soon) state.sent[`${x.id}:day`] = now; // «завтра» не дублируем — срок уже в этом сообщении
    const opens = x.opensAt ? `открыт с ${fmt(x.opensAt)}, ` : "";
    const head = x.kind === "test" ? "🆕 Новый тест" : x.kind === "coursework" ? "🆕 Новый этап курсовой" : "🆕 Новое задание";
    out.push({ x, text: `${head}: ${x.title}
${courseShort.get(x.courseId) ?? ""} · ${opens}${x.due ? "до " + fmt(x.due) : "срок не указан"}${soon}` });
  }
  state.seen = [...new Set([...state.seen, ...ids])];
}

/** Пользователь изменил список курсов: работы новых курсов запоминаем молча, иначе старые тесты уйдут как «новые». */
export const reseed = (tgId, items) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  state.seen = [...new Set([...(Array.isArray(state.seen) ? state.seen : []), ...items.map((x) => x.id)])];
  state.seededQuick = true; state.seededFull = true;
  // То же с замечаниями преподавателя по работам включённого курса: они уже были, сообщать о них не нужно.
  state.remarks ??= {};
  for (const x of items) if (x.remarks?.length) state.remarks[x.id] = [...new Set([...(Array.isArray(state.remarks[x.id]) ? state.remarks[x.id] : []), ...x.remarks.map((r) => r.key)])].slice(-100);
  await saveState(tgId, state);
});

/**
 * Вопрос о курсе прошлого семестра, в котором появилась новая работа (moodle.pendingCourses): сам курс в дедлайны не
 * добавляется — спрашиваем пользователя, один раз на курс. Ответ он даёт в приложении («Курсы» → «Уточните»), и тот
 * сохраняется как ручной выбор курса. Отметку «спросили» ставим и при неудачной отправке (человек не нажал Start у бота):
 * вопрос всё равно виден в приложении, а повторять отправку каждые 15 минут незачем.
 */
export const askCourses = (tgId, pending) => withLock(tgId, async () => {
  if (!pending?.length) return 0;
  const state = await loadState(tgId);
  state.askedCourses ??= {};
  const fresh = pending.filter((p) => !state.askedCourses[p.id]);
  if (!fresh.length) return 0;
  const app = await appUrl();
  for (const p of fresh) {
    const text = `❓ В курсе «${p.fullname}» появилась работа «${p.title}»${p.section ? ` (раздел «${p.section}»)` : ""}, срок до ${fmt(effective(p.due))}.
Курс не из текущего семестра, поэтому в дедлайны он не добавлен. Это ваш курс сейчас?
${app ? "Ответьте в Doodle — кнопка ниже." : "Ответьте в Doodle: Профиль → Курсы."}`;
    await send(tgId, text, undefined, app ? [[{ text: "Ответить в Doodle", web_app: { url: `${app}/?open=courses` } }]] : undefined);
    state.askedCourses[p.id] = Date.now();
  }
  await saveState(tgId, state);
  return fresh.length;
});

/** Быстрая проверка (каждые 2 мин): только новые тесты — сообщение с кнопкой сразу. items — из moodle.quizzesQuick. */
export const checkNew = (tgId, items, courses) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const out = [];
  noteNew(state, items, new Map(courses.map((c) => [c.id, c.short])), Date.now(), out, "quick");
  for (const m of out) await send(tgId, m.text, undefined, await buttonsFor(m.x));
  await saveState(tgId, state);
  return out.length;
});

export const check = (tgId, items, courses) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const prefs = state.prefs || {};
  const now = Date.now();
  const courseShort = new Map(courses.map((c) => [c.id, c.short]));
  const out = [];

  noteNew(state, items, courseShort, now, out);

  for (const x of items) {
    if (x.status !== "open") continue;
    const pref = prefs[x.id] ?? DEFAULT_REMINDER;
    if (pref === "none") continue;
    const left = effective(x.due) - now;
    const windows = pref === "3h" ? [["3h", 3 * HOUR]] : [["day", DAY], ["3h", 3 * HOUR]];
    for (const [key, ms] of windows) {
      const k = `${x.id}:${key}`;
      if (state.sent[k] || left <= 0 || left > ms) continue;
      // Если уже меньше 3 часов, «завтра» не шлём — уйдёт только «через N ч».
      if (key === "day" && left <= 3 * HOUR) { state.sent[k] = now; continue; }
      const h = Math.round(left / HOUR);
      out.push({ x, text: `⏰ ${key === "day" ? "Завтра" : "Через ~" + h + " ч"} срок: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · до ${fmt(x.due)}` });
      state.sent[k] = now;
    }
  }

  for (const x of items) {
    if (x.grade == null) continue;
    const prev = state.grades[x.id];
    if (prev === undefined) { state.grades[x.id] = x.grade; continue; } // первая синхронизация: только запоминаем
    if (prev !== x.grade) {
      out.push({ x, text: `📝 Оценка: ${x.title}\n${courseShort.get(x.courseId) ?? ""} · ${x.grade}${x.gradeMax ? ` из ${x.gradeMax}` : ""}` });
      state.grades[x.id] = x.grade;
    }
  }

  // Замечания преподавателя (отзыв к оценке и комментарии к ответу): о каждом новом — сообщение. Новое — то, чьей метки
  // (key из moodle.mjs) ещё не было: запись в комментариях или отзыв, переписанный после повторной проверки.
  // Первая проверка после появления этой функции только запоминает то, что уже есть.
  state.remarks ??= {};
  for (const x of items) {
    if (!x.remarks?.length) continue;
    const prev = state.remarks[x.id];
    const known = new Set(Array.isArray(prev) ? prev : []);
    const fresh = x.remarks.filter((r) => !known.has(r.key));
    if (!fresh.length) continue;
    state.remarks[x.id] = [...known, ...fresh.map((r) => r.key)].slice(-100);
    if (!state.remarksSeeded) continue;
    const last = fresh[fresh.length - 1];
    out.push({ x, text: `💬 Замечание преподавателя: ${x.title}\n${courseShort.get(x.courseId) ?? ""}${last.author ? ` · ${last.author}` : ""}\n«${last.text.slice(0, 500)}${last.text.length > 500 ? "…" : ""}»\n${fresh.length > 1 ? `Новых замечаний: ${fresh.length}, все` : "Полный текст"} — в карточке работы в Doodle.` });
  }
  state.remarksSeeded = true;

  for (const m of out) await send(tgId, m.text, undefined, await buttonsFor(m.x));
  await saveState(tgId, state);
  return out.length;
});

// ---------- изменения расписания ----------
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dayLabel = (iso) => { const d = new Date(`${iso}T12:00:00Z`); return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const todayMsk = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
const pairOf = (l) => [l.start, l.name, l.place || "", l.typeLabel || ""];
const pairKey = (p) => p.join("|");

/**
 * Изменения расписания группы (просьба владельца, 3 окт 2026): основа — официальное расписание МИСИС, переносы и
 * замены приходят с «Дневача» (schedule.mjs). Каждую проверку (15 мин) пары пользователя (его подгруппа) с сегодняшнего
 * дня сравниваются со снимком прошлой проверки, и обо всём, что поменялось в уже известных днях, — одно сообщение.
 * Первая проверка, смена группы или подгруппы — только запоминают. Новые дни в конце окна — не изменение. Если пропало
 * больше половины пар и ничего не появилось — это сбой данных (файл МИСИС не разобрался и т. п.), а не отмена: не пишем
 * и снимок не трогаем. Возвращает число изменений.
 */
export const checkSchedule = (tgId, group, subgroup, lessons) => withLock(tgId, async () => {
  const state = await loadState(tgId);
  const today = todayMsk();
  const days = {};
  for (const l of lessons) {
    if (l.change === "removed" || l.date < today || (l.subgroup && l.subgroup !== subgroup)) continue;
    (days[l.date] ||= []).push(pairOf(l));
  }
  const prev = state.schedule;
  const remember = async () => { state.schedule = { group, subgroup, days }; await saveState(tgId, state); };
  if (!prev || prev.group !== group || prev.subgroup !== subgroup) { await remember(); return 0; }
  const lines = [];
  let gone = 0, before = 0, added = 0;
  for (const [date, was] of Object.entries(prev.days || {})) {
    if (date < today) continue;
    before += was.length;
    const now = days[date];
    if (!now) { if (date <= Object.keys(days).sort().at(-1)) gone += was.length; else continue; } // день ушёл из окна — не изменение
    const nowKeys = new Set((now || []).map(pairKey)), wasKeys = new Set(was.map(pairKey));
    const del = was.filter((p) => !nowKeys.has(pairKey(p))), add = (now || []).filter((p) => !wasKeys.has(pairKey(p)));
    if (!del.length && !add.length) continue;
    gone += now ? del.length : 0;
    added += add.length;
    const out = [];
    for (const d of del) {
      // Та же пара появилась в другое время или в другой аудитории — это перенос, а не отмена и новая пара.
      const same = add.find((a) => a[1] === d[1]);
      if (same) {
        add.splice(add.indexOf(same), 1);
        out.push(same[0] !== d[0] ? `«${d[1]}» перенесена с ${d[0]} на ${same[0]}${same[2] ? `, ${same[2]}` : ""}`
          : `«${d[1]}», ${d[0]}: аудитория ${same[2] || "не указана"} (была ${d[2] || "не указана"})`);
      } else out.push(`отменена «${d[1]}», ${d[0]}`);
    }
    for (const a of add) out.push(`новая пара «${a[1]}»${a[3] ? ` (${a[3].toLowerCase()})` : ""}, ${a[0]}${a[2] ? `, ${a[2]}` : ""}`);
    lines.push(`${dayLabel(date)}:`, ...out.map((t) => `• ${t}`));
  }
  if (!lines.length) { await remember(); return 0; }
  if (gone > before / 2 && !added) { console.log(`notify ${tgId}: расписание: пропало ${gone} из ${before} пар без замен — похоже на сбой данных, не пишу`); return 0; }
  await remember();
  const app = await appUrl();
  const text = [`📅 Изменения в расписании · ${group}`, ...lines.slice(0, 24), lines.length > 24 ? `…и ещё ${lines.length - 24} строк — всё в Doodle.` : ""].filter(Boolean).join("\n");
  await send(tgId, text, undefined, app ? [[{ text: "Открыть расписание", web_app: { url: `${app}/?tab=plan` } }]] : undefined);
  return lines.filter((l) => l.startsWith("•")).length;
});
