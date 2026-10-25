// Проверка правил «Риск по посещаемости» (attendance.mjs journalAlerts) на образцах данных журнала, без сети.
// Запуск: MOODLE_DIRECT=0 node attendance-test.mjs
const { journalAlerts, toAsk, withoutNotMine, dropStaleNo, pruneAsk, askText, askButtons } = await import(new URL("../../attendance.mjs", import.meta.url));
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

// Дисциплина без курса в Moodle — вопрос студенту (16 окт 2026).
const un = [{ id: 7, name: "Теория информационных процессов и систем" }, { id: 8, name: "А" }, { id: 9, name: "Б" }, { id: 10, name: "В" }, { id: "x/1", name: "Г" }];
check("спрашиваем о тех, о ком ещё не спрашивали, не больше 3 за раз; id не число — не спрашиваем (не влезет в кнопку)",
  toAsk(un, { 8: { answer: null } }).map((s) => s.id).join() === "7,9,10" && toAsk(un, { 7: {}, 8: {}, 9: {}, 10: {} }).length === 0 && toAsk(null, {}).length === 0);
const ask = { 2: { name: "Физика", answer: "no" }, 1: { name: "Базы данных", answer: "yes" } };
const both = J(subj(), subj({ id: 2, name: "Физика" }));
check("«не моя» в проверку не идёт, «моя» и без ответа — идут", withoutNotMine(both, ask).subjects.map((s) => s.id).join() === "1" && withoutNotMine(both, {}).subjects.length === 2 && withoutNotMine(null, ask) === null);
const ff = { works: [{ name: "ЛР 2", mark: 0, max: 5, failed: true }] };
const seed2 = journalAlerts(null, both).snapshot;
const nm = journalAlerts(seed2, withoutNotMine(J(subj(), subj({ id: 2, name: "Физика", ...ff })), ask));
check("по «не моей» дисциплине ноль за работу не сообщается, и в снимке её больше нет", nm.lines.length === 0 && !nm.snapshot[2], nm.lines.join(" | "));
check("передумал («моя») — по ней сперва только запоминаем, старое разом не приходит", journalAlerts(nm.snapshot, J(subj(), subj({ id: 2, name: "Физика", ...ff }))).lines.length === 0);
check("текст вопроса: дисциплина, «не нашлось» (а не «нет в Moodle»), где посмотреть курсы, «Это ваша дисциплина?», что будет при «нет», кто увидит ответ",
  askText("ТИПиС").includes("дисциплина «ТИПиС»") && askText("ТИПиС").includes("курса с таким названием не нашлось") && askText("ТИПиС").includes("Профиль → Курсы")
  && askText("ТИПиС").includes("Это ваша дисциплина?") && askText("ТИПиС").includes("присылать не буду") && askText("ТИПиС").includes("увидит и администратор Doodle"));
check("после ответа — ответ внизу; «не моя» — как вернуть; «моя» после «не моя» — где смотреть пропущенное; без названия — без «»",
  askText("ТИПиС", "no").includes("🚫 Ответ: не моя — уведомлений журнала по ней больше не будет.") && askText("ТИПиС", "no").includes("Вернуть — кнопкой ниже, в /settings или во вкладке «Журнал».") && askText("ТИПиС", "yes").includes("✅ Ответ: моя")
  && !askText("ТИПиС", "yes").includes("вкладке «Журнал»") && askText("ТИПиС", "yes", { back: true }).includes("вкладке «Журнал»") && askText(null).includes("дисциплина, а среди") && !askText(null).includes("«null»"));
// С 16 окт (позже) «не моя» — не только уведомления: вкладка «Журнал», /journal и «Сессия» её тоже не считают.
check("тексты: «нет» — не только уведомления, но и средние «Журнала», /journal и «Сессия»; «не моя» — где она теперь; «моя» — снова считается",
  /в средних и пропусках вкладки «Журнал», в \/journal и в «Сессии» она не будет считаться/.test(askText("ТИПиС"))
  && /В средних «Журнала» и в «Сессии» она не считается \(во вкладке «Журнал» — отдельным списком внизу\)/.test(askText("ТИПиС", "no"))
  && askText("ТИПиС", "yes").includes("в «Журнале» и «Сессии» она считается"), askText("ТИПиС", "no"));
// «Не моё» в «Сессии» (off — admission.notMineIds, id строкой) — та же «не моя»: не спрашиваем, в уведомления не идёт.
const offS = new Map([["7", "session"], ["2", "session"]]);
check("скрытую в «Сессии» дисциплину бот не спрашивает; остальных — как раньше",
  toAsk(un, {}, offS).map((s) => s.id).join() === "8,9,10" && toAsk(un, {}, new Map()).map((s) => s.id).join() === "7,8,9");
check("уведомления: с off — решает он (в нём и «не моя» бота, и «Не моё» «Сессии»), без off — только ответ бота",
  withoutNotMine(both, {}, offS).subjects.map((s) => s.id).join() === "1" && withoutNotMine(both, ask, new Map()).subjects.length === 2 && withoutNotMine(both, ask).subjects.map((s) => s.id).join() === "1");
const askedS = { 1: { answer: "no" }, 2: { answer: "no" }, 3: { answer: "yes" } };
const three = J(subj(), subj({ id: 2, name: "Физика" }), subj({ id: 3, name: "Химия" }));
const dropped = dropStaleNo(askedS, three, [{ id: 2, name: "Физика" }]);
check("курс в Moodle появился — «не моя» снимается (только у тех, что теперь с курсом); сравнить не с чем (null) — ничего не трогаем",
  dropped.map((s) => s.id).join() === "1" && !askedS[1] && askedS[2]?.answer === "no" && askedS[3]?.answer === "yes" && dropStaleNo({ 2: { answer: "no" } }, three, null).length === 0);
{
  const a2 = { 1: { answer: "no" }, 2: { answer: "no" } };
  const d2 = dropStaleNo(a2, three, [], new Set(["2"]));
  check("курс в Moodle появился, но в «Сессии» дисциплина скрыта самим студентом — «не моя» не снимается («снова присылаю» было бы неправдой)",
    d2.map((s) => s.id).join() === "1" && !a2[1] && a2[2]?.answer === "no", JSON.stringify(a2));
}
const cbs = (b) => b.flat().map((x) => `${x.text}=${x.callback_data}`).join(", ");
check("кнопки: до ответа «Да, моя» / «Нет, не моя»; после — одна, чтобы передумать; в данных — сам ответ",
  cbs(askButtons(7)) === "Да, моя=ejq:y:7, Нет, не моя=ejq:n:7" && cbs(askButtons(7, "no")) === "Всё-таки моя=ejq:y:7" && cbs(askButtons(7, "yes")) === "Всё-таки не моя=ejq:n:7", cbs(askButtons(7)));
const pr = { 1: { name: "А", answer: "no", told: "no" }, 5: { name: "Б", answer: "no", told: "no" }, 6: { name: "В", answer: "no" }, 7: { name: null, answer: "no" }, 8: { name: "Г", answer: null } };
pruneAsk(pr, J(subj()));
check("записи о дисциплинах, которых в журнале нет, убираются (кроме ответа, ещё не дошедшего до владельца); пустой журнал — не трогаем",
  Object.keys(pr).join() === "1,6" && (() => { const x = { 5: { name: "Б", answer: "no", told: "no" } }; pruneAsk(x, J()); return !!x[5]; })(), Object.keys(pr).join());
check("данные кнопки не длиннее 64 байт при самом длинном id", Buffer.byteLength(askButtons("123456789012345")[0][1].callback_data) <= 64);
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
