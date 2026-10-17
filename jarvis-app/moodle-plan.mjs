// Баллы по дисциплине из Moodle — для «Сессии», когда в электронном журнале ej.misis.ru по ней пусто (просьба владельца,
// 15 окт 2026: «по электронике у меня стоят баллы за лабораторные, по моделированию тоже»). Два источника:
//   — журнал оценок курса (gradereport_user_get_grade_items): что уже выставлено и что ещё без оценки (журнал не
//     говорит, сдана ли работа: тест без оценки — скорее не пройден, поэтому не «ждёт проверки»);
//   — рейтинг-план курса (страница «Рейтинг план дисциплины», «Критерии оценивания» и т. п.): шкала перевода баллов в
//     оценку, проходной балл, максимум. Планы пишутся свободным текстом; правила ниже проверены на 27 курсах владельца
//     (26 разобраны верно, NOTES.md п. 132). Чего правила не разобрали — честно «порогов не нашли», без догадок.
// Журнал оценок и план часто не сходятся (итог курса растёт по мере проверки, ЛР в журнале по 2 балла, а в плане по 6,
// план прошлогодний) — поэтому у расчёта есть уверенность: при низкой «сколько не хватает» не считаем.
// Здесь только чистые функции (без сети); чтение Moodle — moodle.mjs (gradebook, coursePlans).
import { groupPrefixes, normGroup } from "./official.mjs";

