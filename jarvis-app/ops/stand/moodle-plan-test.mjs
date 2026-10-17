// Проверка разбора рейтинг-планов и баллов Moodle (moodle-plan.mjs) на коротких синтетических строках — форматы,
// встреченные в 27 курсах владельца (NOTES.md п. 132), и ловушки. Тексты настоящих курсов сюда не копируются.
const mp = await import("../../moodle-plan.mjs");
let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const th = (p) => (p.thresholds ? `${p.thresholds[3]}/${p.thresholds[4]}/${p.thresholds[5]}` : "—");

const A = mp.parsePlan(`Проходной балл | 36—100\n— количество баллов 80—100 — "отлично";\n— количество баллов 60—79 — "хорошо";\n— количество баллов 36—59 — "удовлетворительно";\n— количество баллов 0—35 — "неудовлетворительно`);
check("формат A (список шаблона LMS): 36/60/80 из 100, незакрытая кавычка не мешает", A.status === "ok" && th(A) === "36/60/80" && A.max === 100 && A.pass === 36, JSON.stringify(A));
const B = mp.parsePlan("от 85 до 100 баллов – оценка «отлично»\nот 70 до 84 баллов – оценка «хорошо»\nот 61 до 69 баллов – оценка «удовлетворительно»\nот 13 до 15 баллов (оценка «отлично») за практическую работу");
check("формат B «от X до Y»: общая шкала, мелкая шкала за работу не путается", B.status === "ok" && th(B) === "61/70/85" && B.max === 100, th(B));
const C = mp.parsePlan("Оценка | Баллов |\nОтлично | более 85 |\nХорошо | 70–85 |\nУдовлетворительно | 61–69 |\nНеудовлетворительно | 60 и менее |\nМаксимальная сумма баллов за семестр — 108 баллов");
check("формат C (таблица): «более 85» — строгая граница, максимум из фразы", C.status === "ok" && th(C) === "61/70/85" && C.strict[5] === true && !C.strict[3] && C.max === 108, JSON.stringify(C));
const Dd = mp.parsePlan("0–49% (0–39 баллов) — неудовлетворительно\n50–66% (40–53 балл) — удовлетворительно\n67–84% (54–67 баллов) — хорошо\n85–100% (68–80 баллов) — отлично");
check("формат D (проценты и баллы в строке): берутся баллы, максимум 80", Dd.status === "ok" && th(Dd) === "40/54/68" && Dd.max === 80 && Dd.unit === "pts", JSON.stringify(Dd));
const P = mp.parsePlan("0–49% — неудовлетворительно\n50–69% — удовлетворительно\n70–84% — хорошо\n85–100% — отлично");
check("только проценты: единица %, максимума нет (100 % — не 100 баллов)", P.status === "ok" && P.unit === "%" && th(P) === "50/70/85" && P.max === null, JSON.stringify(P));
const P80 = mp.parsePlan("Максимальная сумма баллов за семестр — 80 баллов\n50–69% — удовлетворительно\n70–84% — хорошо\n85–100% — отлично");
check("проценты и максимум фразой: шкала 80, тройка от 40", P80.unit === "%" && P80.max === 80, JSON.stringify(P80));
const E = mp.parsePlan("Пересчет баллов в оценки «5» | «4» | «3» | 85 | 70 | 61");
check("формат E (шапка таблицы)", E.status === "ok" && th(E) === "61/70/85", JSON.stringify(E));
const F = mp.parsePlan("Проходной балл | | 51\nМаксимальный результат за семестр — 100 баллов");
check("формат F: только проходной балл и максимум", F.status === "pass" && F.pass === 51 && F.max === 100, JSON.stringify(F));
const G = mp.parsePlan("Для студентов института ИТКН: …\n85-110 «отлично»\n70-84 «хорошо»\n60-69 «удовлетворительно»\nДля студентов института ЭУПП: …");
check("страница для нескольких институтов — ambiguous, шкала не применяется", G.status === "ambiguous" && !G.thresholds);
const H = mp.parsePlan("За лабораторную работу до 5 баллов. Критерии: «Отлично» — задание выполнено полностью, «Хорошо» — с неточностями.");
check("слова «отлично/хорошо» без чисел шкалы (Цифровая электроника) — порогов нет", H.status === "none" && !H.thresholds, JSON.stringify(H));
const U = mp.parsePlan("80—100 баллов — отлично\nостальное — по договорённости с преподавателем");
check("строка шкалы есть, но полная шкала не собралась — unparsed", U.status === "unparsed", U.status);
check("оценки рядом с посторонними числами («3 защиты») — не шкала и не unparsed", mp.parsePlan("Для оценки отлично нужно 3 защиты, хорошо — 2 защиты").status === "none");
check("«удовлетворительно» не находится внутри «неудовлетворительно»", mp.parsePlan("0—59 — неудовлетворительно\n60—74 — хорошо\n75—100 — отлично").status !== "ok");
check("HTML: ячейки таблицы не слипаются, сущности раскрыты", mp.pageText("<table><tr><td>Отлично</td><td>более&nbsp;85</td></tr></table><p>70&ndash;85 &laquo;хорошо&raquo;</p>") === "Отлично | более 85 |\n70–85 «хорошо»");

