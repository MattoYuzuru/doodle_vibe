// Проверка расчёта баллов «Сессии» (admission.scoreOf) и сопоставления названий (sameName) — без сети.
process.env.SESSION_WATCH = "0";
const a = await import("../../admission.mjs");
let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const t = (sc, key) => sc.targets.find((x) => x.key === key);

// Как «Оптимизация клиент-серверных приложений» в журнале владельца: 33 из 100, ещё можно 68,1, пороги 62,2 / 71,4 / 86,7.
const oksp = a.scoreOf({ rating: 33, thresholds: { 3: 62.2, 4: 71.4, 5: 86.7 }, points: { left: 68.1, pending: 7 }, works: [], grade: null });
check("экзамен: не хватает до 3 — 29,2, до 4 — 38,4, до 5 — 53,7; все пороги достижимы", t(oksp, "3").need === 29.2 && t(oksp, "4").need === 38.4 && t(oksp, "5").need === 53.7 && oksp.targets.every((x) => x.reachable && !x.done), JSON.stringify(oksp.targets));
check("максимум — набрано + можно ещё, не больше 100", oksp.max === 100 && oksp.have === 33 && oksp.left === 68.1);

// Мало осталось: 40 есть, ещё 15 → максимум 55: тройка (50) достижима, четвёрка (70) уже нет.
const low = a.scoreOf({ rating: 40, thresholds: { 3: 50, 4: 70, 5: 90 }, points: { left: 15, pending: 2 }, works: [{ name: "КР1", failed: true }] });
check("порог, который не набрать даже со всеми оставшимися работами, помечен", t(low, "3").reachable === true && t(low, "4").reachable === false && t(low, "5").reachable === false && low.max === 55, JSON.stringify(low.targets));
check("работа ниже порога попадает в список", low.failed.join() === "КР1");

// Зачёт без оценки: один порог — тройки.
const pass = a.scoreOf({ rating: 61, thresholds: { 3: 60, 4: 75, 5: 90 }, points: { left: 20, pending: 3 }, works: [] }, { pass: true });
check("зачёт: один порог «зачёт» по тройке, уже набран", pass.targets.length === 1 && pass.targets[0].key === "pass" && pass.targets[0].done && pass.targets[0].need === 0, JSON.stringify(pass.targets));
check("нет рейтинга или порогов — баллов нет (null)", a.scoreOf({ rating: null, thresholds: { 3: 50, 4: 70, 5: 90 } }) === null && a.scoreOf({ rating: 10, thresholds: null }) === null && a.scoreOf(null) === null);
check("названия: «Теория информационных процессов и систем» = «Теория инф. процессов и систем», ≠ «Методы оптимизации»", a.sameName("Теория информационных процессов и систем", "Теория информационных процессов и систем") && !a.sameName("Оптимизация клиент-серверных приложений", "Методы оптимизации"));

// Журнал владельца 15 окт: «Моделирование …» стоит в списке раньше «Теории …», а слова «информационных процессов и
// систем» у них общие — найти нужно свою дисциплину, а не первую похожую.
const journal = [{ name: "Методы оптимизации" }, { name: "Моделирование информационных процессов и систем" }, { name: "Теория информационных процессов и систем" }];
check("поиск дисциплины: точное название побеждает похожее, стоящее раньше", a.findBy(journal, "Теория информационных процессов и систем")?.name === "Теория информационных процессов и систем" && a.findBy(journal, "Моделирование информационных процессов и систем")?.name === "Моделирование информационных процессов и систем");
check("поиск дисциплины: без точного совпадения — самое похожее; совсем другого нет — null", a.findBy(journal, "Моделирование информационных процессов")?.name === "Моделирование информационных процессов и систем" && a.findBy(journal, "Цифровая электроника") === null);

// Проверка 15 окт: курса «Теории …» в Moodle нет, а курс «Моделирования …» похож на обе — отдаём только своей паре.
const sem = [{ name: "Теория информационных процессов и систем" }, { name: "Моделирование информационных процессов и систем" }, { name: "Цифровая электроника" }];
const mcs = [{ id: 3416, name: "Моделирование информационных процессов и систем" }, { id: 3437, name: "Цифровая электроника" }];
check("курс Moodle — только взаимной паре: «Теории» чужой курс не достаётся", a.matchCourse(sem, mcs, sem[0]) === null && a.matchCourse(sem, mcs, sem[1])?.id === 3416 && a.matchCourse(sem, mcs, sem[2])?.id === 3437);

// Ступени «ещё N»: при невзятом пороге не «ещё 0».
const near = a.scoreOf({ rating: 60.96, thresholds: { 3: 61, 4: 70, 5: 85 }, points: { left: 20, pending: 1 }, works: [] });
check("журнал: 60,96 при пороге 61 — не набрано, не хватает 0,04 (не 0)", !t(near, "3").done && t(near, "3").need === 0.04, JSON.stringify(t(near, "3")));