// ---------- текст страницы ----------
const ENT = { nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", hellip: "…", minus: "−" };
/** HTML страницы → текст: ячейки таблиц через « | », строки — с новой строки, сущности раскрыты. */
export function pageText(html) {
  return String(html || "")
    .replace(/<\/t[dh]>/gi, " | ").replace(/<\/(tr|p|div|li|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").normalize("NFC").trim();
}
/** Страница рейтинг-плана по названию: «Рейтинг план дисциплины», «Критерии оценивания», «БРС», «Балльная система». */
export const PLAN_PAGE = /рейтинг|балльн|БРС|критери\S*\s+оценив|систем\S*\s+оценив/i;

// ---------- шкала ----------
const N = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
const D = String.raw`\s*[—–\-−‐]\s*`;
const num = (s) => Number(String(s).replace(",", "."));
// \b в JS — только латиница: для кириллицы границы слова — через просмотр вокруг.
// Сокращения «Отл.», «Хор.», «Удовл.», «Неуд.» — так пишут шкалу в Excel (рейтинг-план КСПиСТ, 2026; sheets.planText).
const GRADE_WORD = /(?<![а-яё])(неудовлетворительно|удовлетворительно|хорошо|отлично|неуд|удовл|хор|отл)(?:\.|(?![а-яё]))/i;
const MARK = { отлично: 5, хорошо: 4, удовлетворительно: 3, неудовлетворительно: 2, отл: 5, хор: 4, удовл: 3, неуд: 2 };
const RANGES = [
  [new RegExp(String.raw`(?:от\s+)?${N}\s*(%?)(?:${D}|\s+до\s+)${N}\s*(%?)(?!\d)`, "gi"), (m) => ({ from: num(m[1]), to: num(m[3]), pct: !!(m[2] || m[4]) })], // «80—100», «от 85 до 100», «67–84%»
  [new RegExp(String.raw`${N}\s*(%?)\s*(?:балл\S*\s+)?и\s+(?:более|выше)`, "gi"), (m) => ({ from: num(m[1]), to: null, pct: !!m[2] })],                       // «85 и более»
  [new RegExp(String.raw`(?:более|свыше|больше)\s+${N}\s*(%?)`, "gi"), (m) => ({ from: num(m[1]), to: null, strict: true, pct: !!m[2] })],                     // «более 85» — строго
  [new RegExp(String.raw`${N}\s*(%?)\s*(?:балл\S*\s+)?и\s+(?:менее|ниже)`, "gi"), (m) => ({ from: 0, to: num(m[1]), pct: !!m[2] })],                            // «60 и менее»
  [new RegExp(String.raw`не\s+(?:менее|ниже)\s+${N}\s*(%?)`, "gi"), (m) => ({ from: num(m[1]), to: null, pct: !!m[2] })],                                       // «Отлично — не менее 85»
];
/** Одна строка — одна ступень шкалы: оценочное слово и диапазон. В строке и «%», и баллы (67–84% (54–67 баллов)) — баллы. */
function band(line) {
  const g = line.match(GRADE_WORD);
  if (!g) return null;
  const hits = RANGES.flatMap(([re, f]) => [...line.matchAll(re)].map(f));
  const pts = hits.find((h) => !h.pct), pct = hits.find((h) => h.pct), r = pts || pct;
  return r ? { mark: MARK[g[1].toLowerCase()], ...r, unit: pts ? "pts" : "%", quote: line.slice(0, 160) } : null;
}
/** Шкалы в тексте: подряд идущие строки-ступени (не меньше трёх), повтор оценки или посторонняя строка закрывают шкалу. */
function findScales(text) {
  const lines = text.split(/\n|;/).map((s) => s.trim()).filter(Boolean), out = [];
  let cur = [];
  const close = () => { if (cur.length >= 3) out.push(cur); cur = []; };
  for (const l of lines) {
    const b = band(l);
    if (!b) { if (l.length > 3) close(); continue; }
    if (cur.some((x) => x.mark === b.mark)) close();
    cur.push(b);
  }
  close();
  return out.filter((sc) => { const m = Object.fromEntries(sc.map((b) => [b.mark, b])); return m[3] && m[4] && m[5] && m[3].from < m[4].from && m[4].from < m[5].from; });
}
const HEADER_TABLE = /«5»[\s|]*«4»[\s|]*«3»[\s|]*(\d{1,3})[\s|]+(\d{1,3})[\s|]+(\d{1,3})(?!\d)/;
// Числа в фразах — с дробной частью, как N в ступенях: «Максимальная сумма — 107,5 баллов» — это 107,5, а не 107.
const PASS_ROW = new RegExp(String.raw`Проходной\s+балл(?!\s+по\s+итогам)[\s|]*?${N}(?:\s*[—–\-]\s*${N})?`, "i");
const PASS_PHRASE = /не\s+менее\s+(\d{1,3})\s+балл/i;
const MAX_PHRASE = new RegExp(String.raw`(?:Максимальн\S*\s+(?:результат|сумма)[^.\n]{0,160}?[—–-]\s*|Всего\s+баллов[\s|]*)${N}(?:\s*балл)?`, "i");
const SEMESTER_MAX = new RegExp(String.raw`за\s+текущую\s+успеваемость\s*[—–-]\s*${N}|${N}\s+балл\S*\s*[—–-]\s*за\s+текущ\S+\s+(?:семестр|контрол)`, "i");
const MULTI_INSTITUTE = /для\s+студентов\s+институт/gi;

/**
 * Рейтинг-план → { status, thresholds: { 3, 4, 5 } (в единицах плана), strict: { k: true } у порогов «более N» (у любой
 * оценки), unit "pts"|"%",
 * max, pass, semesterMax, quote }. status: ok — шкала найдена; pass — только проходной балл; ambiguous — страница для
 * нескольких институтов; unparsed — оценки с числами есть, а шкала не собралась (показать план, не считать); none —
 * порогов в тексте нет.
 */
export function parsePlan(text) {
  const t = String(text || "");
  const out = { status: "none", thresholds: null, strict: {}, unit: "pts", max: null, pass: null, semesterMax: null, quote: null };
  if (!t.trim()) return out;
  const mx = MAX_PHRASE.exec(t), sm = SEMESTER_MAX.exec(t), pr = PASS_ROW.exec(t);
  // «не менее N баллов» — проходной, только если в строке нет оценки («Отлично — не менее 85» — порог пятёрки) и это не
  // допуск к экзамену («для допуска — не менее 30»).
  const pp = t.split(/\n|;/).filter((l) => !GRADE_WORD.test(l) && !/допуск/i.test(l)).map((l) => PASS_PHRASE.exec(l)).find(Boolean) || null;
  out.semesterMax = sm ? num(sm[1] || sm[2]) : null;
  if ((t.match(MULTI_INSTITUTE) || []).length > 1) { out.status = "ambiguous"; return out; }
  const scales = findScales(t);
  if (scales.length) {
    // Несколько шкал (общая и за отдельные работы) — берём ту, у которой верхняя граница больше.
    const top = (sc) => Math.max(...sc.map((b) => b.to ?? b.from));
    const sc = scales.sort((a, b) => top(b) - top(a))[0];
    const m = Object.fromEntries(sc.map((b) => [b.mark, b]));
    out.status = "ok";
    out.unit = sc.every((b) => b.unit === "%") ? "%" : "pts";
    out.thresholds = { 3: m[3].from, 4: m[4].from, 5: m[5].from };
    for (const k of [3, 4, 5]) if (m[k].strict) out.strict[k] = true;
    // Верх ступени «5» — максимум, только если он в баллах: «85–100 %» — это 100 процентов, а не 100 баллов (проверка 15 окт).
    out.max = (m[5].unit === "pts" ? m[5].to : null) ?? (mx ? num(mx[1]) : null) ?? (pr?.[2] ? num(pr[2]) : null);
    out.pass = m[3].from;
    out.quote = sc.map((b) => b.quote).join(" / ");
  } else {
    const h = HEADER_TABLE.exec(t);
    if (h) {
      out.status = "ok";
      out.thresholds = { 5: num(h[1]), 4: num(h[2]), 3: num(h[3]) };
      out.pass = num(h[3]);
      out.quote = h[0];
    } else if (pp || pr) {
      out.status = "pass";
      out.pass = pp ? num(pp[1]) : num(pr[1]);
      out.quote = (pp || pr)[0];
    } else if (t.split(/\n|;/).some((l) => band(l))) {
      // Строки «оценка — диапазон» есть, а полная шкала 3 < 4 < 5 не собралась: план показать, баллы до оценки не считать.
      out.status = "unparsed";
    }
    out.max = mx ? num(mx[1]) : pr?.[2] ? num(pr[2]) : null;
  }
  return out;
}

// ---------- журнал оценок ----------
const FINAL = /^(?:итоговая\s+)?оценка(?![а-яё])|оценка\s+за\s+(?:экзамен|зач[её]т|дисциплину|пересдачу)|ведомост|^зач\.?$|^курсовая\s+работа(?![а-яё])/i;
const EXTRA = /^доп(?![а-яё])|дополнительн|олимпиад|бонус|поощр/i;
// Код группы в названии работы: год набора 15–39, дальше подгруппы («БПИ-24-3,4», «БИСТ-24-ПО-2») или, без подгрупп,
// префикс от трёх букв («для БИСТ-24»). «ЛР-01», «КР-02», «ДЗ-10», «ГОСТ-28147-89» — не группы (проверка 15 окт: такие
// работы выпадали из суммы как «чужие»).
const GROUP_CODE = /(?<![А-ЯЁA-Z])(?:[А-ЯЁA-Z]{2,6}-(?:1[5-9]|[23]\d)(?:-[\dА-ЯЁA-Z,]+)+|[А-ЯЁA-Z]{3,6}-(?:1[5-9]|[23]\d)(?![\d-]))/g;
/**
 * «БПИ-24-3,4,5,6» → { base: «БПИ-24», nums: [3,4,5,6], words: [] }; «БИСТ-24-ПО-2» → { base, nums: [2], words: [«ПО»] };
 * «БИСТ-24-ПО2» — то же, что «ПО-2».
 */
const groupParts = (s) => {
  const [a, b, ...rest] = normGroup(s).split("-");
  const tags = rest.flatMap((x) => x.split(",")).filter(Boolean).flatMap((x) => { const m = /^([А-ЯЁ]+)([0-9]+)$/.exec(x); return m ? [m[1], m[2]] : [x]; });
  return { base: `${a}-${b}`, nums: tags.filter((x) => /^[0-9]+$/.test(x)).map(Number), words: tags.filter((x) => !/^[0-9]+$/.test(x)) };
};
/** Название работы к виду, который понимает GROUP_CODE: «БИСТ-24-1–3» → «БИСТ-24-1,2,3», «БПИ-24-3, 4» → «БПИ-24-3,4». */
const tidyCodes = (name) => String(name || "")
  .replace(/(-\d{1,2})\s*[–—]\s*(\d{1,2})(?![\d-])/g, (m, a, b) => { const x = -Number(a), y = Number(b); return y > x && y - x <= 10 ? "-" + Array.from({ length: y - x + 1 }, (_, i) => x + i).join(",") : m; })
  .replace(/(-[\dА-ЯЁA-Z,]*\d),\s+(?=\d{1,2}(?![\d-]))/g, "$1,");
const baseOf = (c) => normGroup(c).split("-")[0];
/**
 * Элемент для другой группы: в названии есть коды групп, и ни один не свой («КР№1 БПИ-24-3,4» у БИСТ-24-ПО-2 и у
 * БПИ-24-1). Свой — та же основа, профиль (ПО, ИС), если он указан, и номер подгруппы в списке, если список есть.
 * Кодом считается только то, чья буквенная основа — своя или есть в расписании (БИСТ, БПИ…): «ИДЗ-24», «COVID-19»,
 * «UTF-16» — названия работ. Расписание не загружено — как раньше, по одному виду кода.
 */
function otherGroup(name, group) {
  if (!group) return false;
  const known = groupPrefixes(), mine = baseOf(group);
  const codes = (tidyCodes(name).match(GROUP_CODE) || []).filter((c) => !known.size || baseOf(c) === mine || known.has(baseOf(c)));
  if (!codes.length) return false;
  const me = groupParts(group), myNum = me.nums.at(-1);
  return !codes.some((c) => {
    const it = groupParts(c);
    return it.base === me.base && it.words.every((w) => me.words.includes(w)) && (!it.nums.length || myNum == null || it.nums.includes(myNum));
  });
}
const r1 = (x) => Math.round(x * 100) / 100;
const dec = (x) => String(x).replace(".", ",");
/** «92 балла», «121 балл», «111 баллов», «87,5 балла» — для пояснений. */
const pts = (x) => {
  if (!Number.isInteger(x)) return `${dec(x)} балла`;
  const n = Math.abs(x) % 100, d = n % 10;
  return `${x} ${d === 1 && n !== 11 ? "балл" : d >= 2 && d <= 4 && (n < 10 || n >= 20) ? "балла" : "баллов"}`;
};
const EXAM_ITEM = /экзам|аттестац/i;

/**
 * Пороги плана p (parsePlan или пороги журнала { thresholds, unit: "%", strict: {} }) → [{ key, label, at, strict, need,
 * done, reachable }] на 3, 4 и 5 при have баллах из scale и left ещё возможных (left null — достижимость неизвестна).
 * В процентах — переводим в баллы шкалы. goal — наименьший балл, который даёт оценку: при целых баллах «более 85» — это
 * 86, а 59,4 (55 % от 108) — это 60; при дробных — чуть больше границы. От него need, done, reachable (проверка 15 окт:
 * было «на 5 ещё 58» вместо 59 и «ещё 0» при невзятом пороге). Общая для Moodle и таблиц преподавателей (sheets.mjs).
 */
export function planTargets(p, { have, left, scale, whole = false }) {
  const at = (k) => (p.unit === "%" ? (p.thresholds[k] / 100) * scale : p.thresholds[k]);
  return [3, 4, 5].map((k) => {
    const v = r1(at(k)), s = !!p.strict?.[k];
    const goal = s ? (whole ? Math.floor(v) + 1 : r1(v + 0.01)) : whole ? Math.ceil(v - 1e-9) : v;
    return { key: String(k), label: `на ${k}`, at: v, strict: s, need: r1(Math.max(0, goal - have)), done: have >= goal - 1e-9,
      reachable: left == null ? null : have + left + (whole || s ? 0 : 0.005) >= goal - 1e-9 }; // допуск — только на округление r1
  });
}

/**
 * Баллы курса Moodle: items — элементы gradereport_user_get_grade_items (как есть), plan — parsePlan, group — группа
 * студента. Возвращает { have, sumMax, pendingMax, left, graded, pending: [{ name, max }], finals, extra, scale,
 * confidence: high|medium|low|none, targets, note }. targets — только при уверенности high/medium и найденных порогах.
 */
export function moodleScore(items, plan, { group } = {}) {
  const all = (items || []).filter((g) => g && (g.itemtype === "mod" || g.itemtype === "manual"));
  const weighted = all.some((g) => g.weightraw != null);
  const own = all.filter((g) => !otherGroup(g.itemname, group));
  const name = (g) => String(g.itemname || "").trim();
  const finals = own.filter((g) => Number(g.grademax) <= 5 && FINAL.test(name(g)));
  const extra = weighted ? [] : own.filter((g) => EXTRA.test(name(g)));
  const counted = own.filter((g) => !finals.includes(g) && !extra.includes(g) && !(weighted && Number(g.weightraw) === 0 && g.graderaw != null));
  const graded = counted.filter((g) => g.graderaw != null), waiting = counted.filter((g) => g.graderaw == null);
  const have = r1(graded.reduce((s, g) => s + Number(g.graderaw), 0));
  const sumMax = r1(counted.reduce((s, g) => s + Number(g.grademax || 0), 0));
  const pendingMax = r1(waiting.reduce((s, g) => s + Number(g.grademax || 0), 0));
  const total = (items || []).find((g) => g?.itemtype === "course");
  const p = plan || { status: "none" };
  // Шкала дисциплины — максимум из плана. Нет его (или план в процентах без максимума) — до оценки не считаем.
  const scale = p.max ?? null;
  const notCreated = scale != null ? Math.max(0, scale - sumMax) : null;
  const left = scale != null ? r1(pendingMax + notCreated) : pendingMax;
  let confidence = "none", note = null;
  if (p.status === "ok" && scale != null) {
    if (Math.abs(sumMax - scale) <= scale * 0.02) confidence = "high";
    else if (sumMax < scale) confidence = "medium";
    else { confidence = "low"; note = `в журнале оценок ${pts(sumMax)}, а в рейтинг-плане максимум ${dec(scale)} — считать до оценки не берусь`; }
    // «За текущую успеваемость — 60» сравниваем с работами семестра без экзамена: журнал «работы 60 + экзамен 40» при
    // максимуме 100 совпадает с планом (проверка 15 окт: такой курс уходил в low только из-за строки экзамена).
    const semMax = r1(counted.filter((g) => !EXAM_ITEM.test(name(g))).reduce((s, g) => s + Number(g.grademax || 0), 0));
    if (p.semesterMax && semMax > p.semesterMax * 1.1 && confidence !== "low") { confidence = "low"; note = `в журнале оценок за семестр ${pts(semMax)}, а в рейтинг-плане ${dec(p.semesterMax)} — считать до оценки не берусь`; }
  } else if (p.status === "ok") confidence = "low";
  let targets = [];
  if ((confidence === "high" || confidence === "medium") && p.thresholds) {
    const whole = counted.every((g) => Number.isInteger(Number(g.grademax || 0))) && graded.every((g) => Number.isInteger(Number(g.graderaw)));
    targets = planTargets(p, { have, left, scale, whole });
  }
  return {
    have, sumMax, pendingMax, left, scale, confidence, note, targets,
    graded: graded.length, pending: waiting.map((g) => ({ name: name(g), max: Number(g.grademax) })),
    finals: finals.filter((g) => g.graderaw != null).map((g) => ({ name: name(g), grade: Number(g.graderaw), max: Number(g.grademax) })),
    extra: r1(extra.filter((g) => g.graderaw != null).reduce((s, g) => s + Number(g.graderaw), 0)),
    courseTotal: total && total.graderaw != null ? { grade: Number(total.graderaw), max: Number(total.grademax) } : null,
  };
}