// Журнал оценок.
const it = (itemname, graderaw, grademax, extra = {}) => ({ itemtype: "mod", itemname, graderaw, grademax, weightraw: null, ...extra });
const plan100 = mp.parsePlan("— количество баллов 80—100 — отлично\n— количество баллов 60—79 — хорошо\n— количество баллов 36—59 — удовлетворительно");
const m1 = mp.moodleScore([it("ЛР1", 5, 5), it("ЛР2", 4, 5), it("ЛР3", null, 5), { itemtype: "course", graderaw: null, grademax: 10 }], plan100, { group: "БИСТ-24-ПО-2" });
check("есть 9, ждёт 5, не заведено 85 → можно ещё 90; уверенность medium; до 3 не хватает 27", m1.have === 9 && m1.pendingMax === 5 && m1.left === 90 && m1.confidence === "medium" && m1.targets[0].need === 27 && m1.targets[0].reachable, JSON.stringify(m1));
const m2 = mp.moodleScore([it("КР№1 БПИ-24-3,4", 10, 10), it("КР№1 БИСТ-24", 7, 10), it("Итоговая оценка за дисциплину", 4, 5), it("Доп. баллы за олимпиаду", 5, 5), it("Работа", 50, 80)], plan100, { group: "БИСТ-24-ПО-2" });
check("чужая группа, итоговая оценка и доп. баллы не входят в сумму; итоговая показывается отдельно", m2.have === 57 && m2.sumMax === 90 && m2.finals[0]?.grade === 4 && m2.extra === 5, JSON.stringify(m2));
const m3 = mp.moodleScore([it("Работы", 120, 140)], mp.parsePlan("— количество баллов 125—150 — отлично\n— количество баллов 105—124 — хорошо\n— количество баллов 90—104 — удовлетворительно\nза текущую успеваемость — 110"), {});
check("журнал оценок не сходится с планом (140 против 110 за семестр) — низкая уверенность, порогов нет", m3.confidence === "low" && m3.targets.length === 0 && /за семестр 140 баллов, а в рейтинг-плане 110/.test(m3.note || ""), JSON.stringify(m3));
const m4 = mp.moodleScore([it("ЛР1", 5, 5), it("ЛР2", 5, 5), it("Практика", null, 5)], mp.parsePlan(""), {});
check("плана нет — есть 10, ждёт 5, уверенность none, без порогов", m4.have === 10 && m4.left === 5 && m4.confidence === "none" && !m4.targets.length && m4.graded === 2 && m4.pending.length === 1);
const m5 = mp.moodleScore([it("Всё", 85, 108)], C, {});
check("строгая граница: 85 при «более 85» — пятёрка не набрана", m5.targets.find((t) => t.key === "5")?.done === false && m5.targets.find((t) => t.key === "4")?.done === true, JSON.stringify(m5.targets));
const m6 = mp.moodleScore([it("Тест", 30, 50, { weightraw: 0.5 }), it("Опрос", 10, 10, { weightraw: 0 }), it("Будущее", null, 50, { weightraw: 0 })], plan100, {});
check("с весами: оценённый элемент с весом 0 не входит, пустой с весом 0 ждёт", m6.have === 30 && m6.pendingMax === 50, JSON.stringify({ have: m6.have, pendingMax: m6.pendingMax }));

