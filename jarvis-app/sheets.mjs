// Таблицы преподавателей из курсов Moodle (Excel): своя строка студента, баллы и посещения (просьба владельца,
// 15 окт 2026: «в методах оптимизации есть вкладка журнал с эксель таблицей… брать данные для сессии именно оттуда»;
// «многие преподаватели выставляют баллы в эксель таблицах курса»). Здесь только чистые функции над сеткой ячеек,
// которую выдаёт sheet_xls.py; поиск файлов в курсе, скачивание и кэш — course-sheets.mjs.
//
// Таблицы пишутся как угодно. Виды, на которых проверено (NOTES.md п. 144):
//   — журнал по занятиям: лист на группу, шапка «Лекции | Лабораторные | Практические» с датами и «Л 1…», строка
//     максимумов (2, 3, 12…, 100), баллы или «Н» в ячейках, итог формулой =SUM(…) («Методы оптимизации», 2026);
//   — журнал посещений «+ / Н» с подсчётом «процент посещения», «баллы за посещения», «Итого — баллы за активное…»;
//   — итоги: «ФИО | институт | группа | баллы за семестр | … | итоговые баллы | оценка», все группы на одном листе;
//   — таблицы без баллов (варианты заданий) — не баллы, пропускаются; рейтинг-план в Excel («90-100 | Отлично») —
//     только пороги (planText → moodle-plan.parsePlan).
// Чего правила не узнали — честно «не разобрали», без догадок: уверенность (confidence) решает, считать ли пороги.
// Главное правило — чужую строку не выдать за свою: при сомнении (однофамильцы, только инициалы без группы) —
// «не нашли» или «неоднозначно», а не баллы соседа (проверка 16 окт).
import { groupPrefixes } from "./official.mjs";

// ---------- ячейки ----------
export const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(/[\s ]+/g, " ").trim();
export const text = (v) => (v == null ? "" : typeof v === "object" ? String(v.d ?? "") : String(v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const NUM_STR = /^[-+]?\d+(?:[.,]\d+)?$/;
/** Число в ячейке: число или строка «1,5». */
export const numOf = (v) => (isNum(v) ? v : typeof v === "string" && NUM_STR.test(v.trim()) ? Number(v.trim().replace(",", ".")) : null);
const r2 = (x) => Math.round(x * 100) / 100;
const DAY = 86400e3;
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const validDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && y >= 2000 && y <= 2100;
/**
 * Дата из ячейки: {d} от sheet_xls.py, строка «10.09.2026», «10.09.26», «10.09», число-дата Excel (serial) — только
 * при allowSerial (строка дат в шапке). Обычное число (максимум 1,5) — не дата. Год у «10.09» — тот, при котором дата
 * ближе всего к обновлению файла в окне «7 месяцев назад — 5 месяцев вперёд» (январский экзамен в октябрьском файле —
 * следующий год, июньская пара в февральском — этот). null — не дата.
 */
export function dateOf(v, refMs = Date.now(), { allowSerial = false } = {}) {
  if (v && typeof v === "object" && /^\d{4}-\d\d-\d\d/.test(v.d || "")) return v.d.slice(0, 10);
  if (isNum(v)) return allowSerial && v > 36000 && v < 60000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY).toISOString().slice(0, 10) : null;
  const m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?:\s*г\.?)?$/.exec(text(v).trim());
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  if (m[3]) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return validDay(y, mo, d) ? iso(y, mo, d) : null; }
  const y0 = new Date(refMs).getUTCFullYear();
  let best = null;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    if (!validDay(y, mo, d)) continue;
    const diff = Date.UTC(y, mo - 1, d) - refMs;
    if (diff < -214 * DAY || diff > 153 * DAY) continue;
    if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { y, diff };
  }
  return best ? iso(best.y, mo, d) : null;
}

// Значения ячеек занятия: «+», «Н», «Б»…
const PLUS = /^(\+|✓|✔|v|да|был|была|присутств\S*)$/;
const ABSENT = /^(н|нб|н\/б|н\.б\.?|нп|отс\S*|не был\S*|неявка|прогул|-н-)$/;
const EXCUSED = /^(б|бол\S*|ув|у|уваж\S*|спр\S*|осв\S*|ув\.?\s*пр\S*)$/;
/** Состояние ячейки: num (оценка/балл), plus (был), absent (Н), excused (уважительная), empty, text (прочее). */
export function stateOf(v) {
  if (isNum(v)) return "num";
  const s = norm(text(v));
  if (!s) return "empty";
  if (NUM_STR.test(s)) return "num";
  if (PLUS.test(s)) return "plus";
  if (ABSENT.test(s)) return "absent";
  if (EXCUSED.test(s)) return "excused";
  return "text";
}

// ---------- группы ----------
const LATG = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
const upG = (s) => String(s || "").normalize("NFC").toUpperCase().replace(/[ABCEHKMOPTXY]/g, (ch) => LATG[ch]);
// Профиль («ПО») — только целиком: иначе в «ГР-24-ПО-1-3» откат давал обрубок «ГР-24-П». Год набора 15–39, как в
// moodle-plan GROUP_CODE: «ЛР-01», «КР-02», «ДЗ-10» — названия работ. Пробел — не дефис: «КТ 15.10», «Пн 15.09»,
// «Лекция 16» — подписи столбцов, а не группы (проверка 16 окт). После кода — не «.цифра» («КТ-15.10»).
const GROUP_SRC = /(?<![А-ЯЁ])([А-ЯЁ]{2,8})-(1[5-9]|[23]\d)((?:-[А-ЯЁ]{1,5}(?![А-ЯЁ]))?)((?:-\d{1,2})?)(?![-.,]?\d)/g;
/**
 * Коды групп в тексте: «БИСТ-24_ПО_2», «группа БИСТ-24-ПО-2» → ["БИСТ-24-ПО-2"]. Диапазон «БИСТ-24-ПО-1-3» — только
 * поток «БИСТ-24» (файл на несколько групп), не «ПО-1». Когда расписание МИСИС загружено, основа кода должна быть
 * среди известных («БИСТ», «БПИ»…), как в moodle-plan.otherGroup.
 */