// Представление Moodle: шкала «из N» — только при уверенном расчёте; почему нет порогов — одной фразой.
const it = (itemname, graderaw, grademax) => ({ itemtype: "mod", itemname, graderaw, grademax, weightraw: null });
const lowPlan = "— количество баллов 125—150 — отлично\n— количество баллов 105—124 — хорошо\n— количество баллов 90—104 — удовлетворительно\nза текущую успеваемость — 110";
const lowView = a.moodleScoreView({ courseId: 1, items: [it("Работы", 120, 140)], plan: lowPlan, cmid: 5 }, { group: "БИСТ-24-ПО-2" });
check("низкая уверенность — без «из 150» и без полосы (scale и max null), пороги текстом", lowView.confidence === "low" && lowView.scale === null && lowView.max === null && /из 150/.test(lowView.planBands || ""), JSON.stringify({ scale: lowView.scale, bands: lowView.planBands }));
const noPage = a.moodleScoreView({ courseId: 1, items: [it("ЛР1", 5, 5)], plan: "", cmid: null }, {});
const notLoaded = a.moodleScoreView({ courseId: 1, items: [it("ЛР1", 5, 5)], plan: undefined, cmid: undefined, loaded: false }, {});
const multi = a.moodleScoreView({ courseId: 1, items: [it("ЛР1", 5, 5)], plan: "Для студентов института ИТКН:\n85-110 «отлично»\nДля студентов института ЭУПП:", cmid: 7 }, {});
const silent = a.moodleScoreView({ courseId: 1, items: [it("ЛР1", 5, 5)], plan: "За лабораторную до 5 баллов.", cmid: 7 }, {});
check("почему порогов нет: плана нет / не загрузился / несколько институтов / в плане не написано", /не нашлось/.test(noPage.planNote) && !noPage.planFound && /не удалось загрузить/.test(notLoaded.planNote) && /каждого института/.test(multi.planNote) && multi.planFound && /не написано/.test(silent.planNote) && silent.planFound,
  [noPage.planNote, notLoaded.planNote, multi.planNote, silent.planNote].join(" | "));

// Справка по английскому: только план, по которому сверена рабочая программа (09.03.02-БИСТ-24).
const planUrl = "https://misis.ru/sveden/files/aic/09.03.02-BIST-24.plx.pdf";
const eng = a.subjectInfo(planUrl, { name: "Иностранный язык", graded: true, exam: false, pass: false });
check("английский (ЗаО): 100 баллов из пяти частей, 3 от 51 / 4 от 70 / 5 от 85, зачёт на последнем занятии, ссылка на РПД",
  eng && eng.scale === 100 && eng.parts.reduce((n, p) => n + p.max, 0) === 100 && eng.bands === "3 — от 51, 4 — от 70, 5 — от 85" && eng.notes.some((n) => /последнем занятии/.test(n)) && /Inostrannyi_yazyk/.test(eng.url), JSON.stringify(eng));
const engExam = a.subjectInfo(planUrl, { name: "Иностранный язык", exam: true });
check("английский (экзамен 7 семестра): без фразы про зачёт на последнем занятии", engExam && !engExam.notes.some((n) => /последнем занятии/.test(n)));
check("после пропуска: при уважительной причине — подтверждающий документ, объяснительная — только по другой причине", eng.notes.some((n) => /подтверждает/.test(n) && /По другой причине — в тот же день объяснительную/.test(n)) && !eng.notes.some((n) => /справку или объяснительн/.test(n)));
const strictPlan = "Отлично | более 85 |\nХорошо | более 70 |\nУдовлетворительно | более 60 |\nМаксимальная сумма баллов — 100";
const sv = a.moodleScoreView({ courseId: 1, items: [it("Всё", 50, 140)], plan: strictPlan, cmid: 3 }, {}), svp = a.moodleScoreView({ courseId: 1, items: [it("Всё", 50, 140)], plan: strictPlan, cmid: 3 }, { pass: true });
check("пороги текстом: «более» у каждой строгой оценки и у зачёта", sv.planBands === "3 — более 60, 4 — более 70, 5 — более 85 из 100" && svp.planBands === "зачёт — более 60 из 100", `${sv.planBands} | ${svp.planBands}`);
const dbs = [{ name: "Распределённые базы данных" }, { name: "Базы данных" }], dbc = [{ id: 1, name: "Базы данных. Осень 2026" }];
check("ничья по сходству: курс «Базы данных. Осень 2026» — дисциплине «Базы данных» при любом порядке", a.matchCourse(dbs, dbc, dbs[1])?.id === 1 && a.matchCourse(dbs, dbc, dbs[0]) === null && a.matchCourse([dbs[1], dbs[0]], dbc, dbs[1])?.id === 1);
check("справки нет у другого плана и у «Русского языка как иностранного»", a.subjectInfo("https://misis.ru/sveden/files/aic/09.03.01-BIVT-24.plx.pdf", { name: "Иностранный язык" }) === null && a.subjectInfo(planUrl, { name: "Русский язык как иностранный" }) === null && a.subjectInfo(null, { name: "Иностранный язык" }) === null);

// ---------- arrange: какие дисциплины у студента на самом деле (15 окт 2026, перевод Волкова, БИВТ-24) ----------
const LBL = { "Эк": "экзамен", "За": "зачёт", "ЗаО": "зачёт с оценкой", "КР": "курсовая работа" };
const sub = (index, name, controls, kind = "discipline") => ({ index, name, kind, controls, labels: controls.map((c) => LBL[c]),
  elective: /^(Б\d\.[А-Я]+\.ДВ\.\d+)\.\d+/.exec(index)?.[1] || null, exam: controls.includes("Эк"), graded: controls.includes("ЗаО"), pass: controls.includes("За"), coursework: controls.includes("КР") });
