// Проверка таблиц преподавателей (Excel в курсе Moodle): sheet_xls.py → sheets.mjs (своя строка, баллы, посещения),
// course-sheets.mjs (что считается таблицей в курсе, ссылки) и admission.mjs (баллы «Сессии», откуда баллы) — без сети.
// Файлы собирает openpyxl по описаниям ниже; ФИО и цифры выдуманы (настоящие таблицы курсов с чужими строками в
// репозиторий не кладём). Запуск: node ops\stand\sheets-test.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

process.env.SESSION_WATCH = "0";
const APP = new URL("../../", import.meta.url);
const sheets = await import(new URL("sheets.mjs", APP));
const cs = await import(new URL("course-sheets.mjs", APP));
const adm = await import(new URL("admission.mjs", APP));
const mplan = await import(new URL("moodle-plan.mjs", APP));

let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const PY = [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"].find((p) => p && existsSync(p)) || "python";
const PY_ENV = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python"), PYTHONIOENCODING: "utf-8" };
const TMP = mkdtempSync(join(tmpdir(), "sheets-test-"));
writeFileSync(join(TMP, "make_xlsx.py"), [
  "import datetime, json, sys", "import openpyxl",
  "spec = json.load(open(sys.argv[1], encoding='utf-8'))",
  "def val(v):",
  "    if isinstance(v, dict) and 'date' in v: return datetime.datetime.fromisoformat(v['date'])",
  "    if isinstance(v, dict) and 'formula' in v: return v['formula']",
  "    return v",
  "wb = openpyxl.Workbook(); wb.remove(wb.active)",
  "for sh in spec['sheets']:",
  "    ws = wb.create_sheet(sh['title'])",
  "    for row in sh['rows']: ws.append([val(v) for v in row])",
  "    for rng in sh.get('merge', []): ws.merge_cells(rng)",
  "    if sh.get('hidden'): ws.sheet_state = 'hidden'",
  "wb.save(spec['out'])", ""].join("\n"));
let nfile = 0;
/** sheets: [{ title, rows, merge?, hidden? }]; ячейка: строка | число | null | {date} | {formula} (значение формулы openpyxl не сохраняет). */
function makeXlsx(sheetsSpec) {
  const out = join(TMP, `f${++nfile}.xlsx`), spec = join(TMP, `f${nfile}.json`);
  writeFileSync(spec, JSON.stringify({ out, sheets: sheetsSpec }));
  const r = spawnSync(PY, [join(TMP, "make_xlsx.py"), spec], { encoding: "utf8", env: PY_ENV, windowsHide: true });
  if (r.status !== 0) throw new Error(`openpyxl: ${(r.stderr || String(r.error || "")).trim().split("\n").pop()}`);
  return out;
}
function dump(file) {
  const r = spawnSync(PY, [new URL("sheet_xls.py", APP).pathname.replace(/^\/([A-Z]:)/i, "$1"), file], { encoding: "utf8", env: PY_ENV, windowsHide: true });
  if (r.status !== 0) throw new Error(`sheet_xls.py: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const ME = { fullname: "Морозов Пётр Ильич", firstname: "Пётр", lastname: "Морозов" };
const MOD = Date.parse("2026-10-14T10:00:00Z");

// ---------- 1. Журнал по занятиям, лист на группу (как «Методы оптимизации» 2026) ----------
{
  const head = (group) => [
    [null, "Электронный журнал посещаемости по дисциплине", null, null, null, null, "Лекции", null, null, null, "Лабораторные работы", null, null, null, "Практические занятия", null, null, null, "КТ1", "КТ2", null, "Варианты"],
    [null, `Группа «${group}»`, null, null, null, "Дата занятия", { date: "2026-09-10" }, { date: "2026-09-24" }, "08.10.2026", "22.10.2026", { date: "2026-09-10" }, { date: "2026-09-24" }, { date: "2026-10-08" }, { date: "2026-10-22" }, "08.09.2026", "22.09.2026", "06.10.2026", "20.10.2026", null, null, null, null],
    [null, "№", "Номер", "Фамилия", "Имя", "Отчество", "Л 1", "Л 2", "Л 3", "Л 4", "Лаб 1", "Лаб 2", "Лаб 3", "Лаб 4", "П 1", "П 2", "П 3", "П 4", null, null, null, null],
    [null, null, null, null, null, null, 2, 2, 2, 2, 3, 3, 0, 3, 3, 3, 3, 3, 30, 41, 100, null],
  ];
  const merge = ["G1:J1", "K1:N1", "O1:R1", "B1:E1", "B2:E2"];
  const row = (n, f, i, o, cells, r) => [null, n, 2400000 + n, f, i, o, ...cells, { formula: `=SUM(G${r}:T${r})` }, n];
  const ws1 = { title: "ГР-24_ПО_1", merge, rows: [...head("ГР-24-ПО-2"), // заголовок листа скопирован с ошибкой — главнее имя листа
    row(1, "Морозов", "Пётр", "Сергеевич", [2, 2, 1, null, 3, 3, null, null, 3, 3, 3, null, 25, null], 5), // однофамилец-тёзка, другое отчество
    row(2, "Белова", "Анна", "Ивановна", [1, null, 2, null, 2, null, null, null, 3, 3, 3, null, null, null], 6)] };
  const ws2 = { title: "ГР-24_ПО_2", merge, rows: [...head("ГР-24-ПО-2"),
    row(1, "Абрамов", "Олег", "Петрович", [2, 2, 2, null, 3, 3, null, null, 3, 3, 3, null, 30, null], 5),
    row(2, "Морозов", "Пётр", "Ильич", [1.5, 1, "Н", null, 1.5, "+", null, null, 2, "Н", 3, null, null, null], 6),
    row(3, "Яковлева", "Мария", null, [2, 2, 2, null, 3, 3, null, null, 3, 3, 3, null, null, null], 7)] };
  const book = dump(makeXlsx([ws1, ws2]));
  const r = sheets.sheetRecord(book, ME, { group: "ГР-24-ПО-2", fileName: "Журнал посещаемости_ГР-24-ПО-1-3.xlsx", title: "Журнал", modified: MOD });
  check("журнал: своя строка — на листе своей группы, по ФИО с отчеством (тёзка с другим отчеством на другом листе — не я)",
    r.status === "ok" && r.sheet === "ГР-24_ПО_2" && r.match === "fio" && r.groupRel === "same", JSON.stringify({ s: r.status, sheet: r.sheet, m: r.match, g: r.groupRel }));
  // Итог — формула без сохранённого значения: сумма своей строки G..T = 1,5+1+1,5+2+3 = 9.
  check("журнал: итог =SUM(…) без сохранённого значения — сумма своей строки; шкала из строки максимумов",
    r.have === 9 && r.scale === 100 && r.haveFrom === "total" && r.confidence === "high", JSON.stringify({ have: r.have, scale: r.scale, from: r.haveFrom, c: r.confidence }));
  // Впереди (после 14 окт): Л4 2, Лаб4 3, П4 3, КТ1 30, КТ2 41 = 79; «+» на Лаб 2 (был, баллов ещё нет) — 3; Лаб 3 отменена (максимум 0).
  check("журнал: можно ещё набрать — будущие занятия, КТ без даты и «+» (был, баллов нет); «Н» и отменённое — нет",
    r.left === 82 && r.pending === 1 && r.ahead === 5, JSON.stringify({ left: r.left, pending: r.pending, ahead: r.ahead, lost: r.lost }));
  const parts = Object.fromEntries(r.parts.map((p) => [p.kind, `${p.have}/${p.max}`]));
  check("журнал: по частям — лекции, лабораторные (без отменённой), практические, контрольные",
    parts.lecture === "2.5/8" && parts.lab === "1.5/9" && parts.practice === "5/12" && parts.control === "0/71", JSON.stringify(parts));
  const a = r.attendance;
  check("журнал: посещения — число или «+» был, «Н» пропуск, отменённая лаба и будущие не в счёт",
    a && a.present === 6 && a.absent === 2 && a.percent === 75 && a.absences.length === 2 && a.absences.some((x) => x.kind === "practice" && x.date === "2026-09-22"), JSON.stringify(a));
  const r2 = sheets.sheetRecord(book, { fullname: "Морозов Пётр", firstname: "Пётр", lastname: "Морозов" }, { group: "ГР-24-ПО-1", modified: MOD });
  check("журнал: без отчества в Moodle и группа ПО-1 — строка тёзки на листе ПО-1 (своя группа), а не ПО-2", r2.status === "ok" && r2.sheet === "ГР-24_ПО_1" && r2.have === 25 + 2 + 2 + 1 + 3 + 3 + 3 + 3 + 3, JSON.stringify({ s: r2.status, sheet: r2.sheet, have: r2.have }));
  const r3 = sheets.sheetRecord(book, { fullname: "Морозов Пётр", firstname: "Пётр", lastname: "Морозов" }, { group: "ГР-24-ПО-3", modified: MOD });
  check("журнал: без отчества и своей группы в книге нет — двое тёзок в чужих группах, не гадаем", r3.status === "not_found", r3.status);
  const r4 = sheets.sheetRecord(book, ME, { group: "ГР-24-ПО-3", modified: MOD });
  check("журнал: перевёлся (группа другая), но ФИО с отчеством совпало — берём, с пометкой «чужой лист»", r4.status === "ok" && r4.groupRel === "other" && r4.sheet === "ГР-24_ПО_2", JSON.stringify({ s: r4.status, g: r4.groupRel }));
  const sv = adm.sheetScoreView({ ...r, src: { kind: "moodle", title: "Журнал", file: "Журнал.xlsx", url: "https://x/mod/resource/view.php?id=1", modified: MOD } }, { ej: { 3: 55, 4: 70, 5: 85 } });
  check("сессия: пороги журнала (55/70/85 %) на шкалу 100 — не хватает 46 / 61 / 76, всё достижимо (9 + 82 = 91)",
    sv.source === "sheet" && sv.targets.map((t) => t.need).join("/") === "46/61/76" && sv.targets.every((t) => t.reachable) && sv.max === 91 && sv.thresholdsFrom === "journal", JSON.stringify(sv.targets));
  check("сессия: части подписаны по-русски, ссылка на элемент курса", sv.parts.map((p) => p.name).join(",") === "Лекции,Лабораторные,Практические,Контрольные" && sv.sheet.url.includes("view.php"), JSON.stringify(sv.parts));
}

// ---------- 2. Однофамильцы-тёзки на одном листе; инициалы; латинская буква в фамилии; скрытый лист ----------
{
  const rows = [["ФИО", "Группа", "ЛР1", "ЛР2", "Итого"], [null, null, 10, 10, 20],
    ["Морозов Пётр Ильич", "ГР-24-ПО-2", 5, 6, 11], ["Морозов Пётр Ильич", "ГР-24-ПО-2", 9, 9, 18], ["Иванова Анна", "ГР-24-ПО-2", 1, 1, 2]];
  const r = sheets.sheetRecord(dump(makeXlsx([{ title: "Лист1", rows }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("две строки с тем же ФИО в одном листе — ambiguous, баллы не берём", r.status === "ambiguous", r.status);
  const iniRows = [["Студент", "ЛР1", "ЛР2", "Сумма"], [null, 10, 10, 20], ["Kозлов П.И.", 1, 1, 2], ["Мoрозов П. И.", 7, 8, 15], ["Белова А.Н.", 3, 3, 6]];
  const ini = sheets.sheetRecord(dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: iniRows }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("«Мoрозов П. И.» (латинская «o», инициалы с пробелом) на листе своей группы — нашёлся по инициалам, 15 из 20", ini.status === "ok" && ini.match === "initials" && ini.have === 15 && ini.scale === 20, JSON.stringify({ s: ini.status, m: ini.match, have: ini.have, scale: ini.scale }));
  const ini2 = sheets.sheetRecord(dump(makeXlsx([{ title: "Лист1", rows: iniRows }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("те же инициалы в списке без группы — не берём (это может быть однофамилец)", ini2.status === "not_found", ini2.status);
  const hid = sheets.sheetRecord(dump(makeXlsx([
    { title: "старое", hidden: true, rows: [["ФИО", "Итого"], ["Морозов Пётр Ильич", 99]] },
    { title: "ГР-24-ПО-2", rows: [["ФИО", "ЛР1", "Итого"], [null, 10, 10], ["Морозов Пётр Ильич", 4, 4], ["Белова Анна Ивановна", 5, 5]] }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("скрытый лист со своей строкой — только если на видимых её нет", hid.status === "ok" && hid.sheet === "ГР-24-ПО-2" && hid.have === 4, JSON.stringify({ sheet: hid.sheet, have: hid.have }));
}

// ---------- 3. Итоги: все группы на одном листе, ФИО в одной ячейке, столбец «Группа», оценка ----------
{
  const rows = [["ФИО", "ИНСТИТУТ", "ГРУППА", "баллы за семестр", "баллы за олимпиады", "баллы за экзамен", "итоговые баллы", "оценка"],
    ["Морозов Пётр Ильич", "ИТКН", "ГР-24-ПО-1", 20, null, 30, 50, 3],
    ["Морозов Пётр Ильич", "ИТКН", "ГР-24-ПО-2", 31, 5, 36, 72, 4],
    ["Белова Анна Ивановна", "ИТКН", "ГР-24-ПО-2", 12, null, null, 12, "н/я"]];
  const r = sheets.sheetRecord(dump(makeXlsx([{ title: "Лист1", rows }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("итоги: тёзка в другой группе того же листа — своя строка по столбцу «Группа»", r.status === "ok" && r.groupRel === "same" && r.have === 72, JSON.stringify({ s: r.status, g: r.groupRel, have: r.have }));
  check("итоги: максимума нет — уверенность low, оценка из таблицы 4", r.confidence === "low" && r.scale == null && r.grade?.value === 4, JSON.stringify({ c: r.confidence, grade: r.grade }));
  const sv = adm.sheetScoreView({ ...r, src: { kind: "moodle", title: "Результаты", file: "ИТОГИ.xlsx", url: null, modified: MOD } }, { ej: { 3: 55, 4: 70, 5: 85 } });
  check("сессия: без максимума — без полосы и «не хватает», пороги текстом, оценка из таблицы", sv.scale == null && !sv.targets.length && /3 — от 55 %/.test(sv.planBands || "") && sv.grade === 4, JSON.stringify({ bands: sv.planBands, grade: sv.grade }));
}

// ---------- 4. Посещения «+ / Н» с подсчётом преподавателя; столбцы баллов за посещения ----------
{
  const L = ["Л 1", "Л 2", "Л 3", "Л 4"], P = ["П 1", "П 2", "П 3", "П 4"];
  const rows = [
    ["Журнал", null, null, null, null, "Лекции", null, null, null, "Пропусков лекций, ак.ч.", "Практические занятия", null, null, null, "Пропусков занятий, ак.ч.", null, null, null, null, null, null, null],
    ["Группа «ГР-24-2»", null, null, null, "Дата занятия", "13.02", "20.02", "27.02", "06.03", null, "13.02", "13.02", "27.02", "27.02", null, "количество посещений", "количество пропусков", "процент посещения", "баллы за посещения (18 - максимум)", "доп. баллы", "баллы за вовремя сданные практические работы", "Итого - баллы за активное посещение"],
    ["№", "Номер", "Фамилия", "Имя", "Отчество", ...L, null, ...P, null, null, null, null, null, null, null, null],
    [1, 11, "Морозов", "Пётр", "Ильич", "+", "Н", "+", "Б", 2, "+", "+", "Н", "+", 2, 5, 2, 71.4, 13, null, 12, 25],
    [2, 12, "Белова", "Анна", "Ивановна", "+", "+", "+", "+", 0, "+", "+", "+", "+", 0, 8, 0, 100, 18, 2, 12, 32],
  ];
  const r = sheets.sheetRecord(dump(makeXlsx([{ title: "Sheet1", rows, merge: ["F1:I1", "K1:N1"] }])), ME, { group: "ГР-24-ПО-2", fileName: "ГР-24-2_расчет_баллов.xlsx", modified: Date.parse("2026-06-07T12:00:00Z") });
  const a = r.attendance;
  check("посещения: даты без года (13.02) — год по файлу; «Б» — по уважительной; процент — как у преподавателя",
    r.status === "ok" && a && a.present === 5 && a.absent === 2 && a.excused === 1 && a.percent === 71.4 && a.fromTeacher && a.missedHours === 4 && a.absences.every((x) => x.date?.startsWith("2026-0")), JSON.stringify(a));
  check("посещения: «баллы за вовремя сданные практические» — баллы, а не занятие; итог — «Итого…» без максимума (low)",
    r.have === 25 && r.confidence === "low" && /Итого/.test(r.total?.label || "") && a.past === 8, JSON.stringify({ have: r.have, c: r.confidence, label: r.total?.label, past: a.past }));
}

// ---------- 5. Не ведомость: варианты заданий; рейтинг-план в Excel; CSV ----------
{
  const v = sheets.sheetRecord(dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "Модель", "Район"], [1, "Белова Анна Ивановна", "Модель Басса", "Арбат"], [2, "Морозов Пётр Ильич", "Модель Мальтуса", "Хамовники"]] }])), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("варианты заданий (строка есть, баллов и посещений нет) — no_data", v.status === "no_data", v.status);
  const plan = dump(makeXlsx([{ title: "БРС", rows: [[null, null, null, null, null, "Итоговая оценка"], ["Наименование", "Кол.", "Балл, max", "Сумма", "90-100", "Отлично"], ["Лаб. работы", 6, 4, 24, "75-89.99", "Хорошо"], ["Практ. работы", 6, 3, 18, "60-74.99", "Удовл."], ["КР", 1, 15, 15, "<60", "Неуд."], [null, null, null, 100]] }]));
  const p = mplan.parsePlan(sheets.planText(plan));
  check("рейтинг-план в Excel: «Удовл.», «Неуд.» — шкала 60/75/90 из 100", p.status === "ok" && `${p.thresholds[3]}/${p.thresholds[4]}/${p.thresholds[5]}` === "60/75/90" && p.max === 100, JSON.stringify(p.thresholds));
  const csv = join(TMP, "j.csv");
  writeFileSync(csv, "\uFEFFФИО;ЛР1;ЛР2;Итого\n;10;10;20\nМорозов Пётр Ильич;7,5;8;15,5\nБелова Анна Ивановна;1;1;2\n", "utf8");
  const c = sheets.sheetRecord(dump(csv), ME, { group: "ГР-24-ПО-2", modified: MOD });
  check("CSV через «;», дробные с запятой — 15,5 из 20", c.status === "ok" && c.have === 15.5 && c.scale === 20 && c.confidence === "high", JSON.stringify({ s: c.status, have: c.have, scale: c.scale }));
  const bad = join(TMP, "bad.xlsx");
  writeFileSync(bad, "<html>login</html>");
  check("не таблица (страница входа вместо xlsx) — sheet_xls.py отвечает ошибкой, не падает", !!dump(bad).error && !cs.looksLike(Buffer.from("<html>"), "xlsx") && cs.looksLike(Buffer.from([0x50, 0x4b, 3, 4]), "xlsx"));
}

// ---------- 6. Мелочи разбора ----------
{
  check("dateOf: «Лаб 1.2» — не дата; число 1,5 (максимум) — не дата, а строка «1.5» — 1 мая", sheets.dateOf("Лаб 1.2", MOD) === null && sheets.dateOf(1.5, MOD) === null && sheets.dateOf("31.02", MOD) === null);
  check("dateOf: «10.09» → 2026-09-10; «15.01» в октябрьском файле → январь 2027 (экзамен впереди); «15.06» в февральском → июнь того же года; serial — только в строке дат",
    sheets.dateOf("10.09", MOD) === "2026-09-10" && sheets.dateOf("15.01", MOD) === "2027-01-15" && sheets.dateOf("15.06", Date.parse("2026-02-05T00:00:00Z")) === "2026-06-15" && sheets.dateOf(46000, MOD) === null && sheets.dateOf(46000, MOD, { allowSerial: true }) === "2025-12-09",
    `${sheets.dateOf("15.01", MOD)} ${sheets.dateOf("15.06", Date.parse("2026-02-05T00:00:00Z"))}`);
  check("sumCols: =SUM(G17:AJ17) своей строки — 30 столбцов; чужая строка — пусто; =A1+B1+C1", sheets.sumCols("=SUM(G17:AJ17)", 16).size === 30 && sheets.sumCols("=SUM(G18:AJ18)", 16).size === 0 && sheets.sumCols("=A3+B3+C3", 2).size === 3);
  check("groupCodes: «ГР-24_ПО_2» — код; «ПО-1-3» (диапазон) — только поток «ГР-24»; «ЛР-01» — нет", sheets.groupCodes("ГР-24_ПО_2").join() === "ГР-24-ПО-2" && sheets.groupCodes("Журнал_ГР-24-ПО-1-3").join() === "ГР-24" && sheets.groupCodes("ГР-24-2_расчет").join() === "ГР-24-2" && sheets.groupCodes("ЛР-01").length === 0, JSON.stringify(sheets.groupCodes("Журнал_ГР-24-ПО-1-3")));
  check("groupRel: поток «ГР-24» — своя для «ГР-24-ПО-2»; «ГР-24-2» — чужая", sheets.groupRel("ГР-24", "ГР-24-ПО-2") === "same" && sheets.groupRel("ГР-24-2", "ГР-24-ПО-2") === "other" && sheets.groupRel(null, "ГР-24-ПО-2") === "unknown");
  check("stateOf: «+», «Н», «нб», «Б», «1,5», пусто", ["+", "Н", "нб", "Б", "1,5", null].map(sheets.stateOf).join() === "plus,absent,absent,excused,num,empty");
}

// ---------- 6а. Случаи из независимой проверки 16 окт: каждый раньше давал чужие или выдуманные цифры ----------
{
  const G = { group: "ГР-24-ПО-2", modified: MOD };
  // Процент посещения в ячейке «0 %» хранится долей.
  const pctBook = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "01.09", "08.09", "15.09", "22.09", "количество посещений", "процент посещения"],
    [1, "Морозов Пётр Ильич", "+", "Н", "+", "+", 3, 0.75], [2, "Белова Анна Ивановна", "+", "+", "+", "+", 4, 1]] }]));
  const pa = sheets.sheetRecord(pctBook, ME, G).attendance;
  check("процент преподавателя долей (0,75) → 75 %", pa?.percent === 75 && pa.fromTeacher, JSON.stringify(pa));
  // Заголовок, объединённый на всю ширину, — не подпись столбцов.
  const wide = dump(makeXlsx([{ title: "Лист1", merge: ["A1:H1", "A2:H2"], rows: [["Рейтинг студентов по дисциплине «Физика»"], ["Группа ГР-24-ПО-2"],
    ["№", "ФИО", "Л 1", "Л 2", "Лаб 1", "КТ1", "КТ2", null], [null, null, 2, 2, 6, 40, 50, 100],
    [1, "Морозов Пётр Ильич", 2, "Н", 5, null, null, 7], [2, "Белова Анна Ивановна", 2, 2, 6, 30, null, 40]] }]));
  const w = sheets.sheetRecord(wide, ME, G);
  check("объединённый на всю ширину заголовок («Рейтинг…», «Группа…») не делает все столбцы итогом/служебными", w.status === "ok" && w.have === 7 && w.scale === 100 && w.parts.some((p) => p.kind === "control" && p.max === 90), JSON.stringify({ s: w.status, have: w.have, scale: w.scale, parts: w.parts }));
  // Фамилии КАПСОМ: соседние строки не принимаются за шапку и максимумы.
  const caps = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "ЛР1", "ЛР2", "ЛР3", "КР", "Итого"], [null, null, 10, 10, 10, 20, 50],
    [1, "АБРАМОВ ОЛЕГ ПЕТРОВИЧ", 7, 9, "Н", 15, 31], [2, "БЕЛОВА АННА ИВАНОВНА", 6, 8, 9, 18, 41], [3, "МОРОЗОВ ПЁТР ИЛЬИЧ", 5, null, null, null, 5]] }]));
  const cp = sheets.sheetRecord(caps, ME, G);
  check("ФИО КАПСОМ: шкала из строки максимумов (50), а не из строки соседа", cp.status === "ok" && cp.have === 5 && cp.scale === 50 && cp.confidence === "high", JSON.stringify({ s: cp.status, have: cp.have, scale: cp.scale, c: cp.confidence }));
  // «КТ 15.10», «Пн 15.09» — подписи, а не коды групп.
  check("groupCodes: «КТ 15.10», «Пн 15.09», «Лекция 16» — не группы", ["КТ 15.10", "Пн 15.09", "Лекция 16", "Лаб 20"].every((x) => sheets.groupCodes(x).length === 0));
  const kt = dump(makeXlsx([{ title: "Баллы", rows: [["№", "ФИО", "ЛР 1", "ЛР 2", "КТ 15.10", "Итого"], [null, null, 10, 10, 20, 40], [1, "Морозов Пётр Ильич", 8, 9, null, 17], [2, "Белова Анна", 5, 5, 5, 15]] }]));
  check("подпись «КТ 15.10» не делает свою строку «чужой группой»", sheets.sheetRecord(kt, ME, G).status === "ok");
  // Оценки за ЛР без дат и отметок — не посещаемость.
  const grades = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["ФИО", "ЛР1", "ЛР2", "ЛР3", "ЛР4", "КР", "Итого"], [null, 6, 6, 6, 6, 26, 50], ["Морозов Пётр Ильич", 0, 0, 0, 6, null, 6], ["Белова Анна Ивановна", 6, 6, 6, 6, 20, 44]] }]));
  const gr = sheets.sheetRecord(grades, ME, G);
  check("таблица оценок «ЛР1…ЛР4» без дат и «+/Н» — посещаемости нет (раньше было «100 %»)", gr.status === "ok" && gr.attendance === null && gr.have === 6, JSON.stringify({ att: gr.attendance, have: gr.have }));
  // Посещения единицами: 0 — пропуск.
  const bin = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["ФИО", "01.09", "08.09", "15.09", "22.09", "29.09"], ["Морозов Пётр Ильич", 1, 0, 0, 0, 1], ["Белова Анна Ивановна", 1, 1, 1, 1, 1], ["Яковлева Мария", 1, 0, 1, 1, 1]] }]));
  const bn = sheets.sheetRecord(bin, ME, G);
  check("посещения 1/0 по датам: 2 из 5 — 40 %, и это не баллы", bn.status === "ok" && bn.attendance?.percent === 40 && bn.attendance.absent === 3 && bn.have == null, JSON.stringify({ att: bn.attendance, have: bn.have }));
  // «Фамилия | Имя | Н…» — третья ячейка не отчество.
  const fi = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "Фамилия", "Имя", "Л 1", "Л 2", "Л 3", "Л 4"], [1, "Морозов", "Пётр", "Н", "+", "+", "Н"], [2, "Белова", "Анна", "+", "+", "+", "+"]] }]));
  const fr = sheets.sheetRecord(fi, ME, G);
  check("«Фамилия | Имя | Н» — «Н» не отчество, своя строка найдена (2 из 4)", fr.status === "ok" && fr.match === "name" && fr.attendance?.present === 2, JSON.stringify({ s: fr.status, m: fr.match, att: fr.attendance }));
  // Тёзки без отчества на листах ПО-1 и ПО-2 файла потока.
  const twins = dump(makeXlsx([
    { title: "ПО-1", rows: [["ФИО", "ЛР1", "Итого"], [null, 10, 10], ["Морозов Пётр", 10, 10], ["Белова Анна", 9, 9]] },
    { title: "ПО-2", rows: [["ФИО", "ЛР1", "Итого"], [null, 10, 10], ["Морозов Пётр", 2, 2], ["Яковлева Мария", 9, 9]] }]));
  const tw = sheets.sheetRecord(twins, ME, { ...G, fileName: "Журнал_ГР-24-ПО-1-3.xlsx" });
  check("листы «ПО-1»/«ПО-2» в файле потока ГР-24 — своя строка на листе ПО-2 (группа из листа и файла)", tw.status === "ok" && tw.sheet === "ПО-2" && tw.have === 2, JSON.stringify({ s: tw.status, sheet: tw.sheet, have: tw.have }));
  const tw2 = sheets.sheetRecord(twins, ME, { ...G, fileName: "Журнал.xlsx" });
  check("те же листы без кода потока в имени файла — тёзки на двух листах: не гадаем", tw2.status === "ambiguous", tw2.status);
  // «Имя Отчество Фамилия» с другим отчеством — не я.
  check("«Пётр Сергеевич Морозов» — другое отчество, не я; «Пётр Ильич Морозов» — я", sheets.matchAt(["Пётр Сергеевич Морозов"], 0, sheets.nameParts(ME)).s === 0 && sheets.matchAt(["Пётр Ильич Морозов"], 0, sheets.nameParts(ME)).s === 3);
  // «ФИО студента» в шапке, «Максимальный балл» в строке максимумов.
  const hdr = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО студента", "ЛР1", "ЛР2", "Итог", "Оценка"], [null, "Максимальный балл", 20, 20, 40, null], [1, "Морозов Пётр Ильич", 6, 8, 14, 3], [2, "Белова Анна Ивановна", 20, 18, 38, 5]] }]));
  const hd = sheets.sheetRecord(hdr, ME, G);
  check("«ФИО студента» — шапка, «Максимальный балл» — строка максимумов: 14 из 40, оценка 3", hd.status === "ok" && hd.have === 14 && hd.scale === 40 && hd.grade?.value === 3, JSON.stringify({ have: hd.have, scale: hd.scale, grade: hd.grade }));
  // Часы пропусков — не баллы.
  const hrs = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["ФИО", "01.09", "08.09", "15.09", "Пропущено часов"], ["Морозов Пётр Ильич", "+", "Н", "Н", 4], ["Белова Анна Ивановна", "+", "+", "+", 0]] }]));
  const hr = sheets.sheetRecord(hrs, ME, G);
  check("«Пропущено часов» — часы пропусков, не баллы", hr.status === "ok" && hr.have == null && hr.attendance?.missedHours === 4, JSON.stringify({ have: hr.have, att: hr.attendance }));
  // У части работ максимума нет — шкала по сумме известных ненадёжна.
  const part = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["ФИО", "ЛР1", "ЛР2", "ЛР3", "Тест", "Итого"], [null, 10, 10, 10, null, null], ["Морозов Пётр Ильич", 9, 9, 8, 12, 38], ["Белова Анна Ивановна", 5, 5, 5, 5, 20]] }]));
  const pr = sheets.sheetRecord(part, ME, G);
  check("максимум у «Теста» не указан, итог 38 больше суммы максимумов 30 — уверенность low, без порогов", pr.status === "ok" && pr.confidence === "low" && !!pr.note, JSON.stringify({ c: pr.confidence, have: pr.have, scale: pr.scale, note: pr.note }));
  // CSV: «22.10» в шапке — дата, а не 22,1.
  const csv2 = join(TMP, "dates.csv");
  writeFileSync(csv2, "ФИО;08.10;22.10;05.11\nМорозов Пётр Ильич;+;Н;\nБелова Анна Ивановна;+;+;\n", "utf8");
  const cd = sheets.sheetRecord(dump(csv2), ME, G);
  check("CSV: «22.10» — дата (до обновления файла — прошла), «05.11» — впереди", cd.attendance?.past === 2 && cd.attendance.absent === 1, JSON.stringify(cd.attendance));
}

// ---------- 6б. Повторная проверка 16 окт: случаи, которые давали чужие или выдуманные цифры уже после исправлений ----------
{
  const G = { group: "ГР-24-ПО-2", modified: MOD };
  // «Лист1» в файле потока — не группа «ЛИСТ-1».
  const l1 = dump(makeXlsx([{ title: "Лист1", rows: [["ФИО", "Группа", "ЛР1", "ЛР2", "Итого"], [null, null, 10, 10, 20], ["Морозов П.И.", "ГР-24-ПО-2", 7, 8, 15], ["Белова А.Н.", "ГР-24-ПО-1", 3, 3, 6]] }]));
  const r1 = sheets.sheetRecord(l1, ME, { ...G, fileName: "Баллы_ГР-24-ПО-1-3.xlsx" });
  check("лист «Лист1» в файле потока: группа — из своей ячейки «ГР-24-ПО-2», строка найдена (15 из 20)", r1.status === "ok" && r1.groupRel === "same" && r1.have === 15, JSON.stringify({ s: r1.status, g: r1.groupRel }));
  // Соседи «Шмидт Макс», «Баллов Иван», имя из 6 слов — студенты, а не строка максимумов.
  const nb = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "ЛР1", "ЛР2", "ЛР3", "КР", "Итого"], [null, null, 10, 10, 10, 20, 50],
    [1, "Абрамов Олег Петрович", 7, 9, 8, 15, 39], [2, "Шмидт Макс", 6, 8, 9, 18, 41], [3, "Баллов Иван Сергеевич", 5, 5, 5, 5, 20],
    [4, "Мохамед Ахмед Мохамед Абдельазиз Мохамед Али", 1, 1, 1, 1, 4], [5, "Морозов Пётр Ильич", 5, 4, null, null, 9]] }]));
  const r2 = sheets.sheetRecord(nb, ME, G);
  check("соседи «Шмидт Макс», «Баллов Иван», имя из 6 слов — студенты: шкала 50 из строки максимумов", r2.status === "ok" && r2.have === 9 && r2.scale === 50 && r2.confidence === "high", JSON.stringify({ have: r2.have, scale: r2.scale }));
  // «Норма» / «Мах» в столбце ФИО — подпись строки максимумов.
  const norma = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "ЛР1", "ЛР2", "Итого"], [null, "Норма", 10, 10, 20], [1, "Белова Анна Ивановна", 9, 9, 18], [2, "Морозов Пётр Ильич", 4, 5, 9]] }]));
  const rn = sheets.sheetRecord(norma, ME, G);
  check("«Норма» в столбце ФИО — строка максимумов, не студент (9 из 20)", rn.have === 9 && rn.scale === 20 && rn.confidence === "high", JSON.stringify({ have: rn.have, scale: rn.scale, c: rn.confidence }));
  // Сроки сдачи в подписи и редкое «Н» — не посещения.
  const dl = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["ФИО", "ЛР1 (до 15.09)", "ЛР2 (до 29.09)", "ЛР3 (до 13.10)", "ЛР4 (до 27.10)", "Итого"], [null, 10, 10, 10, 10, 40],
    ["Морозов Пётр Ильич", 4, 6, 8, null, 18], ["Белова Анна Ивановна", "Н", 10, 9, null, 19], ["Яковлева Мария", 10, 7, null, null, 17]] }]));
  const rd = sheets.sheetRecord(dl, ME, G);
  check("«ЛР1 (до 15.09)» — срок сдачи, а не занятие; редкое «Н» в оценках — не посещаемость", rd.status === "ok" && rd.attendance === null && rd.have === 18 && rd.ahead === 1, JSON.stringify({ att: rd.attendance, have: rd.have, ahead: rd.ahead }));
  // Узкая таблица: «Лекции» над 4 столбцами из 5 — подпись группы, а не заголовок.
  const nar = dump(makeXlsx([{ title: "ГР-24-ПО-2", merge: ["C1:F1"], rows: [["№", "ФИО", "Лекции", null, null, null, "Итого"], [null, "Дата", "01.09.2026", "08.09.2026", "15.09.2026", "22.09.2026", null],
    [null, null, 2, 2, 2, 2, 8], [1, "Морозов Пётр Ильич", 2, null, 2, null, { formula: "=SUM(C4:F4)" }], [2, "Белова Анна Ивановна", 2, 2, 2, 2, { formula: "=SUM(C5:F5)" }]] }]));
  const rr = sheets.sheetRecord(nar, ME, G);
  check("узкая таблица: «Лекции» над частью столбцов — лекции; пропущенные прошлые лекции потеряны, не «впереди»", rr.status === "ok" && rr.parts?.[0]?.kind === "lecture" && rr.left === 0 && rr.have === 4, JSON.stringify({ parts: rr.parts, left: rr.left, have: rr.have }));
  // Инициал отчества — не полное ФИО: тёзку из чужой группы не берём.
  const ini = dump(makeXlsx([{ title: "ГР-24-ПО-1", rows: [["ФИО", "ЛР1", "Итого"], [null, 10, 10], ["Морозов Пётр И.", 9, 9], ["Белова Анна", 5, 5]] }]));
  check("«Морозов Пётр И.» на листе чужой группы — не «полное ФИО», не берём", sheets.sheetRecord(ini, ME, { group: "ГР-24-ПО-3", modified: MOD }).status === "not_found");
  // Своя основа группы, которой нет в расписании, принимается.
  check("groupCodes: своя основа «МПИ» принимается и без расписания", sheets.groupCodes("МПИ-25-1", "МПИ-25-1").join() === "МПИ-25-1");
  // CSV с двумя датами в шапке — не строка максимумов.
  const c2 = join(TMP, "two-dates.csv");
  writeFileSync(c2, "ФИО;08.10;22.10;Итого\nМорозов Пётр Ильич;5;6;11\nБелова Анна Ивановна;3;4;7\n", "utf8");
  const rc = sheets.sheetRecord(dump(c2), ME, G);
  check("CSV «ФИО;08.10;22.10;Итого» — шапка с датами, не максимумы: итог 11 по столбцу «Итого», без выдуманной шкалы", rc.status === "ok" && rc.have === 11 && rc.haveFrom === "total" && rc.scale == null, JSON.stringify({ have: rc.have, from: rc.haveFrom, scale: rc.scale }));
  // Группы друг под другом: «Средний балл» между ними — не максимумы.
  const stk = dump(makeXlsx([{ title: "Ведомость", rows: [["№", "ФИО", "ЛР1", "ЛР2", "ЛР3", "КР", "Итого"], [null, "Макс. балл", 10, 10, 10, 20, 50],
    [null, "Группа ГР-24-ПО-1", null, null, null, null, null], [1, "Абрамов Олег Петрович", 7, 9, 8, 15, 39], [2, "Белова Анна Ивановна", 6, 8, 9, 18, 41], [null, "Средний балл", 6.5, 8.5, 8.5, 16.5, 40],
    [null, "Группа ГР-24-ПО-2", null, null, null, null, null], [1, "Морозов Пётр Ильич", 5, 4, null, null, 9], [2, "Яковлева Мария Олеговна", 8, 8, 8, 8, 32]] }]));
  const rs = sheets.sheetRecord(stk, ME, G);
  check("группы друг под другом: «Средний балл» — не максимумы, шкала 50 из строки «Макс. балл»", rs.status === "ok" && rs.groupRel === "same" && rs.scale === 50, JSON.stringify({ s: rs.status, g: rs.groupRel, scale: rs.scale }));
  // «Лекции» над всеми столбцами журнала одних лекций — подпись, а не заголовок.
  const lo = dump(makeXlsx([{ title: "ГР-24-ПО-2", merge: ["C1:F1"], rows: [["№", "ФИО", "Лекции", null, null, null], [null, null, "01.09.2026", "08.09.2026", "15.09.2026", "22.09.2026"], [null, null, 2, 2, 2, 2], [1, "Морозов Пётр Ильич", 2, null, 2, null], [2, "Белова Анна Ивановна", 2, 2, 2, 2]] }]));
  const rl = sheets.sheetRecord(lo, ME, G);
  check("журнал одних лекций: «Лекции» над всеми столбцами — лекции, пропущенные прошлые потеряны", rl.parts?.[0]?.kind === "lecture" && rl.left === 0, JSON.stringify({ parts: rl.parts, left: rl.left }));
  // «Посещения» с максимумом 40 — баллы за посещения (стенд ui-sim, физкультура).
  const pe = dump(makeXlsx([{ title: "Лист1", rows: [["ФИО", "Группа", "Норматив 1", "Норматив 2", "Посещения", "Итого"], [null, null, 30, 30, 40, 100],
    ["Абрамов Олег Петрович", "ГР-24-ПО-2", 25, 20, 30, 75], ["Морозов Пётр Ильич", "ГР-24-ПО-2", 18, null, 22, 40]] }]));
  const rpe = sheets.sheetRecord(pe, ME, G);
  check("«Посещения» с максимумом 40 — баллы: 40 из 100, можно ещё 30 (норматив 2), а не 70", rpe.have === 40 && rpe.scale === 100 && rpe.left === 30, JSON.stringify({ have: rpe.have, left: rpe.left, parts: rpe.parts }));
  // «Мах» кириллицей в столбце ФИО — подпись строки максимумов.
  const mah = dump(makeXlsx([{ title: "ГР-24-ПО-2", rows: [["№", "ФИО", "ЛР1", "ЛР2", "Итого"], [null, "Мах", 10, 10, 20], [1, "Белова Анна Ивановна", 9, 9, 18], [2, "Морозов Пётр Ильич", 4, 5, 9]] }]));
  check("«Мах» (кириллица) в столбце ФИО — строка максимумов", sheets.sheetRecord(mah, ME, G).scale === 20);
  // Лист «ДЗ1» в файле потока и лист «ПО1» при своей ячейке «ГР-24-ПО-2» — своя строка по ячейке группы.
  const dz = dump(makeXlsx([{ title: "ДЗ1", rows: [["ФИО", "Группа", "ДЗ", "Итого"], [null, null, 10, 10], ["Морозов П.И.", "ГР-24-ПО-2", 7, 7], ["Белова А.Н.", "ГР-24-ПО-1", 3, 3]] }]));
  check("лист «ДЗ1» в файле потока — не подгруппа: своя строка по ячейке «Группа»", sheets.sheetRecord(dz, ME, { ...G, fileName: "Баллы_ГР-24-ПО-1-3.xlsx" }).status === "ok");
  const po1 = dump(makeXlsx([{ title: "ПО1", rows: [["ФИО", "Группа", "ДЗ", "Итого"], [null, null, 10, 10], ["Морозов Пётр Ильич", "ГР-24-ПО-2", 7, 7], ["Белова Анна", "ГР-24-ПО-1", 3, 3]] }]));
  const rp = sheets.sheetRecord(po1, ME, { ...G, fileName: "Баллы_ГР-24-ПО-1-3.xlsx" });
  check("лист «ПО1», но в своей строке «ГР-24-ПО-2» — ячейка строки главнее имени листа", rp.status === "ok" && rp.groupRel === "same", JSON.stringify({ s: rp.status, g: rp.groupRel }));
}

// ---------- 7. Что считается таблицей в курсе (course-sheets.candidates, extLink) ----------
{
  const secs = [
    { name: "Журнал", modules: [
      { id: 1, modname: "resource", name: "Журнал", url: "https://m/mod/resource/view.php?id=1", contents: [{ type: "file", filename: "Журнал.xlsx", fileurl: "https://m/pluginfile.php/1/Журнал.xlsx?forcedownload=1", filesize: 32000, timemodified: 1791972074 }] },
      { id: 2, modname: "resource", name: "Скрытое", visible: 0, contents: [{ type: "file", filename: "x.xlsx", fileurl: "https://m/p/x.xlsx", filesize: 10 }] },
      { id: 3, modname: "folder", name: "Материалы", url: "https://m/mod/folder/view.php?id=3", contents: [{ type: "file", filename: "лекция.pdf", fileurl: "https://m/p/l.pdf" }, { type: "file", filename: "Баллы.xls", fileurl: "https://m/p/b.xls", filesize: 9_000_000 }] },
      { id: 4, modname: "url", name: "Баллы", url: "https://m/mod/url/view.php?id=4", contents: [{ type: "url", fileurl: "https://disk.yandex.ru/i/AbC-12" }] },
      { id: 5, modname: "assign", name: "Активность", description: '<p>Таблица: <a href="https://docs.google.com/spreadsheets/d/1xYz_-9/edit?usp=sharing&amp;x=1">ссылка</a> и <a href="https://yandex.ru/search?q=1">поиск</a></p>' },
    ] },
    { name: "Скрытый раздел", uservisible: false, modules: [{ id: 6, modname: "resource", name: "Тайное", contents: [{ type: "file", filename: "t.xlsx", fileurl: "https://m/p/t.xlsx" }] }] },
  ];
  const c = cs.candidates(77, secs, [{ course: 77, coursemodule: 9, name: "Рейтинг", content: "см. https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml" }, { course: 78, coursemodule: 10, content: "https://disk.yandex.ru/d/other" }]);
  const kinds = c.map((x) => `${x.kind}:${x.title}`).join(", ");
  check("курс: файл ресурса, xls в папке (больше 5 МБ — помечен), Яндекс из «Ссылки», Google из описания и со страницы; скрытое и чужой курс — нет",
    c.length === 5 && c.some((x) => x.kind === "moodle" && x.file === "Журнал.xlsx") && c.find((x) => x.file === "Баллы.xls")?.tooBig === true && c.filter((x) => x.kind === "google").length === 2 && c.some((x) => x.kind === "yandex") && !c.some((x) => x.title === "Скрытое" || x.title === "Тайное"), kinds);
  check("курс: похожие на ведомость («Журнал», «Баллы», «Рейтинг») — первыми", /журнал|балл|рейтинг/i.test(c[0].title), kinds);
  check("extLink: Яндекс файл и папка, Google /d/ и опубликованная, прочее — null",
    cs.extLink("https://yadi.sk/i/AbC")?.url === "https://disk.yandex.ru/i/AbC" && cs.extLink("https://disk.yandex.ru/d/Qq")?.folder === true && cs.extLink("https://docs.google.com/spreadsheets/d/1xYz_-9/edit#gid=0")?.url.endsWith("/1xYz_-9/export?format=xlsx") && cs.extLink("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml")?.url.endsWith("/pub?output=xlsx") && cs.extLink("https://docs.google.com/document/d/1/edit") === null && cs.extLink("javascript:alert(1)") === null);
}

// ---------- 8. Откуда баллы «Сессии» (admission.pickScore) ----------
{
  const sure = { source: "sheet", confidence: "high", full: true }, low = { source: "sheet", confidence: "low" }, partial = { source: "sheet", confidence: "high", full: false };
  const mv = { source: "moodle", graded: 2 }, mv0 = { source: "moodle", graded: 0 }, ej = { source: "ej" };
  check("таблица на всю дисциплину (уверенно) главнее оценок Moodle", adm.pickScore({ ejSc: ej, mv, sv: sure }) === sure);
  check("оценки Moodle главнее таблицы без максимума и таблицы на часть дисциплины", adm.pickScore({ ejSc: ej, mv, sv: low }) === mv && adm.pickScore({ ejSc: ej, mv, sv: partial }) === mv);
  const part30 = adm.sheetScoreView({ have: 15, scale: 30, left: 0, confidence: "high", whole: true, parts: [], src: {} }, { ej: { 3: 61, 4: 71, 5: 81 } });
  check("таблица «из 30» (часть дисциплины): пороги журнала не применяются — нет «не набрать», пояснение", !part30.full && !part30.targets.length && /часть дисциплины \(из 30\)/.test(part30.planNote || ""), JSON.stringify({ full: part30.full, t: part30.targets, note: part30.planNote }));
  const passPlan = adm.sheetScoreView({ have: 40, scale: 100, left: 30, confidence: "high", whole: true, parts: [], src: {} }, { plan: { status: "pass", thresholds: null, pass: 60, max: null }, pass: true });
  check("план Moodle только с проходным баллом 60 — у зачёта это порог «зачёт»: ещё 20", passPlan.targets.length === 1 && passPlan.targets[0].label === "зачёт" && passPlan.targets[0].need === 20, JSON.stringify(passPlan.targets));
  const passExam = adm.sheetScoreView({ have: 40, scale: 100, left: 30, confidence: "high", whole: true, parts: [], src: {} }, { plan: { status: "pass", thresholds: null, pass: 55, max: 100 } });
  check("у экзамена проходной балл плана — строкой (planPass), без выдуманных порогов 4 и 5", !passExam.targets.length && passExam.planPass === 55, JSON.stringify(passExam));
  const amb = adm.sheetScoreView({ have: 40, scale: 100, left: 30, confidence: "high", whole: true, parts: [], src: {} }, { plan: { status: "ambiguous", thresholds: null } });
  check("план для нескольких институтов — пояснение, а не «порогов нет»", /каждого института/.test(amb.planNote || ""), amb.planNote);
  const sixty = adm.sheetScoreView({ have: 40, scale: 60, left: 10, confidence: "high", whole: true, parts: [], src: {} }, { plan: { status: "ok", thresholds: { 3: 55, 4: 70, 5: 85 }, unit: "pts", strict: {}, max: null } });
  check("план без максимума (пороги 55/70/85) к таблице «из 60» не приписывается ни расчётом, ни строкой порогов", !sixty.targets.length && !sixty.planBands && /часть дисциплины/.test(sixty.planNote || ""), JSON.stringify({ bands: sixty.planBands, note: sixty.planNote }));
  check("таблица без максимума главнее пустого Moodle и пустого журнала", adm.pickScore({ ejSc: ej, mv: mv0, sv: low }) === low);
  check("без таблицы — как раньше: пустой Moodle уступает журналу, без журнала — Moodle", adm.pickScore({ ejSc: ej, mv: mv0 }) === ej && adm.pickScore({ ejSc: null, mv: mv0 }) === mv0 && adm.pickScore({ controls: false, sv: sure }) === null);
  const rec = { have: 40, scale: 100, left: 30, confidence: "high", whole: true, parts: [], src: {} };
  const old = adm.sheetScoreView(rec, { plan: { status: "ok", thresholds: { 3: 55, 4: 71, 5: 86 }, unit: "pts", strict: {}, max: 108 }, sheetPlan: { status: "ok", thresholds: { 3: 60, 4: 75, 5: 90 }, unit: "pts", strict: {}, max: 100 } });
  check("план Moodle «из 108» к таблице «из 100» не подходит — пороги из плана в Excel курса", old.thresholdsFrom === "sheet" && old.targets[0].at === 60, JSON.stringify({ from: old.thresholdsFrom, at: old.targets.map((t) => t.at) }));
  const pass = adm.sheetScoreView(rec, { ej: { 3: 50, 4: 70, 5: 85 }, pass: true });
  check("зачёт — один порог «зачёт», 40 из 100 при пороге 50: ещё 10, достижимо", pass.targets.length === 1 && pass.targets[0].label === "зачёт" && pass.targets[0].need === 10 && pass.targets[0].reachable === true, JSON.stringify(pass.targets));
  const none = adm.sheetScoreView(rec, {});
  check("порогов нигде нет — пояснение, без «не хватает»", !none.targets.length && /пороги оценок не нашлись/.test(none.planNote || ""), none.planNote);
}

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
