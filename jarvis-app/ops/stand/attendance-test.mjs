// Проверка правил «Риск по посещаемости» (attendance.mjs journalAlerts) на образцах данных журнала, без сети.
// Запуск: MOODLE_DIRECT=0 node attendance-test.mjs
import { pathToFileURL } from "node:url";

const { journalAlerts } = await import(pathToFileURL("C:/Users/User/moodle-work/jarvis-app/attendance.mjs").href);
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

const subj = (o) => ({ id: 1, name: "Базы данных", attendance: 90, rating: 40, thresholds: { 3: 51, 4: 70, 5: 85 }, lessons: { past: 10, present: 9, absent: 1, unmarked: 0, missedHours: 2 },
  absences: [{ date: "2026-09-14T00:00:00", kind: "Лекция", n: 2, hours: 2 }], works: [{ name: "КМ 1", mark: 8, max: 10, failed: false }, { name: "ЛР 1", mark: 5, max: 5, failed: false }], error: null, ...o });
const J = (...subjects) => ({ subjects });

const first = journalAlerts(null, J(subj()));
check("первая проверка только запоминает: сообщений нет, снимок есть", first.lines.length === 0 && first.snapshot[1].abs.length === 1 && first.snapshot[1].band === "ok" && first.snapshot[1].behind === false);

const same = journalAlerts(first.snapshot, J(subj()));
check("ничего не изменилось — сообщений нет", same.lines.length === 0);

const abs2 = subj({ attendance: 80, lessons: { past: 12, present: 9, absent: 3, unmarked: 0, missedHours: 6 }, absences: [{ date: "2026-09-14T00:00:00", kind: "Лекция", n: 2 }, { date: "2026-09-28T00:00:00", kind: "Лабораторная", n: 3 }, { date: "2026-09-30T00:00:00", kind: "Практика", n: null }] });
const r1 = journalAlerts(first.snapshot, J(abs2));
check("новые пропуски: одна строка на предмет, с видом занятия и датой; старый пропуск не повторяется", r1.lines.length === 1 && r1.lines[0] === "❗ Пропуски (2) · Базы данных: лабораторная 3, 28 сен; практика, 30 сен", r1.lines.join(" | "));

const low = subj({ attendance: 71.4, lessons: { past: 14, present: 10, absent: 4, unmarked: 0, missedHours: 8 } });
const r2 = journalAlerts(first.snapshot, J(low));
check("посещаемость ушла ниже 75 % — предупреждение с числом пропущенных занятий", r2.lines.length === 1 && r2.lines[0] === "⚠️ Посещаемость · Базы данных: 71,4 % — ниже 75 % (пропущено 4 из 14 занятий)", r2.lines.join(" | "));
const r2b = journalAlerts(r2.snapshot, J(subj({ attendance: 70 })));
check("осталась в той же зоне — второй раз не пишем", r2b.lines.length === 0);
const r2c = journalAlerts(r2.snapshot, J(subj({ attendance: 45, lessons: { past: 20, present: 9, absent: 11, unmarked: 0, missedHours: 22 } })));
check("упала ниже 50 % — новое предупреждение (красная зона)", r2c.lines.length === 1 && r2c.lines[0].includes("45 % — ниже 50 %"), r2c.lines.join(" | "));
const r2d = journalAlerts(r2c.snapshot, J(subj({ attendance: 80 })));
check("посещаемость выросла — молча, зона в снимке обновилась", r2d.lines.length === 0 && r2d.snapshot[1].band === "ok");

const failed = subj({ works: [{ name: "КМ 1", mark: 2, max: 10, failed: true }, { name: "ЛР 1", mark: 5, max: 5, failed: false }, { name: "ЛР 2", mark: 9, max: 10, failed: false }] });
const r3 = journalAlerts(first.snapshot, J(failed));
check("работа оценена ниже порога — одна строка о ней; общий процент при этом ещё выше тройки", r3.lines.length === 1 && r3.lines[0] === "⚠️ Оценка ниже порога · Базы данных: «КМ 1» — 2 из 10", r3.lines.join(" | "));
check("о той же проваленной работе второй раз не пишем", journalAlerts(r3.snapshot, J(failed)).lines.length === 0);

const behind = subj({ works: [{ name: "КМ 1", mark: 3, max: 10, failed: false }, { name: "ЛР 1", mark: 2, max: 5, failed: false }, { name: "КМ 2", mark: null, max: 10, failed: false }] });
const r4 = journalAlerts(first.snapshot, J(behind));
check("по выставленным оценкам ниже порога тройки — предупреждение; работа без оценки не считается", r4.lines.length === 1 && r4.lines[0] === "⚠️ Рейтинг · Базы данных: по выставленным оценкам 33,3 % — ниже порога тройки (51 %)", r4.lines.join(" | "));
const one = subj({ works: [{ name: "КМ 1", mark: 1, max: 10, failed: false }] });
check("одной оценки мало для вывода о рейтинге — молчим", journalAlerts(first.snapshot, J(one)).lines.length === 0);

const two = journalAlerts(first.snapshot, J(subj(), subj({ id: 2, name: "Физика", attendance: 30, absences: [{ date: "2026-10-01", kind: "Лекция", n: 1 }] })));
check("новый предмет в журнале только запоминается, даже если в нём уже плохо", two.lines.length === 0 && two.snapshot[2].band === "critical");
const broken = journalAlerts(two.snapshot, J(subj(), { id: 2, name: "Физика", error: "Журнал дисциплины не загрузился" }));
check("предмет не загрузился — прежний снимок по нему сохраняется, сообщений нет", broken.lines.length === 0 && broken.snapshot[2].band === "critical" && broken.snapshot[2].abs.length === 1);
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