const bivt = { semester: 5, subjects: [
  sub("Б1.О.28", "Основ теории информации", ["Эк"]), sub("Б1.О.29", "Теория систем и системный анализ", ["Эк"]), sub("Б1.О.30", "Имитационное моделирование", ["Эк", "КР"]),
  sub("Б1.В.ДВ.01.01", "Python для анализа данных", ["ЗаО"]), sub("Б1.В.ДВ.01.02", "Системная и программная инженерия", ["ЗаО"]), sub("Б1.В.ДВ.01.03", "Теория систем автоматического управления", ["ЗаО"]),
  sub("Б1.В.ДВ.02.01", "Методы статистического анализа данных", ["ЗаО"]), sub("Б1.В.ДВ.02.02", "Основы электроники и схемотехники", ["ЗаО"]),
  sub("Б1.О.05", "Иностранный язык", ["ЗаО"]), sub("Б1.О.22", "Введение в прикладной ИИ", ["ЗаО"]),
  sub("ФТД.02", "Иностранный язык", ["За"], "optional"), sub("ФТД.03", "Русский язык как иностранный", ["За"], "optional"),
  sub("Б1.В.01", "Элективные курсы по физической культуре и спорту", []),
], earlier: [{ index: "Б1.О.02", name: "История России", kind: "discipline", semesters: [1, 2] }, { index: "Б1.О.05", name: "Иностранный язык", kind: "discipline", semesters: [1, 2, 3, 4] }] };
const volkovMoodle = [{ id: 1, name: "История России" }, { id: 2, name: "Пересдачи Иностранный язык -" }, { id: 3, name: "ESP 2026" }, { id: 4, name: "Методы статистического анализа данных" }, { id: 5, name: "Теория систем и системный анализ" }];
const names = (l) => l.map((s) => s.name);
{
  const r = a.arrange({ plan: bivt, journal: null, mcourses: volkovMoodle, today: "2026-10-15" });
  const dv1 = r.subjects.filter((s) => s.elective === "Б1.В.ДВ.01"), dv2 = r.subjects.filter((s) => s.elective === "Б1.В.ДВ.02");
  check("журнала нет: вариант по выбору — по курсу Moodle («Методы статистического анализа данных»), второй вариант убран", dv2.length === 1 && dv2[0].name === "Методы статистического анализа данных" && dv2[0].electiveFrom === "moodle", names(dv2).join(" | "));
  check("не найден ни в журнале, ни в Moodle — все 3 варианта с electiveOpen и списком вариантов", dv1.length === 3 && dv1.every((s) => s.electiveOpen === 3 && s.variants?.length === 3), JSON.stringify(dv1.map((s) => [s.name, s.electiveOpen])));
  check("факультативы (ФТД) — отдельно, не среди зачётов", names(r.optional).join("|") === "Иностранный язык|Русский язык как иностранный" && !r.subjects.some((s) => s.kind === "optional"), names(r.optional).join("|"));
  check("счётчики: 3 экзамена, 4 зачёта с оценкой (группа без выбора — один раз), 0 зачётов, 1 курсовая", r.counts.exam === 3 && r.counts.graded === 4 && r.counts.pass === 0 && r.counts.coursework === 1, JSON.stringify(r.counts));
  const hist = r.extra.find((x) => x.name === "История России"), eng = r.extra.find((x) => x.why === "retake");
  check("вне плана: «История России» 1–2 семестра — академическая разница, с курсом Moodle; курс пересдачи — пересдача «Иностранный язык»; ESP не попал",
    hist?.why === "earlier" && hist.planSemesters.join() === "1,2" && hist.course?.id === 1 && eng?.name === "Иностранный язык" && eng.month === null && r.extra.length === 2, JSON.stringify(r.extra.map((x) => [x.name, x.why])));

  // Уточнения самого студента главнее догадок.
  const ch = a.arrange({ plan: bivt, journal: null, mcourses: volkovMoodle, today: "2026-10-15", choices: {
    electives: { "Б1.В.ДВ.01": "Б1.В.ДВ.01.02", "Б1.В.ДВ.02": "Б1.В.ДВ.02.02" }, optional: { "ФТД.03": true },
    hidden: { "s:5:Б1.О.22": true, [r.extra.find((x) => x.why === "retake").key]: true } } });
  const c1 = ch.subjects.filter((s) => s.elective === "Б1.В.ДВ.01"), c2 = ch.subjects.filter((s) => s.elective === "Б1.В.ДВ.02");
  check("выбор студента: вариант из ДВ.01 и другой вариант ДВ.02, чем нашёлся в Moodle — оба «выбрано вами»", c1.length === 1 && c1[0].index === "Б1.В.ДВ.01.02" && c2.length === 1 && c2[0].index === "Б1.В.ДВ.02.02" && c1[0].electiveFrom === "user" && c2[0].electiveFrom === "user", JSON.stringify([...c1, ...c2].map((s) => s.index)));
  check("«хожу» на факультатив — он в сессии и в счётчике зачётов; второй остался факультативом", ch.subjects.some((s) => s.index === "ФТД.03" && s.attending && s.attendingFrom === "user") && ch.counts.pass === 1 && names(ch.optional).join() === "Иностранный язык", JSON.stringify(ch.counts));
  check("«не моё»: дисциплина и пересдача ушли в скрытые, счётчик зачётов с оценкой — 3", !ch.subjects.some((s) => s.index === "Б1.О.22") && ch.hidden.length === 2 && !ch.extra.some((x) => x.why === "retake") && ch.counts.graded === 3, JSON.stringify({ hidden: names(ch.hidden), counts: ch.counts }));
  const none = a.arrange({ plan: bivt, journal: null, mcourses: volkovMoodle, today: "2026-10-15", choices: { optional: { "ФТД.02": false }, electives: { "Б1.В.ДВ.02": "нет-такого" } } });
  check("неизвестный индекс варианта не ломает выбор (остаётся Moodle); «не хожу» оставляет факультатив вне сессии", none.subjects.filter((s) => s.elective === "Б1.В.ДВ.02").map((s) => s.electiveFrom).join() === "moodle" && none.optional.length === 2);
}
{
  // Группа владельца (БИСТ-24, 15 окт): журнал и Moodle по своим дисциплинам; ничего «вне плана» быть не должно.
  const bist = { semester: 5, subjects: [
    sub("Б1.О.24", "Теория информационных процессов и систем", ["Эк"]), sub("Б1.О.25", "Оптимизация клиент-серверных приложений", ["Эк", "КР"]), sub("Б1.О.26", "Цифровая электроника", ["Эк"]),
    sub("Б1.В.ДВ.01.01", "Технологии распределенных приложений", ["ЗаО"]), sub("Б1.В.ДВ.01.02", "Решение задач с использованием прикладного ПО", ["ЗаО"]),
    sub("Б1.В.ДВ.02.01", "Методы оптимизации", ["ЗаО"]), sub("Б1.В.ДВ.02.02", "Цифровые интерфейсы", ["ЗаО"]),
    sub("Б1.О.05", "Иностранный язык", ["ЗаО"]), sub("Б1.О.23", "Сетевые приложения на языке программирования Python", ["ЗаО"]), sub("Б1.О.27", "Моделирование информационных процессов и систем", ["ЗаО", "КР"]),
    sub("Б1.В.01", "Элективные курсы по физической культуре и спорту", []),
  ], earlier: [{ index: "Б1.О.02", name: "История России", kind: "discipline", semesters: [1, 2] }] };
  const jr = { subjects: ["Методы оптимизации", "Моделирование информационных процессов и систем", "Оптимизация клиент-серверных приложений", "Сетевые приложения на языке программирования Python", "Теория информационных процессов и систем", "Технологии распределенных приложений"].map((name) => ({ name, control: "Зачёт с оценкой", works: [] })) };
  const mc = ["ESP 2026", "Методы оптимизации", "Технологии распределенных приложений", "Сетевые приложения на языке программирования Python", "Оптимизация клиент-серверных приложений", "Цифровая электроника", "Моделирование информационных процессов и систем", "Математика пересдача март 2026"].map((name, id) => ({ id, name }));
  const r = a.arrange({ plan: bist, journal: jr, mcourses: mc, today: "2026-10-15" });
  check("БИСТ: выбор по журналу (ТРП, Методы оптимизации), «Цифровая электроника» на месте, вне плана — ничего (пересдача марта прошла)",
    r.subjects.filter((s) => s.elective).map((s) => `${s.name}:${s.electiveFrom}`).join("|") === "Технологии распределенных приложений:journal|Методы оптимизации:journal" && r.subjects.some((s) => s.name === "Цифровая электроника") && r.extra.length === 0, JSON.stringify(r.extra));
  check("БИСТ: 3 экзамена, 5 зачётов с оценкой (было 7 — считались оба варианта по выбору), 2 курсовые", r.counts.exam === 3 && r.counts.graded === 5 && r.counts.coursework === 2, JSON.stringify(r.counts));
  // Дисциплина в журнале, которой нет в плане семестра: та, что в плане раньше, — академическая разница; курс Moodle прикрепляется.
  const j2 = { subjects: [...jr.subjects, { name: "История России", control: "Зачёт с оценкой", works: [] }, { name: "Деловое общение", control: "Зачёт", works: [] }] };
  const r2 = a.arrange({ plan: bist, journal: j2, mcourses: [...mc, { id: 99, name: "История России" }], today: "2026-10-15" });
  const h = r2.extra.find((x) => x.name === "История России"), d = r2.extra.find((x) => x.name === "Деловое общение");
  check("журнал: «История России» — академическая разница с курсом Moodle (одной записью); «Деловое общение» — только в журнале, зачёт",
    h?.why === "earlier" && h.course?.id === 99 && h.label === "зачёт с оценкой" && d?.why === "journal" && d.pass === true && r2.extra.length === 2, JSON.stringify(r2.extra.map((x) => [x.name, x.why, x.course?.id])));
}
{
  // Одноимённые варианты (НИР у разных кафедр) — одна дисциплина, без «один из 5».
  const p = { semester: 6, subjects: [1, 2, 3].map((n) => sub(`Б2.В.ДВ.04.0${n}(Н)`, "Научно-исследовательская работа", ["ЗаО"])), earlier: [] };
  const r = a.arrange({ plan: p, journal: null, mcourses: [], today: "2027-03-01" });
  check("одноимённые варианты по выбору — одна дисциплина, не «одна из N», в счётчике один раз", r.subjects.length === 1 && !r.subjects[0].electiveOpen && r.counts.graded === 1);
  // «Иностранный язык» журнала — обязательной дисциплине, а не одноимённому факультативу.
  const rj = a.arrange({ plan: bivt, journal: { subjects: [{ name: "Иностранный язык", control: "Зачёт с оценкой", works: [] }] }, mcourses: [], today: "2026-10-15" });
  check("одноимённый факультатив не считается «записан» по журналу обязательной дисциплины", rj.optional.length === 2 && rj.subjects.find((s) => s.index === "Б1.О.05")?._js?.name === "Иностранный язык");
}
// ---------- находки проверки 15 окт (5 линз + скептики) ----------
{
  // БИВТ-24, 6 семестр: «Математика» (1–4 семестр, академическая разница) не должна выбирать вариант «Математические модели…».
  const p6 = { semester: 6, subjects: [
    sub("Б1.В.ДВ.07.01", "Современные инструментальные средства анализа данных", ["Эк"]), sub("Б1.В.ДВ.07.02", "Математические модели социально- экономических систем", ["Эк"]), sub("Б1.В.ДВ.07.03", "Введение в IoT системы", ["Эк"]),
    sub("Б1.В.ДВ.04.01", "Интеллектуальный анализ данных", ["ЗаО"]), sub("Б1.В.ДВ.04.02", "Технологии решения задач машинного обучения", ["ЗаО"]),
    sub("Б1.О.40", "Теория информационных процессов и систем", ["Эк"]),
  ], earlier: [{ index: "Б1.О.06", name: "Математика", kind: "discipline", semesters: [1, 2, 3, 4] }, { index: "Б1.В.ДВ.01.01", name: "Python для анализа данных", kind: "discipline", semesters: [5] }] };
  const rj = a.arrange({ plan: p6, journal: { subjects: [{ name: "Математика", control: "Зачёт с оценкой", works: [] }] }, mcourses: [], today: "2027-03-01" });
  const rm = a.arrange({ plan: p6, journal: null, mcourses: [{ id: 11, name: "Математика" }, { id: 12, name: "Python для анализа данных" }], today: "2027-03-01" });
  const dv7 = (r) => r.subjects.filter((s) => s.elective === "Б1.В.ДВ.07");
  check("«Математика» (прошлые семестры) не выбирает вариант «Математические модели…» и попадает в академическую разницу — из журнала и из Moodle; «Python…» 5 семестра не выбирает ДВ.04",
    dv7(rj).length === 3 && dv7(rj).every((s) => s.electiveOpen === 3) && rj.extra.some((x) => x.name === "Математика" && x.why === "earlier")
    && dv7(rm).length === 3 && rm.subjects.filter((s) => s.elective === "Б1.В.ДВ.04").length === 2 && rm.extra.map((x) => `${x.name}:${x.why}:${x.course?.id}`).sort().join("|") === "Python для анализа данных:earlier:12|Математика:earlier:11",
    JSON.stringify({ j: rj.extra.map((x) => x.name), m: rm.extra.map((x) => x.name), dv7: dv7(rj).map((s) => s.electiveFrom) }));
  // Похожее на дисциплину плана, но не её пара, не пропадает: «Моделирование…» из журнала рядом с «Теорией…» плана.
  const rs = a.arrange({ plan: p6, journal: { subjects: [{ name: "Теория информационных процессов и систем", control: "Экзамен", works: [] }, { name: "Моделирование информационных процессов и систем", control: "Зачёт с оценкой", works: [] }] }, mcourses: [], today: "2027-03-01" });
  check("дисциплина журнала, похожая на дисциплину плана, но не её пара, — «только в журнале», а не пропадает", rs.extra.some((x) => x.name === "Моделирование информационных процессов и систем" && x.why === "journal") && rs.subjects.find((s) => s.index === "Б1.О.40")?._js?.name === "Теория информационных процессов и систем", JSON.stringify(rs.extra.map((x) => [x.name, x.why])));
}
{
  // Журнал главнее Moodle; несколько вариантов только по Moodle (поток записан на все курсы) — выбор не ясен.
  const p = { semester: 5, subjects: [sub("Б1.В.ДВ.02.01", "Методы оптимизации", ["ЗаО"]), sub("Б1.В.ДВ.02.02", "Цифровые интерфейсы", ["ЗаО"])], earlier: [] };
  const mc = [{ id: 1, name: "Методы оптимизации" }, { id: 2, name: "Цифровые интерфейсы" }];
  const jm = a.arrange({ plan: p, journal: { subjects: [{ name: "Цифровые интерфейсы", control: "Зачёт с оценкой", works: [] }] }, mcourses: mc, today: "2026-10-15" });
  const mm = a.arrange({ plan: p, journal: null, mcourses: mc, today: "2026-10-15" });
  check("журнал главнее Moodle: остался вариант из журнала; оба варианта в Moodle — «один из 2», в счётчике один раз",
    jm.subjects.length === 1 && jm.subjects[0].name === "Цифровые интерфейсы" && jm.subjects[0].electiveFrom === "journal" && jm.counts.graded === 1
    && mm.subjects.length === 2 && mm.subjects.every((s) => s.electiveOpen === 2) && mm.counts.graded === 1, JSON.stringify({ jm: jm.subjects.map((s) => s.name), mm: mm.counts }));
  // «Не моё» на определившемся варианте — второй вариант остаётся (а не пропадает вся группа), скрытый можно вернуть.
  const hv = a.arrange({ plan: p, journal: { subjects: [{ name: "Методы оптимизации", control: "Зачёт с оценкой", works: [] }] }, mcourses: [], today: "2026-10-15", choices: { hidden: { "s:5:Б1.В.ДВ.02.01": true } } });
  check("«не моё» на варианте, определённом по журналу: остаётся другой вариант, скрытый — в списке скрытых", hv.subjects.map((s) => s.name).join() === "Цифровые интерфейсы" && hv.hidden.map((s) => s.name).join() === "Методы оптимизации", JSON.stringify({ s: hv.subjects.map((s) => s.name), h: hv.hidden.map((s) => s.name) }));
  // Журнал другого семестра с планом не сравнивается.
  const os = a.arrange({ plan: p, journal: { semester: "Весенний семестр 25–26 г.", subjects: [{ name: "Методы оптимизации", control: "Зачёт с оценкой", works: [] }, { name: "Физика", control: "Экзамен", works: [] }] }, mcourses: [], today: "2026-09-02" });
  check("журнал весеннего семестра при плане 5 (осеннего) не используется: ничего «вне плана», выбор не из журнала", os.extra.length === 0 && os.subjects.every((s) => s.electiveOpen === 2), JSON.stringify(os.extra));
}
{
  // Пересдача той же дисциплины, что уже «вне плана», — одна запись при любом порядке курсов; баллы журнала остаются.
  const p = { semester: 5, subjects: [sub("Б1.О.24", "Теория информационных процессов и систем", ["Эк"])], earlier: [{ index: "Б1.О.02", name: "История России", kind: "discipline", semesters: [1, 2] }] };
  const c1 = { id: 1, name: "История России" }, c2 = { id: 2, name: "История России пересдача ноябрь 2026" };
  const r1 = a.arrange({ plan: p, journal: null, mcourses: [c1, c2], today: "2026-10-15" }), r2 = a.arrange({ plan: p, journal: null, mcourses: [c2, c1], today: "2026-10-15" });
  const rj = a.arrange({ plan: p, journal: { subjects: [{ name: "Теория информационных процессов и систем", control: "Экзамен", works: [] }, { name: "История России", control: "Зачёт с оценкой", works: [] }] }, mcourses: [c2], today: "2026-10-15" });
  check("пересдача и академическая разница одной дисциплины — одна запись «пересдача» при любом порядке; из журнала — с его баллами",
    r1.extra.length === 1 && r2.extra.length === 1 && r1.extra[0].why === "retake" && r2.extra[0].why === "retake" && r1.extra[0].month === "2026-11" && rj.extra.length === 1 && rj.extra[0].why === "retake" && rj.extra[0]._js?.name === "История России",
    JSON.stringify([r1.extra, r2.extra, rj.extra].map((e) => e.map((x) => [x.name, x.why, x.month]))));
}
// ---------- повторная проверка 15 окт ----------
{
  // Физкультура: «Физическая культура и спорт» журнала/Moodle — пара «Элективных курсов…» этого семестра, не разница.
  const p = { semester: 5, subjects: [sub("Б1.В.01", "Элективные курсы по физической культуре и спорту", [])], earlier: [{ index: "Б1.О.04", name: "Физическая культура и спорт", kind: "discipline", semesters: [2, 4] }] };
  const r = a.arrange({ plan: p, journal: { subjects: [{ name: "Физическая культура и спорт", control: "Зачёт", works: [] }] }, mcourses: [{ id: 77, name: "Физическая культура и спорт" }], today: "2026-10-15" });
  check("физкультура журнала и Moodle — пара «Элективных курсов по физической культуре», не «академическая разница»", r.extra.length === 0 && !!r.subjects[0]._js && r.subjects[0]._mc?.id === 77, JSON.stringify(r.extra));
  // Пересдача не приклеивается к похожей дисциплине: «Иностранный язык» ≠ «Русский язык как иностранный».
  const p2 = { semester: 5, subjects: [sub("Б1.О.24", "Теория информационных процессов и систем", ["Эк"])], earlier: [{ index: "ФТД.03", name: "Русский язык как иностранный", kind: "optional", semesters: [3, 4] }] };
  const r2 = a.arrange({ plan: p2, journal: null, mcourses: [{ id: 1, name: "Русский язык как иностранный" }, { id: 2, name: "Пересдачи Иностранный язык -" }], today: "2026-10-15" });
  check("пересдача «Иностранный язык» — отдельная запись, а не слита с «Русским языком как иностранным»", r2.extra.length === 2 && r2.extra.some((x) => x.why === "retake" && x.name === "Иностранный язык") && r2.extra.some((x) => x.why === "earlier" && x.name === "Русский язык как иностранный"), JSON.stringify(r2.extra.map((x) => [x.name, x.why])));
  // Не ясно, какой вариант: открыты все варианты, а не только нашедшиеся в Moodle.
  const p3 = { semester: 6, subjects: [sub("Б1.В.ДВ.07.01", "Современные инструментальные средства анализа данных", ["Эк"]), sub("Б1.В.ДВ.07.02", "Веб-аналитика", ["Эк"]), sub("Б1.В.ДВ.07.03", "Введение в IoT системы", ["Эк"])], earlier: [] };
  const r3 = a.arrange({ plan: p3, journal: null, mcourses: [{ id: 1, name: "Современные инструментальные средства анализа данных" }, { id: 2, name: "Веб-аналитика" }, { id: 3, name: "IoT 2027" }], today: "2027-03-01" });
  check("два варианта нашлись в Moodle, третий назван иначе — открыты все три", r3.subjects.length === 3 && r3.subjects.every((s) => s.electiveOpen === 3), JSON.stringify(r3.subjects.map((s) => [s.name, s.electiveOpen])));
  // Журнал другого семестра — флаг для overview («журнал показывает другой семестр»).
  const r4 = a.arrange({ plan: p3, journal: { semester: "Осенний семестр 26–27 г.", subjects: [{ name: "Веб-аналитика", control: "Экзамен", works: [] }] }, mcourses: [], today: "2027-02-03" });
  check("журнал осеннего семестра при плане 6 — journalSkipped, выбор не из журнала", r4.journalSkipped === true && r4.subjects.every((s) => s.electiveOpen === 3));
}
check("пересдача «декабрь 2026 – январь 2027» живёт до января; название без обрывков", a.retakeOf("Математика пересдача декабрь 2026 – январь 2027", "2027-01-20").stale === false && a.retakeOf("Математика пересдача декабрь 2026 – январь 2027", "2027-01-20").month === "2027-01" && a.retakeOf("Математика пересдача декабрь 2026 – январь 2027", "2027-01-20").subject === "Математика",
  JSON.stringify(a.retakeOf("Математика пересдача декабрь 2026 – январь 2027", "2027-01-20")));