export function groupCodes(s, mine = null) {
  const t = upG(String(s || "").replace(/_+/g, "-")).replace(/-+/g, "-");
  // Своя основа принимается всегда: в расписании её может не оказаться (магистратура, файл института не загрузился).
  const known = groupPrefixes(), own = mine ? upG(mine).split("-")[0] : null;
  return [...t.matchAll(GROUP_SRC)].filter((m) => !known.size || known.has(m[1]) || m[1] === own).map((m) => `${m[1]}-${m[2]}${m[3]}${m[4]}`);
}
const gkey = (g) => upG(g).replace(/[^А-ЯЁA-Z0-9]/g, "");
/** Своя ли группа: same — та же или весь поток («БИСТ-24» для «БИСТ-24-ПО-2»), other — другая, unknown — не знаем. */
export function groupRel(code, mine) {
  if (!code || !mine) return "unknown";
  const a = gkey(code), b = gkey(mine);
  return a === b || (b.startsWith(a) && /\d$/.test(a) && !/\d/.test(b.slice(a.length, a.length + 1))) ? "same" : "other";
}
/**
 * Лист «ПО-2» («ПО_2», «ПО2») в файле потока «БИСТ-24…» — группа «БИСТ-24-ПО-2». «Лист1», «Стр2», «Табл3» — имена
 * листов по умолчанию, не профиль (иначе своя строка оказывалась «в группе ЛИСТ-1» — проверка 16 окт).
 */
// Составляем только для своего профиля (буквы профиля в группе студента: «ПО» у «БИСТ-24-ПО-2») — «ДЗ1», «КМ1»,
// «Тест1», «Итог1» — названия листов, а не подгруппы (повторная проверка 16 окт).
function composeCode(sheetName, fileCodes, group) {
  const m = /^([А-ЯЁ]{2,4})[-_ ]?(\d{1,2})$/.exec(upG(sheetName).trim());
  const stream = fileCodes.find((c) => /^[А-ЯЁ]+-\d\d$/.test(c));
  const prof = /^[А-ЯЁ]+-\d\d-([А-ЯЁ]{1,5})-\d/.exec(upG(group || ""))?.[1];
  return m && stream && prof && m[1] === prof ? `${stream}-${m[1]}-${m[2]}` : null;
}

