// Журнал качества отчётов (quality/reports.jsonl) — по нему видно, становятся ли отчёты лучше (просьба владельца,
// 5 окт 2026: система оформления должна приспосабливаться). Пишется по одной строке на событие:
//   gate     — автопроверка готового отчёта перед показом студенту: какие отклонения найдены (коды), чем собран отчёт;
//   approved — студент нажал «Всё хорошо»: сколько раз до этого просил правки;
//   returned — преподаватель вернул работу с замечаниями (нажато «Исправить отчёт»): касались ли они оформления;
//   graded   — работа оценена.
// Без текстов отчётов, замечаний и ФИО: только курс, задание и псевдоним студента (тот же, что в базе замечаний).
// QUALITY_DIR — для стенда и тестов.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { srcOf } from "./lessons.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILE = join(process.env.QUALITY_DIR || join(DIR, "quality"), "reports.jsonl");

/** Записать событие по работе. data — короткие поля события (коды, числа, признаки), без свободного текста. */
export async function note(type, job, data = {}) {
  try {
    await mkdir(dirname(FILE), { recursive: true });
    const line = { at: Date.now(), type, courseId: job.courseId ?? null, assignId: String(job.id), src: srcOf(job.tgId), mode: job.reportMode || "own", ...data };
    await appendFile(FILE, JSON.stringify(line) + "\n");
  } catch (e) { console.error(`журнал качества: ${e.message || e}`); }
}

async function events(since) {
  const text = await readFile(FILE, "utf8").catch(() => "");
  const out = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.at >= since) out.push(e); } catch { /* испорченная строка не мешает остальным */ }
  }
  return out;
}

/**
 * Сводка по курсам с момента since: сколько отчётов показано, сколько прошли автопроверку без обязательных замечаний,
 * какие коды встречались чаще, сколько кругов правок до «Всё хорошо», сколько возвратов преподавателя (и по оформлению).
 */
export async function summary({ since = 0 } = {}) {
  const by = new Map();
  const of = (id) => { if (!by.has(id)) by.set(id, { courseId: id, shown: 0, clean: 0, codes: {}, approved: 0, rounds: 0, returned: 0, returnedFormat: 0, graded: 0 }); return by.get(id); };
  for (const e of await events(since)) {
    const c = of(e.courseId);
    if (e.type === "gate") {
      c.shown++;
      if (!(e.must || []).length) c.clean++;
      for (const code of e.must || []) c.codes[code] = (c.codes[code] || 0) + 1;
    } else if (e.type === "approved") { c.approved++; c.rounds += Number(e.rounds) || 0; }
    else if (e.type === "returned") { c.returned++; if (e.format) c.returnedFormat++; }
    else if (e.type === "graded") c.graded++;
  }
  return [...by.values()].map((c) => ({ ...c, avgRounds: c.approved ? Math.round((c.rounds / c.approved) * 10) / 10 : null }));
}