const rt = (n) => a.retakeOf(n, "2026-10-15");
check("пересдачи: «Математика (пересдача)», «Пересдача по математике», «январь-февраль 2027», «2026 октябрь», «Пересдача: Физика (май 2027)»",
  rt("Математика (пересдача)").subject === "Математика" && rt("Пересдача по математике").subject === "Математике" && rt("Пересдачи январь-февраль 2027 Математика").subject === "Математика" && rt("Пересдачи январь-февраль 2027 Математика").month === "2027-02"
  && rt("Математика пересдача 2026 октябрь").month === "2026-10" && rt("Математика пересдача 2026 март").stale && rt("Пересдача: Физика (май 2027)").subject === "Физика" && rt("Пересдача: Физика (май 2027)").month === "2027-05",
  JSON.stringify(["Математика (пересдача)", "Пересдача по математике", "Пересдачи январь-февраль 2027 Математика", "Математика пересдача 2026 октябрь", "Пересдача: Физика (май 2027)"].map(rt)));
check("пересдачи: месяц прошёл — stale; текущий — нет; без даты — предмет из названия", rt("Математика пересдача март 2026").stale && !rt("Математика пересдача октябрь 2026").stale && rt("Математика пересдача октябрь 2026").subject === "Математика" && rt("Математика пересдача октябрь 2026").month === "2026-10" && rt("Пересдачи Иностранный язык -").subject === "Иностранный язык" && rt("Математика") === null,
  JSON.stringify([rt("Математика пересдача октябрь 2026"), rt("Пересдачи Иностранный язык -")]));

