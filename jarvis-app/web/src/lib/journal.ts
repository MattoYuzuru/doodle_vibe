/** Общие мелочи вкладки «Журнал» и плитки журнала на Главной. */
import type { EjSubject, SheetSource, SheetSubject } from "../store/api";

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
/** Откуда таблица: «таблица «Журнал» в курсе Moodle, лист БИСТ-24_ПО_2, обновлена 14 окт». */
export function sheetSourceText(s: SheetSource | null | undefined) {
  if (!s) return "таблица преподавателя в курсе Moodle";
  const where = s.kind === "yandex" ? "на Яндекс Диске (ссылка в курсе Moodle)" : s.kind === "google" ? "в Google Таблицах (ссылка в курсе Moodle)" : "в курсе Moodle";
  const d = s.modified ? new Date(s.modified + 3 * 3600e3) : null;
  const when = d && !Number.isNaN(d.getTime()) ? `, ${s.kind === "google" ? "прочитана" : "обновлена"} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : "";
  const sheet = s.sheet && !/^(sheet|лист)\s*\d*$/i.test(s.sheet) ? `, лист ${s.sheet}` : "";
  return `таблица «${s.title || s.file || "без названия"}» ${where}${sheet}${when}`;
}

export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
};

/**
 * Дисциплины журнала вместе с таблицами преподавателей (EjState.sheets): у дисциплины журнала без отметок о посещении
 * посещаемость берётся из таблицы её курса; дисциплины, которых в журнале нет, — отдельно. Для плитки на Главной и
 * вкладки «Журнал»: одно правило в обоих местах. notMine — дисциплины, которые студент назвал не своими (EjData.notMine):
 * их таблица не цепляется ни к карточке, ни отдельной карточкой — ни по id, ни по названию (16 окт 2026).
 */
export function withSheets(subjects: EjSubject[], sheets: SheetSubject[], notMine: EjSubject[] = []) {
  const ids = new Set(subjects.map((s) => s.id));
  // Таблица без привязки (сервер собирал её без данных журнала — после перезапуска или сбоя журнала), а дисциплина с
  // тем же названием на экране есть (из сохранённой копии) — к её карточке, а не второй карточкой (проверка 16 окт).
  // Название без пометок в скобках и «. Осень 2026»: «Базы данных (БИСТ)» — та же дисциплина, что «Базы данных».
  const key = (n: string) => n.toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)/g, " ").replace(/\.\s*(осень|весна)\s+\d{4}.*$/, "").replace(/[^a-zа-я0-9]+/g, " ").trim();
  const byName = new Map(subjects.map((s) => [key(s.name), s.id]));
  // Если сервер сам сопоставлял с журналом этого семестра (ejKnown), его «нет в журнале» главнее: на экране может быть
  // старая копия журнала прошлого семестра с той же дисциплиной. Два курса с одним названием — вторая таблица отдельно.
  const off = new Set(notMine.map((s) => s.id)), offNames = new Set(notMine.map((s) => key(s.name)));
  const of = new Map<number, SheetSubject>(), loose: SheetSubject[] = [];
  for (const x of sheets) {
    const id = x.ejId != null && ids.has(x.ejId) ? x.ejId : x.ejKnown ? undefined : byName.get(key(x.name));
    // Таблица «не моей» дисциплины (по id; без привязки — по названию, как выше) — не показываем вовсе.
    if (id == null && (x.ejId != null ? off.has(x.ejId) : !x.ejKnown && offNames.has(key(x.name)))) continue;
    if (id != null && !of.has(id)) of.set(id, x); else loose.push(x);
  }
  const hasAtt = (s: EjSubject) => !!s.lessons && s.lessons.present + s.lessons.absent > 0;
  const attendanceOf = (s: EjSubject) => { const x = of.get(s.id); return x && !hasAtt(s) && x.attendance != null ? x.attendance : s.attendance; };
  // Пропуски из таблиц — туда, где посещения взяты из таблицы (дисциплина без отметок в журнале или её нет в журнале):
  // иначе сводка писала «Пропусков нет» рядом с карточкой «3 пропуска».
  const used = [...subjects.filter((s) => of.has(s.id) && !hasAtt(s)).map((s) => of.get(s.id)!), ...loose].filter((x) => x.lessons);
  const absences = used.reduce((n, x) => n + x.absences.length, 0);
  const missedHours = used.reduce((n, x) => n + (x.lessons?.missedHours || 0), 0);
  return { of, loose, attendanceOf, hasAtt, absences, missedHours };
}
/** Те же ли это источники (лист одной таблицы): посещения из другой таблицы подписываются отдельно. */
export const sameSource = (a: SheetSource | null | undefined, b: SheetSource | null | undefined) =>
  !!a && !!b && (a.ref && b.ref ? a.ref === b.ref : a.url === b.url && a.file === b.file) && (a.sheet ?? null) === (b.sheet ?? null);
/** Предупреждение к своей строке: найдена по инициалам или на листе другой группы. */
export const sheetCaveat = (s: SheetSource | null | undefined) =>
  s?.match === "initials" ? "Строка найдена по фамилии и инициалам — сверьте с таблицей, ваша ли она."
    : s?.groupRel === "other" ? `Строка найдена ${s.group ? `на листе группы ${s.group}` : "в списке другой группы"} — по полному ФИО. Если это не вы, сверьте с таблицей.`
    : null;

/** 87.5 → «87,5%»; null — журнал не посчитал. */
export const pct = (v: number | null) => (v == null ? "—" : `${String(Math.round(v * 10) / 10).replace(".", ",")}%`);

/** Цвет доли, как в самом журнале: от 75% — зелёный, от 50% — обычный (base), ниже — красный. */
export const tone = (v: number | null, base = "var(--c-accent)") =>
  v == null ? "var(--c-hint)" : v >= 75 ? "var(--c-green)" : v >= 50 ? base : "var(--c-red)";
