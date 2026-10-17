import type { SessionInfo, SessionView } from "../store/api";
import { plural } from "./journal";

/** Подзаголовок шапки вкладки в виде «Сессия»: «5 семестр · БИСТ-24-ПО-2 · 3 курс». */
export const sessionSubtitle = (d: SessionView | null) =>
  (d && !d.needGroup ? [d.semester ? `${d.semester} семестр` : null, d.group, d.course ? `${d.course} курс` : null].filter(Boolean).join(" · ") : "") || "Даты, зачёты, экзамены и допуск";

// Даты и сроки сессии словами — общие для экрана «Сессия» и плитки на Главной (плитка не должна тянуть за собой
// весь экран: он грузится отдельной частью сборки).
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_G = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
/** «2027-01-12» → «12 янв» (long — «12 января»). */
export const dayText = (d: string, long = false) => `${Number(d.slice(8, 10))} ${(long ? MONTHS_G : MONTHS)[Number(d.slice(5, 7)) - 1]}`;
/** «5–25 января» или «29 декабря – 8 января». */
export const rangeText = (from: string, to: string) => (from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))}–${dayText(to, true)}` : `${dayText(from, true)} – ${dayText(to, true)}`);
/** Сколько дней до сессии словами: «через 82 дня», «идёт», «сегодня». */
export const whenText = (s: SessionInfo) => (s.state === "now" ? "идёт" : s.state === "past" ? "прошла" : s.days === 0 ? "сегодня" : s.days === 1 ? "завтра" : `через ${s.days} ${plural(s.days, "день", "дня", "дней")}`);