// Дисциплины журнала без курса в Moodle (16 окт 2026: о них бот спрашивает студента). Курсы — как на снимке владельца:
// 7 курсов «Осень 2026» (названия после cleanCourse), журнал — с «Теорией информационных процессов и систем».
{
  const OCT = Date.parse("2026-10-16T12:00:00+03:00");
  const d = { courses: ["Методы оптимизации", "Моделирование информационных процессов и систем", "Оптимизация клиент-серверных приложений", "Цифровая электроника",
    "Сетевые приложения на языке программирования", "Технологии распределённых приложений", "ESP 2026"].map((name, i) => ({ id: 100 + i, name })), pendingCourses: [] };
  const ej = { semester: "Осенний семестр 26–27 г.", subjects: ["Методы оптимизации", "Моделирование информационных процессов и систем", "Теория информационных процессов и систем",
    "Оптимизация клиент-серверных приложений", "Цифровая электроника", "Технологии распределенных приложений", "Сетевые приложения на языке программирования"].map((name, i) => ({ id: i + 1, name })) };
  const un = a.unmatchedSubjects(ej, d, OCT);
  check("без курса в Moodle — только «Теория информационных процессов и систем» (курс «Моделирования…» ей не пара; ё = е)", un?.length === 1 && un[0].name === "Теория информационных процессов и систем", JSON.stringify(un?.map((s) => s.name)));
  check("курсов ещё нет (после перезапуска, Moodle на паузе) — не с чем сравнить: null, а не «всё без курса»", a.unmatchedSubjects(ej, null, OCT) === null && a.unmatchedSubjects(ej, { courses: [], pendingCourses: [] }, OCT) === null);
  check("журнал весеннего семестра с осенними курсами не сравнивается — null", a.unmatchedSubjects({ ...ej, semester: "Весенний семестр 25–26 г." }, d, OCT) === null);
  check("курс прошлого семестра, о котором студента уже спрашивают (pendingCourses), — тоже курс в Moodle", a.unmatchedSubjects(ej, { ...d, pendingCourses: [{ id: 900, name: "Теория информационных процессов и систем" }] }, OCT)?.length === 0);
  check("журнал пустой — null", a.unmatchedSubjects({ semester: ej.semester, subjects: [] }, d, OCT) === null && a.unmatchedSubjects(null, d, OCT) === null);
  // Начало семестра: в журнале уже новые дисциплины, а в Moodle — только «ESP 2026» (курсы ещё не завели) — не ворох вопросов.
  check("без курса больше половины дисциплин (Moodle ещё не заполнен) — null, а не вопрос о каждой", a.unmatchedSubjects(ej, { courses: [{ id: 106, name: "ESP 2026" }], pendingCourses: [] }, OCT) === null);
  const half = { ...ej, subjects: ej.subjects.slice(0, 4).concat({ id: 50, name: "Физика" }, { id: 51, name: "Химия" }) }; // 6 дисциплин: 3 с курсом, 3 без
  check("ровно половина без курса — ещё расхождение: спрашиваем о трёх", a.unmatchedSubjects(half, d, OCT)?.map((s) => s.name).join() === "Теория информационных процессов и систем,Физика,Химия", JSON.stringify(a.unmatchedSubjects(half, d, OCT)?.map((s) => s.name)));
  const dup = { ...ej, subjects: [...ej.subjects, { id: 99, name: "Методы оптимизации" }] };
  check("два журнала одной дисциплины — у второго тот же курс, вопроса о нём нет", a.unmatchedSubjects(dup, d, OCT)?.map((s) => s.id).join() === "3", JSON.stringify(a.unmatchedSubjects(dup, d, OCT)));
}