// Проверка 15 окт: строгая граница при целых баллах, «ещё 0», план в процентах, коды работ, подгруппы.
const t5 = (m) => m.targets.find((x) => x.key === "5"), t3 = (m) => m.targets.find((x) => x.key === "3");
const s27 = mp.moodleScore([it("Сделано", 27, 50), it("Впереди", null, 58)], C, {});
check("«более 85» при целых баллах: с 27 на 5 нужно ещё 59; 27 + 58 = 85 — пятёрку уже не набрать", s27.confidence === "high" && t5(s27).need === 59 && t5(s27).reachable === false && t3(s27).reachable === true, JSON.stringify(t5(s27)));
const s85 = mp.moodleScore([it("Сделано", 85, 100), it("Впереди", null, 8)], C, {});
check("«более 85»: ровно 85 — не набрано, не хватает 1 (а не 0)", t5(s85).done === false && t5(s85).need === 1, JSON.stringify(t5(s85)));
const s86 = mp.moodleScore([it("Сделано", 86, 100), it("Впереди", null, 8)], C, {});
check("«более 85»: 86 — набрано", t5(s86).done === true && t5(s86).need === 0);
const frac = mp.moodleScore([it("Тест", 59.96, 100)], plan100, {});
check("дробные баллы: 59,96 при пороге 60 — не набрано, не хватает 0,04", frac.targets.find((x) => x.key === "4").done === false && frac.targets.find((x) => x.key === "4").need === 0.04, JSON.stringify(frac.targets));
const pct = mp.moodleScore([it("ЛР1", 5, 5), it("ЛР2", 5, 5), it("ЛР3", 5, 5), it("ЛР4", 5, 5), it("ЛР5", null, 20)], P, {});
check("план только в процентах без максимума — до оценки не считаем (не 20 из 100)", pct.scale === null && pct.targets.length === 0 && pct.confidence === "low", JSON.stringify({ scale: pct.scale, c: pct.confidence }));
const pct80 = mp.moodleScore([it("ЛР1", 20, 20), it("ЛР5", null, 60)], P80, {});
check("план в процентах с максимумом 80: тройка от 40", pct80.scale === 80 && t3(pct80).at === 40, JSON.stringify(pct80.targets));
const codes = mp.moodleScore([it("ЛР-01", 20, 20), it("ДЗ-10", null, 20), it("ГОСТ-28147-89 реферат", 5, 5)], plan100, { group: "БИСТ-24-ПО-2" });
check("«ЛР-01», «ДЗ-10», «ГОСТ-28147-89» — не коды групп, работы в сумме", codes.have === 25 && codes.sumMax === 45, JSON.stringify({ have: codes.have, sumMax: codes.sumMax }));
const kr = [it("КР№1 БИСТ-24-1,2, БПИ-24-1,2", 10, 10), it("КР№1 БПИ-24-3,4,5,6", null, 10)];
const g1 = mp.moodleScore(kr, plan100, { group: "БПИ-24-1" }), g3 = mp.moodleScore(kr, plan100, { group: "БПИ-24-3" }), gb = mp.moodleScore(kr, plan100, { group: "БИСТ-24-ПО-2" });
check("подгруппы: БПИ-24-1 — своя только «1,2», БПИ-24-3 — только «3,4,5,6», БИСТ-24-ПО-2 — «БИСТ-24-1,2»", g1.sumMax === 10 && g1.have === 10 && g3.sumMax === 10 && g3.have === 0 && g3.pendingMax === 10 && gb.sumMax === 10 && gb.have === 10,
  JSON.stringify([g1.sumMax, g1.have, g3.sumMax, g3.have, gb.sumMax, gb.have]));
const prof = mp.moodleScore([it("КР БИСТ-24-ПО-1", 7, 10), it("КР БИСТ-24-ИС-1", 9, 10)], plan100, { group: "БИСТ-24-ИС-1" });
check("профиль в коде: БИСТ-24-ПО-1 у БИСТ-24-ИС-1 — чужая", prof.have === 9 && prof.sumMax === 10, JSON.stringify({ have: prof.have, sumMax: prof.sumMax }));

