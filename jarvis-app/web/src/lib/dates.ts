// Даты. Все сроки показываем по Москве: так же их показывает Moodle МИСИС.
const TZ = "Europe/Moscow";
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
export const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

type Parts = { y: number; m: number; d: number; hh: number; mm: number };
const fmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function mskParts(ms: number): Parts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
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

/** Обратный отсчёт: «4 д 12 ч», «5 ч 20 мин», «просрочено 1 д». */
export function formatLeft(due: number, now = Date.now()) {
  const s = effectiveDue(due) - now;
  const a = Math.abs(s);
  const d = Math.floor(a / DAY), h = Math.floor((a % DAY) / HOUR), m = Math.floor((a % HOUR) / 60e3);
  const text = d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(m, 1)} мин`;
  return s >= 0 ? text : `просрочено ${d > 0 ? `${d} д` : h > 0 ? `${h} ч` : `${Math.max(m, 1)} мин`}`;
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