// ---------- кто я в таблице ----------
// Латинские буквы-двойники в кириллическом слове («Kим» с латинской K) — к кириллице; чисто латинские имена не трогаем.
const LAT = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };
const fixMixed = (w) => (/[а-я]/.test(w) && /[a-z]/.test(w) ? w.replace(/[abcehkmoptxy]/g, (ch) => LAT[ch]) : w);
const GROUP_LIKE = /[А-ЯЁA-Zа-яёa-z]{2,8}[-_]\d{2}(?:[-_][А-ЯЁA-Zа-яёa-z]{1,5})?(?:[-_][\d,]{1,5})?/g;
/** Пометки после ФИО — «(староста)», код группы — не часть имени. */
const cleanName = (s) => String(s || "").replace(/\([^)]*\)/g, " ").replace(GROUP_LIKE, " ");
const words = (s) => norm(cleanName(s)).replace(/[«»"]/g, " ").split(/\s+/).filter(Boolean).map(fixMixed);
/** ФИО из Moodle → { last, first, middle } (нижний регистр, ё → е). firstname может содержать и отчество. */
export function nameParts({ fullname = "", firstname = "", lastname = "" } = {}) {
  // Moodle без отдельных фамилии и имени (бывает у служебных учёток и на стенде) — из полного имени «Фамилия Имя Отчество».
  if (!words(lastname).length && !words(firstname).length) {
    const w = words(fullname);
    return { last: w[0] || "", first: w[1] || "", middle: w.slice(2).join(" ") };
  }
  const last = words(lastname).join(" "), fw = words(firstname), first = fw[0] || "";
  let middle = fw.slice(1).join(" ");
  if (!middle) {
    const all = words(fullname);
    const rest = all.filter((w, i) => !(w === last && i === all.indexOf(last)) && !(w === first && i === all.indexOf(first)));
    middle = rest.join(" ");
  }
  return { last, first, middle };
}
// Похоже на отчество: «Ильич», «Петровна», «Ильинична», «Жахонгир угли»; инициал «И.».
const PATRO = /(ич|вна|чна|оглы|кызы|улы|угли|уулу)$/;
const isInitial = (w) => /^[а-яa-z]\.$/.test(w);
/** «а.е.», «а. е.», «а.», «ае» → сравнение с инициалами имени (и отчества, если их два). */
function initialsOf(s) {
  const t = norm(s).replace(/\s+/g, "");
  return /^([а-яa-z]\.?){1,2}$/.test(t) && /\./.test(t) ? t.replace(/\./g, "") : null;
}
const NONE = { s: 0, span: 0 };
/**
 * Совпадение ячеек строки, начиная со столбца c, с ФИО: 3 — фамилия, имя и отчество; 2 — фамилия и имя (отчества в
 * таблице или в Moodle нет); 1 — фамилия и инициалы; 0 — нет (или другое отчество — однофамилец-тёзка). span — сколько
 * ячеек заняло ФИО. Третья ячейка — отчество, только если столбец так подписан (midCol) или она похожа на отчество:
 * иначе «Н», «ИТКН», «+» после имени отбрасывали собственную строку (проверка 16 окт).
 */
export function matchAt(row, c, P, { midCol = false } = {}) {
  if (!P.last || !P.first) return NONE;
  const t = words(text(row[c]));
  if (!t.length) return NONE;
  const mid0 = P.middle ? P.middle.split(" ")[0] : "";
  // Отчество в таблице: ok — совпало, init — совпал только инициал (это не «полное ФИО»: тёзку из другой группы так не
  // взять), bad — другое (это не я), none — его там нет.
  const midState = (ws, sure) => {
    if (!ws.length) return "none";
    const w = ws.join(" ");
    if (!(sure || PATRO.test(ws.at(-1)) || isInitial(ws[0]))) return "none";
    if (!mid0) return "none";
    if (isInitial(ws[0])) return ws[0][0] === mid0[0] ? "init" : "bad";
    if (w === P.middle || ws[0] === mid0) return "ok";
    return "bad";
  };
  // Инициалы: имя совпало, второй инициал (если есть) — с отчеством, когда Moodle его знает.
  const initOk = (ini) => ini[0] === P.first[0] && (ini.length === 1 || !mid0 || ini[1] === mid0[0]);
  const lw = P.last.split(" ");
  // Фамилия, имя, отчество в отдельных ячейках.
  if (t.join(" ") === P.last) {
    const n1 = words(text(row[c + 1]));
    if (n1[0] === P.first) {
      if (n1.length > 1) { const st = midState(n1.slice(1), true); return st === "bad" ? NONE : { s: st === "ok" ? 3 : 2, span: 2 }; }
      const n2 = words(text(row[c + 2]));
      const st = n2.length && n2.length <= 2 && n2.every((w) => /^[а-яa-z][а-яa-z'’-]*\.?$/.test(w)) ? midState(n2, midCol) : "none";
      if (st === "bad") return NONE;
      return st === "ok" ? { s: 3, span: 3 } : { s: 2, span: midCol ? 3 : 2 };
    }
    const ini = initialsOf(`${text(row[c + 1])}${isInitial(norm(text(row[c + 2]))) ? text(row[c + 2]) : ""}`);
    if (ini && initOk(ini)) return { s: 1, span: ini.length > 1 && !initialsOf(text(row[c + 1]))?.[1] ? 3 : 2 };
    return NONE;
  }
  // «Фамилия Имя Отчество» или «Фамилия И.О.» в одной ячейке (пометка в скобках или код группы — не мешают).
  if (t.length > lw.length && t.slice(0, lw.length).join(" ") === P.last) {
    const rest = t.slice(lw.length);
    if (rest[0] === P.first) {
      const st = midState(rest.slice(1, 3), false);
      return st === "bad" ? NONE : { s: st === "ok" ? 3 : 2, span: 1 };
    }
    const ini = initialsOf(rest.join("").slice(0, 4));
    if (ini && initOk(ini)) return { s: 1, span: 1 };
    return NONE;
  }
  // «Имя Фамилия» и «Имя Отчество Фамилия» (иностранные студенты часто так) — только полное имя, отчество сверяется.
  if (t.length >= lw.length + 1 && t[0] === P.first && t.slice(-lw.length).join(" ") === P.last) {
    const midW = t.slice(1, t.length - lw.length);
    if (midW.length > 2) return NONE;
    const st = midState(midW, true);
    return st === "bad" ? NONE : { s: st === "ok" ? 3 : 2, span: 1 };
  }
  return NONE;
}

// ---------- шапка таблицы ----------
// Ячейки шапки и подписи вместо ФИО: «ФИО студента», «Фамилия, имя, отчество», «Максимальный балл», заголовки.
// Не «Макс», «Баллов», «Вес» целиком: это и имена, и фамилии («Шмидт Макс» — студент, проверка 16 окт).
const HEAD_RE = /(^|[\s,.;:(])(фио|ф\.\s?и\.\s?о\.?|фамили[яи]|студент\S*|слушател\S*|обучающ\S*|список|перечень|имя|отчество|наименование|тема|вариант\S*|name|student|№)(?=$|[\s,.;:)])/;
const NOT_NAME = /(^|\s)(макс\.|max|максимум|максимальн\S*|минимум|минимальн\S*|порог|норма|балл|баллы|итог|итого|всего|сумма|дата|срок|оценка|группа|норматив\S*|критери\S*|шкала|преподаватель)(?=$|[\s,.:;])|журнал|ведомост|дисциплин|семестр|рейтинг|посещаем|успеваем/;
/** Похоже на ФИО в ячейке (1–6 слов с заглавной, без цифр; КАПСОМ тоже). Строка студента — studentRow. */
export const nameLike = (v) => {
  const s = cleanName(text(v)).replace(/[«»"]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 80 || /[\d|]/.test(s) || !/^[А-ЯЁA-Z]/.test(s) || !/[А-ЯЁа-яёA-Za-z]{2}/.test(s)) return false;
  if (s.split(" ").length > 6) return false;
  const n = norm(s);
  return !HEAD_RE.test(n) && !NOT_NAME.test(n);
};
/**
 * Строка студента при раскладке своей строки: ФИО в одной ячейке (span 1) — не меньше двух слов («Макс», «Норма» в
 * столбце ФИО — подпись строки максимумов, а не студент); фамилия и имя в разных ячейках — в обеих имена.
 */
const studentRow = (row, c, span) => nameLike(row?.[c]) && (span > 1 ? nameLike(row?.[c + 1]) : cleanName(text(row?.[c])).trim().split(/\s+/).length >= 2);
// Подпись строки максимумов в столбце ФИО (или пусто).
const MAX_LABEL = /макс|мах|max|балл|норм|предел|вес|всего|итог|шкала/;
// …но не сводки по группе: «Средний балл», «Итого по группе», «Всего по потоку» — не максимумы.
const SUMMARY_ROW = /средн|(итог\S*|всего)\s+по(?![а-я])|по\s+групп/;
const META = /^(№|n|#|п\/п|н\/п|№\s*п\/п|номер|ном\.|фамилия|имя|отчество|фио|ф\.и\.о|студент|обучающ|группа|подгруппа|институт|направлен|вариант|e-?mail|почта|логин|зач[её]тк|примечан|комментар|тема|ссылк|telegram|телефон|статус)/;
const KIND_RE = [
  ["lab", /(?<![а-я])(лаб\S*|лр|л\/р)(?![а-я])|лаборатор/],
  ["lecture", /(?<![а-я])(лек\S*|лк)(?![а-я])|(?<![а-я])л\s*\.?\s*\d/],
  ["practice", /практ|семин|(?<![а-я])(пз|пр|сем)(?![а-я])|(?<![а-я])п\s*\.?\s*\d/],
];
const CONTROL = /(?<![а-я])(кт|кр|дз|рк|ргр|ир|идз|срс)\s*\.?\s*№?\s*\d|(?<![а-я])(кт|кр|дз|ргр|идз)(?![а-я])|контрол|тест|коллокв|домашн|экзам|зач[её]т|курсов|доклад|проект|рубеж|аттестац|модул|эссе|реферат|опрос|задани/;
const BONUS = /(?<![а-я])доп(?![а-я])|дополнит|бонус|поощр|олимп|штраф|премиал/;
const TOTAL = /итог|всего|сумм|рейтинг|^total|результат/;
const GRADE = /оценк|отметк/;
// Пропуски не только «Пропусков, ак. ч.»: «Пропущено часов», «Отсутствие (час.)», «Кол-во Н», «Опоздания».
const MISSED = /пропуск|пропущ|отсутств|опоздан|(?<![а-я])кол\S*\s*н(?![а-я])/;
const LABEL_MAX = [/(\d+(?:[.,]\d+)?)\s*[-–—]?\s*(?:максим|макс|max)/, /(?:максим\S*|макс\.?|max)\s*[-–—:=]?\s*(\d+(?:[.,]\d+)?)/, /(?<![а-я])из\s+(\d+(?:[.,]\d+)?)/];
const kindOf = (label) => KIND_RE.find(([, re]) => re.test(label))?.[0] ?? null;
const LESSON_NO = /(?<![а-я])(л|лк|лек|лаб|лр|п|пр|пз|сем|занятие|лекция|практика)\s*\.?\s*№?\s*\d/;
const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** Ячейки, которые складывает формула итога: =SUM(G17:AJ17), =СУММ(…), =A1+B1+C1. Только своей строки. */
export function sumCols(f, row) {
  const s = String(f || "").toUpperCase();
  const out = new Set();
  for (const m of s.matchAll(/([A-Z]{1,3})(\d+)\s*:\s*([A-Z]{1,3})(\d+)/g)) {
    if (+m[2] - 1 !== row || +m[4] - 1 !== row) continue;
    for (let c = colIndex(m[1]); c <= colIndex(m[3]); c++) out.add(c);
  }
  if (/^=\s*[A-Z]{1,3}\d+(\s*\+\s*[A-Z]{1,3}\d+)+\s*$/.test(s)) for (const m of s.matchAll(/([A-Z]{1,3})(\d+)/g)) if (+m[2] - 1 === row) out.add(colIndex(m[1]));
  return out;
}

/**
 * Заголовок, а не подпись группы столбцов: объединение, начатое над столбцами ФИО, или на всю ширину данных
 * («Группа …», «Рейтинг студентов по дисциплине…» делали все столбцы «служебными» или «итогом» — проверка 16 окт).
 * «Лекции» над частью столбцов — подпись (и в узкой таблице тоже).
 */
// Над всеми столбцами, но подпись вида занятий («Лекции» в журнале одних лекций) — подпись, а не заголовок.
const isTitle = (c1, c2, nameEnd, width, v) => c1 <= nameEnd || (c1 <= nameEnd + 1 && c2 >= width - 1 && !kindOf(norm(text(v))));
/** Значения объединённых ячеек — в каждую клетку диапазона (только для строк шапки), кроме заголовков. */
function expandMerged(sheet, rowsSet, nameEnd, width) {
  const out = new Map();
  for (const [r1, c1, r2, c2] of sheet.merged || []) {
    const v = sheet.rows[r1]?.[c1];
    if (v == null || isTitle(c1, c2, nameEnd, width, v)) continue;
    for (let r = r1; r <= r2; r++) if (rowsSet.has(r)) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) out.set(`${r}:${c}`, v);
  }
  return out;
}
/** Левые верхние ячейки заголовков — не подписи столбцов. */
function wideTitle(sheet, merged, nameEnd, width) {
  const out = new Set();
  for (const [r1, c1, , c2] of merged || []) if (isTitle(c1, c2, nameEnd, width, sheet.rows[r1]?.[c1])) out.add(`${r1}:${c1}`);
  return out;
}

/**
 * Разбор листа вокруг своей строки r (ФИО начинается в столбце c и занимает span ячеек). modified — когда файл обновлён
 * (мс): занятие с датой позже — ещё впереди, пустая клетка до неё — «не отмечено» (лекция) или «без оценки» (работа).
 * Возвращает { columns, total, grade, have, scale, left, pending, lost, parts, attendance, confidence, note }.
 */
export function readRow(sheet, r, c, span, { modified = Date.now(), debug = false } = {}) {
  const rows = sheet.rows, row = rows[r] || [];
  const nameEnd = c + Math.max(1, span) - 1;
  // Начало списка студентов: вверх, пока в столбце ФИО — имена. Шапка — до 8 строк над ним (строки других списков
  // пропускаются: таблица с несколькими группами подряд).
  const isStudent = (k) => studentRow(rows[k], c, span);
  let first = r;
  while (first > 0 && isStudent(first - 1)) first--;
  let last = r;
  while (last + 1 < rows.length && isStudent(last + 1)) last++;
  const head = [];
  for (let k = first - 1; k >= 0 && head.length < 8; k--) if (!isStudent(k)) head.unshift(k);
  const width = Math.max(row.length, ...head.map((k) => rows[k]?.length || 0));
  const merged = expandMerged(sheet, new Set(head), nameEnd, width);
  const titles = wideTitle(sheet, sheet.merged, nameEnd, width);
  const at = (k, j) => (titles.has(`${k}:${j}`) ? null : merged.has(`${k}:${j}`) ? merged.get(`${k}:${j}`) : rows[k]?.[j]);
  const modDay = new Date(modified).toISOString().slice(0, 10);

  // Строка дат: больше всего дат (не меньше трёх).
  let dateRow = null, best = 2;
  for (const k of head) {
    let n = 0;
    for (let j = nameEnd + 1; j < width; j++) if (dateOf(rows[k]?.[j], modified, { allowSerial: true })) n++;
    if (n > best) { best = n; dateRow = k; }
  }
  // Строка максимумов: ближняя к списку строка шапки, где в столбце ФИО пусто или подпись «Макс. балл», и не меньше
  // двух чисел (не нумерация 1, 2, 3…, не даты «08.10»). Строка с чьей-то фамилией — никогда (баллы соседа
  // становились «максимумами» — проверка 16 окт).
  let maxRow = null;
  for (const k of [...head].reverse()) { // вся шапка, ближние первыми: между группами бывают заголовки и «Средний балл»
    if (k === dateRow) continue;
    const nm = norm(cleanName(text(rows[k]?.[c])));
    if (nm && (!MAX_LABEL.test(nm) || SUMMARY_ROW.test(nm))) continue;
    const cells = [];
    for (let j = nameEnd + 1; j < width; j++) {
      const v = rows[k]?.[j];
      if (typeof v === "string" && dateOf(v, modified)) continue;
      const x = numOf(v);
      if (x != null) cells.push([j, x]);
    }
    if (cells.length < 2 || cells.some(([, x]) => x < 0 || x > 1000)) continue;
    // Максимум не меньше своих баллов: строка, где у меня больше, — чья-то строка или сводка, а не максимумы.
    if (cells.some(([j, x]) => { const my = numOf(row[j]); return my != null && my > x + 1e-9; })) continue;
    let seq = 0;
    for (let i = 1; i < cells.length; i++) if (cells[i][0] === cells[i - 1][0] + 1 && cells[i][1] === cells[i - 1][1] + 1) seq++;
    if (seq >= (cells.length - 1) / 2) continue;
    maxRow = k;
    break;
  }

  // Столбцы.
  const formulas = sheet.formulas || {};
  const cols = [];
  for (let j = nameEnd + 1; j < width; j++) {
    const parts = [];
    // Подписи — из всех строк шапки (и строки дат: в ней бывают подписи итоговых столбцов), числа и даты — не подписи.
    for (const k of head) {
      if (k === maxRow) continue;
      const v = at(k, j);
      if (v == null || numOf(v) != null || dateOf(v, modified)) continue;
      const t = text(v).replace(/\s+/g, " ").trim();
      if (t && parts.at(-1) !== t) parts.push(t);
    }
    const label = parts.join(" / ");
    const L = norm(label);
    let max = maxRow != null ? numOf(rows[maxRow]?.[j]) : null;
    if (max == null) for (const re of LABEL_MAX) { const m = re.exec(L); if (m) { max = Number(m[1].replace(",", ".")); break; } }
    // Дата — из строки дат или из подписи «КТ 01.10» (день и месяц двумя цифрами: «Лаб 1.2» — не дата). «ЛР1 (до 15.09)»
    // — срок сдачи, а не день занятия: для «впереди / прошло» годится, для посещений — нет (rowDate).
    const rowDate = dateRow != null ? dateOf(rows[dateRow]?.[j], modified, { allowSerial: true }) : null;
    const labelDate = dateOf((/(?<!\d)(\d{2}\.\d{2}(?:\.\d{2,4})?)(?!\d)/.exec(label) || [])[1], modified);
    const date = rowDate ?? labelDate;
    const lessonDate = rowDate ?? (labelDate && !/(?<![а-я])(до|срок|дедлайн|сдать|сдача)(?![а-я])/.test(L) ? labelDate : null);
    // Что в столбце у всего списка: доля «+/Н» и чисел; только 0 и 1 — посещения единицами (binary).
    const st = { num: 0, mark: 0, filled: 0, bin: true };
    for (let k = first; k <= last; k++) {
      const s = stateOf(rows[k]?.[j]);
      if (s === "empty") continue;
      st.filled++;
      if (s === "num") { st.num++; const x = numOf(rows[k][j]); if (x !== 0 && x !== 1) st.bin = false; } else if (s !== "text") st.mark++;
    }
    const binary = st.num >= 3 && st.bin && (max == null || max <= 1);
    const f = formulas[`${r}:${j}`];
    const sums = f ? sumCols(f, r) : new Set();
    let cls;
    const parts2 = L.split(" / ");
    if (parts2.some((p) => META.test(p))) cls = "meta";
    else if (MISSED.test(L) && !/балл/.test(L)) cls = "missed";
    else if (/(колич\S*|число|всего)\s+(посещ|присутств)|^посещени[йя]$/.test(L) && !/балл/.test(L)) cls = "visits";
    else if (/(процент|%)/.test(L) && /посещ/.test(L) && !/балл/.test(L)) cls = "visitsPct";
    else if (GRADE.test(L) && !/балл/.test(L)) cls = "grade";
    else if (TOTAL.test(L)) cls = "total";
    else if (sums.size >= 3) cls = "total";
    else if (BONUS.test(L)) cls = "bonus";
    // «Баллы за вовремя сданные практические работы» — баллы, а не практическое занятие: у занятия есть дата или номер.
    else if (/балл/.test(L) && !date && !LESSON_NO.test(L)) cls = "points";
    else if (kindOf(L)) cls = "lesson";
    else if (CONTROL.test(L)) cls = "control";
    else if (date) cls = "lesson";
    else if (st.filled && st.mark / st.filled >= 0.3) cls = "lesson";
    else if (/балл/.test(L) || (st.filled && st.num / st.filled >= 0.5)) cls = "points";
    else cls = "other";
    // «Посещения» с максимумом в строке максимумов (40 из 100 у физкультуры) — баллы за посещения, а не их число.
    if ((cls === "visits" || cls === "visitsPct") && maxRow != null && max != null && max > 0) cls = "points";
    // В посещения идут только настоящие столбцы занятий: с днём занятия, с отметками «+/Н/Б» хотя бы у трети списка или
    // 0/1. Оценки «ЛР1…ЛР4» (со сроками сдачи, с редким «Н» — «не сдано») — баллы, а не посещения (проверка 16 окт).
    const attend = cls === "lesson" && (!!lessonDate || (st.mark >= 2 && st.mark / st.filled >= 0.3) || binary);
    cols.push({ j, label, L, cls, kind: cls === "lesson" ? kindOf(L) ?? "lesson" : null, max, date, sums, binary, attend, formula: f || null, value: row[j], state: stateOf(row[j]), n: Number((/(\d+)\s*$/.exec(label) || [])[1]) || null });
  }
  // Итог без подписи: максимум в строке максимумов равен сумме максимумов остальных (± 2 %).
  const scored = (x) => (x.cls === "lesson" || x.cls === "control" || x.cls === "points") && x.max != null && x.max > 0;
  // Он мог попасть в «points» — тогда в сумму работ не идёт, а свой максимум с остальными не складывается.
  if (!cols.some((x) => x.cls === "total")) {
    const cand = cols.filter((x) => {
      if (!(x.cls === "points" || x.cls === "other") || x.max == null || x.max < 10) return false;
      const others = cols.filter((y) => y !== x && scored(y)).reduce((s, y) => s + y.max, 0);
      return others > 0 && Math.abs(others - x.max) <= x.max * 0.02;
    });
    if (cand.length) cand.at(-1).cls = "total";
  }
  // Несколько итогов («баллы за семестр», «итоговые баллы»): главный — с «итог» в подписи, иначе с формулой суммы на
  // больше столбцов, иначе самый правый. Остальные — составляющие (баллы), в сумму работ не идут.
  const totals = cols.filter((x) => x.cls === "total");
  const total = totals.length ? (totals.filter((x) => /итог/.test(x.L)).at(-1) || [...totals].sort((a, b) => b.sums.size - a.sums.size || b.j - a.j)[0]) : null;
  for (const x of totals) if (x !== total) x.cls = "component";
  const grade = cols.filter((x) => x.cls === "grade" && x.state !== "empty").at(-1) || null;
  const works = cols.filter((x) => x.cls === "lesson" || x.cls === "control" || x.cls === "points");
  const withMax = works.filter(scored);
  const sumMax = r2(withMax.reduce((s, x) => s + x.max, 0));

  // Баллы.
  let have = null, scale = null, haveFrom = null;
  if (total) {
    let v = numOf(total.value);
    // Значение формулы не сохранено (файл собран программой) — сумма тех же ячеек своей строки.
    if (v == null && total.sums.size) { let s = 0, any = false; for (const j of total.sums) { const x = numOf(row[j]); if (x != null) { s += x; any = true; } } v = any ? r2(s) : null; }
    if (v != null) { have = r2(v); haveFrom = "total"; }
    scale = total.max ?? null;
  }
  // Итога нет (или у студента пустой) — сумма своих баллов по работам с известным максимумом и доп. баллов. Столбцы без
  // максимума не складываем: «пропущено часов», «вариант», посещения единицами — не баллы (проверка 16 окт).
  const numWorks = withMax.filter((x) => x.state === "num");
  if (have == null && numWorks.length) {
    const bonus = cols.filter((x) => x.cls === "bonus" && x.state === "num");
    have = r2([...numWorks, ...bonus].reduce((s, x) => s + numOf(x.value), 0));
    haveFrom = "sum";
  }
  const scaleFromSum = scale == null && withMax.length >= 2;
  if (scaleFromSum) scale = sumMax;
  // Сколько ещё можно набрать — по работам с известным максимумом: пустые впереди (дата позже обновления файла или без
  // даты), пустые прошедшие работы (не лекции) — «без оценки», «+» — был, баллов ещё нет. «Н», «Б» и прошедшая пустая
  // лекция — потеряно. Столбцов с максимумом нет — не считаем.
  let left = null, pending = 0, ahead = 0, lost = 0;
  const partMap = new Map();
  if (withMax.length) {
    left = 0;
    for (const x of withMax) {
      const key = x.cls === "lesson" ? x.kind : x.cls === "control" ? "control" : "points";
      const p = partMap.get(key) || { kind: key, have: 0, max: 0, count: 0 };
      p.max += x.max; p.count++;
      if (x.state === "num") p.have += numOf(x.value);
      partMap.set(key, p);
      if (x.state === "num") { lost += Math.max(0, x.max - numOf(x.value)); continue; }
      if (x.state === "absent" || x.state === "excused") { lost += x.max; continue; }
      const future = x.date ? x.date > modDay : true;
      if (x.state === "plus" || x.state === "text") { left += x.max; pending++; continue; }
      if (future) { left += x.max; ahead++; continue; }
      if (x.kind === "lecture") { lost += x.max; continue; }
      left += x.max; pending++;
    }
    // Шкала больше суммы столбцов (экзамен в таблице не заведён) — разница тоже впереди.
    if (scale != null && scale > sumMax + 0.01) left += scale - sumMax;
    left = r2(left);
  }
  const parts = [...partMap.values()].map((p) => ({ ...p, have: r2(p.have), max: r2(p.max) }));

  // Посещения: столбцы занятий (attend), отменённые (максимум 0) — мимо. Число > 0 или «+» — был; в столбце 0/1 ноль —
  // пропуск; в журнале баллов 0 — неизвестно (был без баллов или не отмечен).
  const lessons = cols.filter((x) => x.attend && x.max !== 0);
  let attendance = null;
  if (lessons.length >= 3) {
    const a = { present: 0, absent: 0, excused: 0, unmarked: 0, past: 0, missedHours: 0, absences: [], percent: null, fromTeacher: false };
    for (const x of lessons) {
      const past = x.date ? x.date <= modDay : x.state !== "empty";
      const v = x.state === "num" ? numOf(x.value) : null;
      const st = x.state === "num" ? (v > 0 ? "plus" : x.binary ? "absent" : "unknown") : x.state;
      if (st === "empty" || st === "unknown" || st === "text") { if (past && x.date) { a.past++; a.unmarked++; } continue; }
      a.past++;
      if (st === "plus") { a.present++; continue; }
      a[st]++;
      a.absences.push({ date: x.date, kind: x.kind, n: x.n, excused: st === "excused" });
    }
    if (a.present + a.absent + a.excused) {
      a.percent = a.present + a.absent ? r2((a.present / (a.present + a.absent)) * 100) : null;
      a.missedHours = 2 * (a.absent + a.excused);
      // Подсчёт самого преподавателя («процент посещения», «пропусков, ак. ч.») главнее нашего. Процент в ячейке Excel
      // формата «0 %» хранится долей (0,75) — переводим в проценты.
      const pct = cols.find((x) => x.cls === "visitsPct" && numOf(x.value) != null);
      if (pct) { const v = numOf(pct.value); a.percent = r2(v > 0 && v <= 1 ? v * 100 : v); a.fromTeacher = true; }
      // Часы — только столбцы «…, ак. ч.» / «часов» («количество пропусков» — это число пар, а не часы).
      const hours = cols.filter((x) => x.cls === "missed" && /ак\.?\s*ч|(?<![а-я])ч\.?(?![а-я])|час/.test(x.L) && numOf(x.value) != null);
      if (hours.length) a.missedHours = r2(hours.reduce((s, x) => s + numOf(x.value), 0));
      attendance = a;
    }
  }

  // Уверенность: есть ли баллы и знаем ли максимум. Сумма столбцов расходится с итогом — средняя; баллов больше
  // максимума или у части работ максимума нет (шкала по сумме известных) — низкая: пороги не считаем.
  let confidence = "none", note = null;
  if (have != null) {
    const noMax = works.some((x) => x.state === "num" && (x.max == null || x.max <= 0) && !x.binary);
    if (scale == null) confidence = "low";
    else if (have > scale * 1.02 + 0.01) { confidence = "low"; note = "баллов в таблице больше максимума — разобрать её уверенно не получилось"; }
    else if (scaleFromSum && noMax) { confidence = "low"; note = "у части столбцов таблицы максимум не указан — сколько всего можно набрать, не ясно"; }
    else if (haveFrom === "total" && withMax.length && sumMax > scale * 1.02) { confidence = "low"; note = `в таблице максимумы столбцов дают ${String(sumMax).replace(".", ",")}, а итог — из ${String(scale).replace(".", ",")}`; }
    else if (haveFrom === "total" && withMax.length && Math.abs(sumMax - scale) > scale * 0.02) confidence = "medium";
    else confidence = "high";
  }
  // Целые баллы (у всех работ и максимумов) — «более 85» значит 86 (moodle-plan.planTargets).
  const whole = have != null && Number.isInteger(have) && numWorks.every((x) => Number.isInteger(numOf(x.value))) && withMax.every((x) => Number.isInteger(x.max));
  return {
    have, scale, haveFrom, left, pending, ahead, lost: r2(lost), parts, attendance, confidence, note, whole,
    total: total ? { label: total.label || null, max: total.max } : null,
    grade: grade ? { value: numOf(grade.value) ?? text(grade.value), label: grade.label || null } : null,
    columns: cols.length, first, last,
    ...(debug ? { cols: cols.map(({ j, label, cls, kind, max, date, state, attend }) => ({ j, label, cls, kind, max, date, state, attend })) } : {}),
  };
}

// ---------- книга целиком ----------
// Без группы (unknown) — не меньше фамилии с именем: по одним инициалам в чужом или безымянном списке легко взять
// однофамильца (проверка 16 окт). Чужая группа — только полное ФИО с отчеством (перевёлся).
const STRENGTH_MIN = { same: 1, unknown: 2, other: 3 };
/**
 * Своя строка в книге (sheets из sheet_xls.py). me — { fullname, firstname, lastname } из Moodle; group — группа
 * студента; fileName / title — имя файла и название в курсе (код группы в них — запасной признак).
 * Выбор: сначала листы и строки своей группы, потом без группы, чужой группы — только полное ФИО с отчеством.
 * Две строки с тем же ФИО на одном листе — ambiguous. На разных листах — это я на разных листах (баллы и посещения),
 * только если совпало полное ФИО или у каждого листа точно моя группа; иначе — тоже ambiguous (тёзки в ПО-1 и ПО-2).
 * Возвращает { status: ok | not_found | ambiguous, matches: [{ sheet, r, c, span, s, rel, groupCode, exact }] }.
 */
export function findMe(book, me, { group = null, fileName = "", title = "" } = {}) {
  const P = nameParts(me);
  const fileCodes = [...new Set([...groupCodes(fileName, group), ...groupCodes(title, group)])];
  const all = [];
  (book?.sheets || []).forEach((sh, si) => {
    const sheetCodes = [...new Set(groupCodes(sh.name, group))];
    // Код листа явный («БИСТ-24_ПО_2») — главный; составленный из «ПО-2» и кода потока — запасной, после своей ячейки «Группа».
    const sheetCode = sheetCodes.length === 1 ? sheetCodes[0] : null, composed = sheetCode ? null : composeCode(sh.name, fileCodes, group);
    const rows = sh.rows || [];
    // Столбцы с подписью «Отчество» в начале листа — там третья ячейка ФИО точно отчество.
    const midCols = new Set();
    for (let k = 0; k < Math.min(rows.length, 12); k++) (rows[k] || []).forEach((v, j) => { if (/отчеств/.test(norm(text(v)))) midCols.add(j); });
    for (let r = 0; r < rows.length; r++) {
      let bestHere = null;
      for (let c = 0; c < (rows[r] || []).length; c++) {
        if (typeof rows[r][c] !== "string") continue; // числа и даты — не ФИО (большие книги с данными разбирались секундами)
        const m = matchAt(rows[r], c, P, { midCol: midCols.has(c + 2) });
        if (m.s && (!bestHere || m.s > bestHere.s)) bestHere = { sheet: si, r, c, span: m.span, s: m.s };
      }
      if (!bestHere) continue;
      // Группа строки: лист → своя ячейка «Группа» в этой же строке → ближняя строка-заголовок выше («Группа «БИСТ-24-ПО-2»»;
      // строки других студентов пропускаются — их «Группа» не заголовок, проверка 16 окт) → имя файла.
      let code = sheetCode;
      if (!code) for (const v of rows[r]) { if (typeof v !== "string" || v.trim().length > 24) continue; const g = groupCodes(v, group); if (g.length === 1) { code = g[0]; break; } }
      if (!code) code = composed;
      if (!code) {
        for (let k = r - 1; k >= 0 && !code; k--) {
          if (studentRow(rows[k], bestHere.c, bestHere.span)) continue;
          for (const v of rows[k] || []) { const g = groupCodes(text(v), group); if (g.length === 1) { code = g[0]; break; } }
        }
      }
      if (!code && fileCodes.length === 1) code = fileCodes[0];
      all.push({ ...bestHere, hidden: !!sh.hidden, groupCode: code, rel: groupRel(code, group), exact: !!code && !!group && gkey(code) === gkey(group) });
    }
  });
  if (!all.length) return { status: "not_found", matches: [] };
  for (const hidden of [false, true]) {
    for (const rel of ["same", "unknown", "other"]) {
      const tier = all.filter((m) => m.hidden === hidden && m.rel === rel && m.s >= STRENGTH_MIN[rel]);
      if (!tier.length) continue;
      const top = Math.max(...tier.map((m) => m.s));
      const best = tier.filter((m) => m.s === top);
      const perSheet = new Map();
      for (const m of best) perSheet.set(m.sheet, (perSheet.get(m.sheet) || 0) + 1);
      if ([...perSheet.values()].some((n) => n > 1)) return { status: "ambiguous", matches: best };
      if (perSheet.size > 1 && !(top === 3 || best.every((m) => m.exact))) return { status: "ambiguous", matches: best };
      return { status: "ok", matches: best };
    }
  }
  return { status: "not_found", matches: [] };
}

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
/**
 * Своя запись в книге: findMe + readRow. С нескольких листов: баллы — с самого уверенного, посещения — с листа баллов,
 * если там есть, иначе с первого, где они есть. Возвращает { status: ok | not_found | ambiguous | no_data, … }.
 */
export function sheetRecord(book, me, { group = null, fileName = "", title = "", modified = Date.now() } = {}) {
  const f = findMe(book, me, { group, fileName, title });
  if (f.status !== "ok") return { status: f.status, count: f.matches.length };
  const recs = f.matches.map((m) => ({ m, x: readRow(book.sheets[m.sheet], m.r, m.c, m.span, { modified }) }));
  const pts = [...recs].sort((a, b) => RANK[b.x.confidence] - RANK[a.x.confidence])[0];
  const att = pts.x.attendance ? pts : recs.find((y) => y.x.attendance) || null;
  if (pts.x.have == null && !att && !pts.x.grade) return { status: "no_data", sheet: book.sheets[pts.m.sheet].name };
  return {
    status: "ok", sheet: book.sheets[pts.m.sheet].name, match: pts.m.s === 3 ? "fio" : pts.m.s === 2 ? "name" : "initials",
    groupCode: pts.m.groupCode, groupRel: pts.m.rel,
    ...pts.x, attendance: att ? att.x.attendance : null, attendanceSheet: att ? book.sheets[att.m.sheet].name : null,
  };
}

/** Текст книги для поиска порогов оценок (moodle-plan.parsePlan): строки листов, ячейки через « | ». */
export function planText(book) {
  return (book?.sheets || []).filter((s) => !s.hidden).map((s) => (s.rows || []).map((r) => (r || []).map(text).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ")).filter(Boolean).join("\n")).join("\n").normalize("NFC");
}