// «Не моё» — одно на бота и «Сессию» (16 окт 2026, позже): ответ «не моя» боту (journalAsk[id журнала]) и «Не моё» в
// «Сессии» (hidden[ключ]) сопоставляются через пару arrange; решает последнее слово студента.
{
  const T0 = 1_760_000_000_000;
  check("notMineNow: только бот «не моя» — не моё; «моя» или без ответа — моё; только «Сессия» (время или старое true) — не моё",
    a.notMineNow(null, { answer: "no", answeredAt: T0 }) && !a.notMineNow(null, { answer: "yes", answeredAt: T0 }) && !a.notMineNow(null, { answer: null }) && !a.notMineNow(null, null)
    && a.notMineNow(T0, null) && a.notMineNow(true, null) && a.notMineNow(T0, { answer: null }));
  check("notMineNow: последнее слово — «Не моё» после «моя» в боте — не моё; «Всё-таки моя» после «Не моё» — моё; старое true уступает ответу «моя»",
    a.notMineNow(T0 + 10, { answer: "yes", answeredAt: T0 }) && !a.notMineNow(T0, { answer: "yes", answeredAt: T0 + 10 }) && !a.notMineNow(true, { answer: "yes", answeredAt: T0 }) && a.notMineNow(T0, { answer: "no", answeredAt: T0 + 10 }));
  const p = { semester: 5, subjects: [sub("Б1.О.24", "Теория информационных процессов и систем", ["Эк"]), sub("Б1.О.25", "Методы оптимизации", ["ЗаО"])], earlier: [] };
  const jr = { semester: "Осенний семестр 26–27 г.", subjects: [{ id: 101, name: "Теория информационных процессов и систем", control: "Экзамен", works: [] },
    { id: 102, name: "Методы оптимизации", control: "Зачёт с оценкой", works: [] }, { id: 103, name: "Физика", control: "Экзамен", works: [] }] };
  const ar = (o = {}) => a.arrange({ plan: p, journal: jr, mcourses: [], today: "2026-10-16", ...o });
  const base = ar();
  check("pairs: ключ «Сессии» ↔ id журнала — у дисциплин плана и у «вне плана» из журнала",
    JSON.stringify(base.pairs) === JSON.stringify([{ key: "s:5:Б1.О.24", ejId: 101 }, { key: "s:5:Б1.О.25", ejId: 102 }, { key: "x:5:физика", ejId: 103 }]), JSON.stringify(base.pairs));
  const bot = ar({ asked: { 101: { answer: "no", answeredAt: T0 }, 103: { answer: "no", answeredAt: T0 } } });
  check("«не моя» в боте — в «Сессии» скрыта (from bot), без счёта экзаменов; дисциплина «вне плана» — тоже",
    !bot.subjects.some((s) => s.index === "Б1.О.24") && bot.counts.exam === 0 && bot.extra.length === 0
    && bot.hidden.map((s) => `${s.name}:${s.hiddenFrom}`).join() === "Теория информационных процессов и систем:bot,Физика:bot", JSON.stringify(bot.hidden.map((s) => [s.name, s.hiddenFrom])));
  const later = ar({ choices: { hidden: { "s:5:Б1.О.24": T0 } }, asked: { 101: { answer: "yes", answeredAt: T0 + 5 } } });
  const ses = ar({ choices: { hidden: { "s:5:Б1.О.25": T0 + 5 } }, asked: { 102: { answer: "yes", answeredAt: T0 } } });
  check("«Всё-таки моя» в боте после «Не моё» в «Сессии» — снова в списке; «Не моё» после «моя» в боте — скрыта (from session)",
    later.subjects.some((s) => s.index === "Б1.О.24") && !later.hidden.length && ses.hidden.map((s) => `${s.name}:${s.hiddenFrom}`).join() === "Методы оптимизации:session",
    JSON.stringify({ later: later.hidden.map((s) => s.name), ses: ses.hidden.map((s) => [s.name, s.hiddenFrom]) }));
  const byJ = a.hiddenByJournal(base.pairs, { "s:5:Б1.О.25": T0, "x:5:физика": true, "s:5:Б1.О.99": T0 });
  check("hiddenByJournal: отметки «Сессии» → id журнала (строкой); ключ без пары — мимо", [...byJ.keys()].sort().join() === "102,103", JSON.stringify([...byJ]));
  const off = a.notMineIds(jr.subjects, { 101: { answer: "no", answeredAt: T0 }, 102: { answer: "yes", answeredAt: T0 + 10 } }, byJ);
  check("notMineIds: «не моя» бота (101) и «Не моё» «Сессии» (103) — не свои; «моя» в боте позже отметки «Сессии» (102) — своя",
    [...off].map(([k, v]) => `${k}:${v}`).sort().join() === "101:bot,103:session", JSON.stringify([...off]));
  const o = { semester: 5, upcoming: null, planError: null, periods: [], today: "2026-10-16", counts: { exam: 1, graded: 0, pass: 0 }, journal: { state: "ok" }, moodle: { state: "ok" },
    subjects: [], optional: [], extra: [], hidden: [{ name: "Физика", from: "bot" }, { name: "История России", from: "session" }], exams: { published: false } };
  check("сводка «Сессии» (14 и 3 дня, /session): скрытое студентом — одной строкой с «как вернуть», а не молча",
    /🚫 Вы отметили как не ваши \(в приложении или в боте\) — в сводке не считаются: Физика; История России\. Вернуть: Doodle → Журнал → Сессия\./.test(a.summaryText(o)), a.summaryText(o).replace(/\n/g, " ⏎ "));
}

