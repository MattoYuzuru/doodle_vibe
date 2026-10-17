// Даты. Все сроки показываем по Москве: так же их показывает Moodle МИСИС.
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
export const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

type Parts = { y: number; m: number; d: number; hh: number; mm: number };
/**
 * Москва — фиксированный UTC+3 с 26.10.2014, перевода часов нет; если его вернут — вернуть Intl.DateTimeFormat
 * с timeZone "Europe/Moscow". Проверка 15 окт: formatToParts стоил ~3,6 мкс на вызов, а сортировки и группировки трёх
 * вкладок делали их ~1500 на каждое обновление стора; сдвиг на 3 часа в 25 раз быстрее и совпадает с Intl на всех
 * датах с 2020 года.
 */
const MSK_OFFSET = 3 * HOUR;
export function mskParts(ms: number): Parts {
  const d = new Date(ms + MSK_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

/** Ключ дня в Москве: "2026-09-30". */
export const dayKey = (ms: number) => {
  const p = mskParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};
export const todayKey = () => dayKey(Date.now());
export const keyToUtc = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const addDays = (key: string, n: number) => new Date(keyToUtc(key) + n * DAY).toISOString().slice(0, 10);
/** 0 = понедельник. */
export const weekdayIdx = (key: string) => (new Date(keyToUtc(key)).getUTCDay() + 6) % 7;
export const weekStart = (key: string) => addDays(key, -weekdayIdx(key));

/** Срок 00:00 на деле означает «до конца предыдущего дня»: показываем 23:59 накануне. */
export const effectiveDue = (due: number) => {
  const p = mskParts(due);
  return p.hh === 0 && p.mm === 0 ? due - 60e3 : due;
};
/** День, к которому относится дедлайн в плане и группировке. */
export const dueDayKey = (due: number) => dayKey(effectiveDue(due));

/** «до 4 окт, 23:59» */
export function formatDue(due: number) {
  const p = mskParts(effectiveDue(due));
  return `до ${p.d} ${MONTHS_SHORT[p.m - 1]}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** «Среда, 30 сентября» */
export function formatLongDate(key: string) {
  const d = new Date(keyToUtc(key));
  const w = WEEKDAYS[weekdayIdx(key)];
  return `${w[0].toUpperCase()}${w.slice(1)}, ${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`;
}

/** «Пн, 20 окт» — короткая дата для строк, где место дорого (проверка 15 окт: «Ближайшие занятия» на 360 px). */
export function formatShortDate(key: string) {
  const d = new Date(keyToUtc(key));
  return `${WEEKDAYS_SHORT[weekdayIdx(key)]}, ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** Обратный отсчёт: «4 д 12 ч», «5 ч 20 мин», «просрочено 1 д». */
export function formatLeft(due: number, now = Date.now()) {
  const s = effectiveDue(due) - now;
  const a = Math.abs(s);
  const d = Math.floor(a / DAY), h = Math.floor((a % DAY) / HOUR), m = Math.floor((a % HOUR) / 60e3);
  const text = d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(m, 1)} мин`;
  return s >= 0 ? text : `просрочено ${d > 0 ? `${d} д` : h > 0 ? `${h} ч` : `${Math.max(m, 1)} мин`}`;
}

/** Остаток словами для плашек в списках (18 окт 2026): «через 40 мин», «через 19 ч», «через 2 дня», «через 8 дней». */
export function formatLeftWords(due: number, now = Date.now()) {
  const s = effectiveDue(due) - now;
  if (s <= 0) return "просрочено";
  const pl = (n: number, a: string, b: string, c: string) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const d = Math.floor(s / DAY), h = Math.floor(s / HOUR), m = Math.max(1, Math.floor(s / 60e3));
  return d >= 2 ? `через ${d} ${pl(d, "день", "дня", "дней")}` : h >= 1 ? `через ${h} ч` : `через ${m} мин`;
}

/** Короткий остаток для плиток: «8 д», «19 ч», «40 мин», «просрочено». */
export function formatLeftShort(due: number, now = Date.now()) {
  const s = effectiveDue(due) - now;
  if (s <= 0) return "просрочено";
  const d = Math.floor(s / DAY), h = Math.floor(s / HOUR), m = Math.floor(s / 60e3);
  return d > 0 ? `${d} д` : h > 0 ? `${h} ч` : `${Math.max(m, 1)} мин`;
}

/** Части отсчёта для крупного вывода: [[4, "д"], [12, "ч"]]. */
export function leftParts(due: number, now = Date.now()): [number, string][] {
  return splitDuration(Math.max(effectiveDue(due) - now, 0));
}
/** Сколько прошло после срока: [[16, "ч"], [5, "мин"]]. */
export function elapsedParts(due: number, now = Date.now()): [number, string][] {
  return splitDuration(Math.max(now - effectiveDue(due), 0));
}
function splitDuration(s: number): [number, string][] {
  const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / HOUR), m = Math.floor((s % HOUR) / 60e3);
  return d > 0 ? [[d, "д"], [h, "ч"]] : h > 0 ? [[h, "ч"], [m, "мин"]] : [[Math.max(m, s > 0 ? 1 : 0), "мин"]];
}