// Перепроверка 15 окт: экзамен в журнале, «не менее N», дробный максимум, допуск на округление, подгруппы, склонение.
const sem60 = "— количество баллов 86—100 — отлично\n— количество баллов 71—85 — хорошо\n— количество баллов 55—70 — удовлетворительно\nза текущую успеваемость — 60";
const ex = mp.moodleScore([it("Тесты и задания семестра", 30, 60), it("Экзамен", null, 40)], mp.parsePlan(sem60), {});
check("работы 60 + экзамен 40 при максимуме 100 и «за семестр 60» — высокая уверенность, пороги считаются", ex.confidence === "high" && ex.targets.length === 3, JSON.stringify({ c: ex.confidence, note: ex.note }));
const noEx = mp.moodleScore([it("Всё за семестр", 30, 100)], mp.parsePlan(sem60), {});
check("журнал только за семестр на 100 при «за семестр 60» — низкая уверенность, «100 баллов»", noEx.confidence === "low" && /100 баллов/.test(noEx.note || ""), noEx.note);
const notLess = mp.parsePlan("Отлично — не менее 85 баллов\nХорошо — не менее 70 баллов\nУдовлетворительно — не менее 55 баллов\nМаксимальная сумма баллов — 100");
check("«Отлично — не менее 85» — шкала 55/70/85, а не «проходной 85»", notLess.status === "ok" && th(notLess) === "55/70/85" && notLess.pass === 55, JSON.stringify(notLess));
check("«для допуска — не менее 30 баллов» — не проходной балл", mp.parsePlan("Для допуска к экзамену необходимо набрать не менее 30 баллов").status === "none");
check("«для успешного завершения — не менее 55 баллов» — проходной 55", mp.parsePlan("Для допуска к экзамену — не менее 30 баллов.\nДля успешного завершения курса необходимо набрать не менее 55 баллов").pass === 55);
const fr = mp.parsePlan("Оценка | Баллов |\nОтлично | более 85 |\nХорошо | 70–85 |\nУдовлетворительно | 61–69 |\nМаксимальная сумма баллов за семестр — 107,5 баллов\nза текущую успеваемость — 59,5");
check("дробные максимум и «за семестр»: 107,5 и 59,5", fr.max === 107.5 && fr.semesterMax === 59.5, JSON.stringify({ max: fr.max, sm: fr.semesterMax }));
const all = mp.moodleScore([it("Тест", 54.97, 100)], mp.parsePlan("— количество баллов 80—100 — отлично\n— количество баллов 60—79 — хорошо\n— количество баллов 55—59 — удовлетворительно"), {});
check("всё оценено, 54,97 при пороге 55 — тройку уже не набрать", t3(all).reachable === false && t3(all).done === false, JSON.stringify(t3(all)));
const sp = mp.moodleScore([it("КР№1 БПИ-24-3, 4", 5, 10), it("Другое", 5, 10)], plan100, { group: "БПИ-24-4" });
const po2 = mp.moodleScore([it("КР БИСТ-24-ПО2", 5, 10), it("Другое", 5, 10)], plan100, { group: "БИСТ-24-ПО-2" });
const rng = mp.moodleScore([it("КР БИСТ-24-1–3", 5, 10), it("Другое", 5, 10)], plan100, { group: "БИСТ-24-2" });
const far = mp.moodleScore([it("КР БИСТ-24-1–3", 5, 10), it("Другое", 5, 10)], plan100, { group: "БИСТ-24-4" });
check("подгруппы: «3, 4» через пробел, «ПО2» без дефиса, диапазон «1–3» — свои; «1–3» у четвёртой — чужая", sp.sumMax === 20 && po2.sumMax === 20 && rng.sumMax === 20 && far.sumMax === 10, JSON.stringify([sp.sumMax, po2.sumMax, rng.sumMax, far.sumMax]));
const n92 = mp.moodleScore([it("ЛР", 27, 27), it("Баллы за экзамен", null, 65), it("Ещё", null, 65)], mp.parsePlan("— количество баллов 80—100 — отлично\n— количество баллов 60—79 — хорошо\n— количество баллов 36—59 — удовлетворительно\nза текущую успеваемость — 35"), {});
check("пояснение склоняет «балл»: «157 баллов», «92 балла» без экзамена", /157 баллов/.test(n92.note || "") || /92 балла/.test(n92.note || ""), n92.note);
const strictAll = mp.parsePlan("Отлично | более 85 |\nХорошо | более 70 |\nУдовлетворительно | более 60 |\nМаксимальная сумма баллов — 100");
check("«более N» у всех трёх оценок — строгие все три", strictAll.strict[3] && strictAll.strict[4] && strictAll.strict[5], JSON.stringify(strictAll.strict));

console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