// Сохранённый пароль журнала не подошёл (16 окт 2026, п. 150): ejState.rejected — «Сессия» и /session пишут «возможно,
// сменили», как вкладка «Журнал», а не «вход истёк» (банка ещё есть) и не «не подключён» (банки уже нет).
{
  const need = Object.assign(new Error("MISIS ID не принял сохранённый пароль — нужен новый"), { code: "need_password" });
  const rej = { connected: false, saved: false, rejected: true, error: "MISIS ID не принял сохранённый пароль (возможно, его сменили): …" };
  check("journalState: пароль отвергнут — rejected и без банки (connected false), и с банкой и need_password",
    a.journalState(null, rej).state === "rejected" && a.journalState(null, { ...rej, connected: true }, need).state === "rejected",
    JSON.stringify([a.journalState(null, rej), a.journalState(null, { ...rej, connected: true }, need)]));
  check("journalState: журнал загружен — ok и при rejected; без отказа — прежние need_password / not_connected / error",
    a.journalState({ at: 5 }, rej).state === "ok"
    && a.journalState(null, { connected: true, rejected: false, error: "Вход MISIS ID истёк — нужен пароль" }).state === "need_password"
    && a.journalState(null, { connected: true, rejected: false }, need).state === "need_password"
    && a.journalState(null, { connected: false, rejected: false }).state === "not_connected"
    && a.journalState(null, { connected: true, rejected: false }, new Error("502")).state === "error");
  const o = { semester: 5, upcoming: null, planError: null, periods: [], today: "2026-10-16", counts: { exam: 1, graded: 0, pass: 0 }, journal: a.journalState(null, rej), moodle: { state: "ok" },
    subjects: [], optional: [], extra: [], hidden: [], exams: { published: false } };
  const txt = a.summaryText(o);
  check("/session при rejected: «Сохранённый пароль от журнала не подошёл — возможно, вы его сменили… введите текущий пароль», без «истёк» и «не подключён»",
    /⚠️ Сохранённый пароль от журнала не подошёл — возможно, вы его сменили\..*Откройте Doodle → Журнал и введите текущий пароль\./.test(txt) && !/истёк|не подключён/.test(txt), txt.replace(/\n/g, " ⏎ "));
}

console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
