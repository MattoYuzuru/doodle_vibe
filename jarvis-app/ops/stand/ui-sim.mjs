// Стенд для просмотра интерфейса «Комментарий преподавателя / Исправить отчёт» без настоящих Moodle, Telegram и агента.
// Копия сервера приложения на 127.0.0.1:8799, поддельный Moodle на 127.0.0.1:9911, вместо OpenClaw и скрипта навыка —
// заглушки. Настоящие токены, users/, jobs/ и папки работ не затрагиваются. Останов: создать файл sim-ui/stop.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = "C:/Users/User/moodle-work/jarvis-app";
const SIM = join(HERE, "sim-ui"), FAKE = "http://127.0.0.1:9911", PORT = 8799, B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

rmSync(SIM, { recursive: true, force: true });
mkdirSync(join(SIM, "web"), { recursive: true });
const patch = { "https://newlms.misis.ru": FAKE, "https://api.telegram.org": `${FAKE}/tg`, "https://dnevuch.ru": `${FAKE}/dnevuch`, "https://campusapp.ru": `${FAKE}/campus`, "https://ej.misis.ru": `${FAKE}/ej` };
// Все модули сервера (список не ведём вручную: новые модули попадают в стенд сами).
for (const f of readdirSync(APP).filter((x) => x.endsWith(".mjs"))) {
  let src = readFileSync(join(APP, f), "utf8");
  for (const [a, b] of Object.entries(patch)) src = src.split(a).join(b);
  // Вход в журнал хранится только для *.misis.ru — на стенде поддельный журнал на 127.0.0.1, его cookies тоже оставляем.
  if (f === "ej.mjs") src = src.split(String.raw`/(^|\.)misis\.ru$/`).join(String.raw`/(^|\.)misis\.ru$|^127\.0\.0\.1$/`);
  writeFileSync(join(SIM, f), src);
}
cpSync(join(APP, "lab-instruction.md"), join(SIM, "lab-instruction.md"));
for (const f of ["lab-report-classic.md", "lab-report-kit.md"]) cpSync(join(APP, f), join(SIM, f)); // шаг «собери отчёт» — два способа
cpSync(join(APP, "assets", "styles"), join(SIM, "assets", "styles"), { recursive: true });           // профили оформления для сборки программой
for (const f of readdirSync(APP).filter((x) => x.endsWith("-instruction.md") && x !== "lab-instruction.md")) cpSync(join(APP, f), join(SIM, f));
// Постоянный адрес календаря в стенде — условный; сам туннель ngrok стенд не запускает (CAL_TUNNEL=0).
writeFileSync(join(SIM, "calendar-base.txt"), "https://cal.example.test");
cpSync(join(APP, "schedule_xls.py"), join(SIM, "schedule_xls.py"));
for (const f of ["curriculum_pdf.py", "session_xls.py", "sheet_xls.py"]) cpSync(join(APP, f), join(SIM, f)); // учебный план, расписание сессии, таблицы преподавателей («Сессия»)
// Программа измерений оформления для «Проверки своего отчёта» (сервер зовёт её из своей папки assets).
mkdirSync(join(SIM, "assets"), { recursive: true });
cpSync(join(APP, "assets", "report_check.py"), join(SIM, "assets", "report_check.py"));
writeFileSync(join(SIM, "bot-token.txt"), "123456:SIM-UI-TOKEN");
symlinkSync(join(APP, "node_modules"), join(SIM, "node_modules"), "junction");
symlinkSync(process.env.UI_DIST || join(APP, "web", "dist"), join(SIM, "web", "dist"), "junction");
const HOME = join(SIM, "home"), APPDATA = join(SIM, "appdata"), AGENT_LOG = join(SIM, "agent.log");
mkdirSync(join(APPDATA, "npm", "node_modules", "openclaw"), { recursive: true });
mkdirSync(join(HOME, ".openclaw", "skills", "moodle-student"), { recursive: true });
writeFileSync(AGENT_LOG, "");
cpSync(join(HERE, "sim-openclaw-stub.mjs"), join(APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs"));
cpSync(join(HERE, "sim-skill-stub.mjs"), join(HOME, ".openclaw", "skills", "moodle-student", "moodle.mjs"));

// ---------- поддельный Moodle: один студент, один курс ----------
const COURSE = 31, tgSent = [];
// Таблицы преподавателей (course-sheets.mjs): «Методы оптимизации» — дисциплины нет в журнале (отдельная карточка и
// баллы «Сессии»), «Физическая культура и спорт» — в журнале есть, но без оценок (баллы из таблицы в её карточке).
const SHEET_COURSES = [{ id: 32, fullname: "Методы оптимизации. Осень 2026", file: "Журнал посещаемости БИСТ-24.xlsx" }, { id: 33, fullname: "Физическая культура и спорт. Осень 2026", file: "Баллы ФК.xlsx" }];
function makeSheets() {
  const d = (n) => { const t = new Date(Date.now() + n * 86400e3); return `${String(t.getUTCDate()).padStart(2, "0")}.${String(t.getUTCMonth() + 1).padStart(2, "0")}.${t.getUTCFullYear()}`; };
  const head = [
    [null, "Журнал посещаемости", null, null, null, null, "Лекции", null, null, null, "Лабораторные работы", null, null, null, "Практические занятия", null, null, null, "КТ1", "КТ2", "КТ3", null],
    [null, "Группа «БИСТ-24-ПО-2»", null, null, null, "Дата занятия", d(-35), d(-21), d(-7), d(7), d(-35), d(-21), d(-7), d(7), d(-36), d(-22), d(-8), d(6), null, null, null, null],
    [null, "№", "Номер", "Фамилия", "Имя", "Отчество", "Л 1", "Л 2", "Л 3", "Л 4", "Лаб 1", "Лаб 2", "Лаб 3", "Лаб 4", "П 1", "П 2", "П 3", "П 4", null, null, null, null],
    [null, null, null, null, null, null, 4, 4, 4, 4, 6, 6, 6, 6, 5, 5, 5, 5, 12, 13, 15, 100]];
  const mo = [...head,
    [null, 1, 2400001, "Абрамов", "Олег", "Петрович", 4, 4, 3, null, 6, 6, 5, null, 5, 5, 5, null, null, null, null, 43],
    [null, 2, 2400002, "Студент", "Тестовый", "Стендович", 3, 2.5, "Н", null, 4.5, "+", 6, null, 5, "Н", 4, null, null, null, null, 25],
    [null, 3, 2400003, "Яковлева", "Мария", "Ильинична", 4, 4, 4, null, 6, 6, 6, null, 5, 5, 5, null, null, null, null, 45]];
  const pe = [["ФИО", "Группа", "Норматив 1", "Норматив 2", "Посещения", "Итого"], [null, null, 30, 30, 40, 100],
    ["Абрамов Олег Петрович", "БИСТ-24-ПО-2", 25, 20, 30, 75], ["Студент Тестовый Стендович", "БИСТ-24-ПО-2", 18, null, 22, 40]];
  const spec = join(SIM, "sheets-spec.json");
  writeFileSync(spec, JSON.stringify([
    { out: join(SIM, SHEET_COURSES[0].file), sheets: [{ title: "БИСТ-24_ПО_2", rows: mo, merge: ["G1:J1", "K1:N1", "O1:R1"] }] },
    { out: join(SIM, SHEET_COURSES[1].file), sheets: [{ title: "Лист1", rows: pe }] }]));
  writeFileSync(join(SIM, "make-sheets.py"), "import json, sys, openpyxl\nfor b in json.load(open(sys.argv[1], encoding='utf-8')):\n    wb = openpyxl.Workbook(); wb.remove(wb.active)\n    for sh in b['sheets']:\n        ws = wb.create_sheet(sh['title'])\n        for r in sh['rows']: ws.append(r)\n        for m in sh.get('merge', []): ws.merge_cells(m)\n    wb.save(b['out'])\n");
  const py = [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"].find((p) => p && existsSync(p)) || "python";
  const r = spawnSync(py, [join(SIM, "make-sheets.py"), spec], { encoding: "utf8", env: { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(process.env.APPDATA || "", "Python") } });
  if (r.status) console.log("ui-sim: таблицы не собрались:", (r.stderr || "").slice(-300));
}
const sub = { id: 780001, status: "submitted", canedit: true, graded: true, grade: "2.00000", files: ["Отчет ЛР3 вариант 04.pdf"],
  comment: "Балл может быть повышен при исправлении замечаний.\n1. стр. 21. Значения VU (2, 4, 8, 16) для четырёх прогонов не обоснованы.\n2. стр. 21. Загрузка CPU базы приведена числом, снимок docker stats не приложен.",
  thread: [] };
const fileBody = (name) => `сдано ${name}`;
// Ответы по остальным работам (784, 785): сначала пусто. Черновые области загрузки: itemid → имя файла.
const others = new Map(), drafts = new Map();
const stateOf = (aid) => (aid === 780 ? sub : others.get(aid) || others.set(aid, { status: "new", canedit: true, files: [] }).get(aid));
const assigns = () => [
  { id: 780, cmid: 31780, name: "ЛР3. Нагрузочное тестирование", duedate: nowS() - 6 * 86400, grade: 4, allowsubmissionsfromdate: nowS() - 30 * 86400, timemodified: nowS() - 30 * 86400,
    intro: "<p>Выполнить нагрузочное тестирование стенда и оформить отчёт.</p>", introattachments: [{ filename: "metod.txt", fileurl: `${FAKE}/pluginfile/metod.txt` }], configs: [{ name: "maxfilesubmissions", value: "1" }] },
  { id: 784, cmid: 31784, name: "ЛР4. Кэширование", duedate: nowS() + 5 * 86400, grade: 4, allowsubmissionsfromdate: nowS() - 86400, timemodified: nowS() - 86400, intro: "<p>Условие ЛР4</p>", introattachments: [], configs: [["enabled","1"],["maxfilesubmissions","2"],["maxsubmissionsizebytes","10485760"],["filetypeslist",".pdf"]].map(([name, value]) => ({ plugin: "file", subtype: "assignsubmission", name, value })), submissiondrafts: 1 },
  { id: 785, cmid: 31785, name: "ЛР5. Балансировка", duedate: nowS() + 12 * 86400, grade: 4, allowsubmissionsfromdate: nowS() - 86400, timemodified: nowS() - 86400, intro: "<p>Условие ЛР5</p>", introattachments: [], configs: [["enabled","1"],["maxfilesubmissions","1"],["maxsubmissionsizebytes","5242880"],["filetypeslist",""]].map(([name, value]) => ({ plugin: "file", subtype: "assignsubmission", name, value })), submissiondrafts: 0 },
  // SIM_MANY=1 — восемь дальних работ (группа «Позже» длиннее пяти).
  ...(process.env.SIM_MANY ? Array.from({ length: 8 }, (_, i) => ({ id: 790 + i, cmid: 31790 + i, name: [`ЛР${6 + i}. Дальняя работа ${i + 1}`, `Курсовая работа ${i + 1}`, `Зачёт ${i + 1}`, `Реферат ${i + 1}`][i % 4], duedate: nowS() + (20 + i * 6) * 86400, grade: 4, allowsubmissionsfromdate: nowS() - 86400, timemodified: nowS() - 86400, intro: "<p>Условие</p>", introattachments: [], configs: [] })) : []),
];
function ws(fn, p) {
  switch (fn) {
    case "core_webservice_get_site_info": return { userid: 1001, fullname: "Студент Тестовый Стендович", username: "u1" };
    case "core_enrol_get_users_courses": return [{ id: COURSE, fullname: "Оптимизация клиент-серверных приложений. Осень 2026", hidden: false, lastaccess: nowS() - 3600, startdate: nowS() - 30 * 86400 },
      ...SHEET_COURSES.map((c) => ({ id: c.id, fullname: c.fullname, hidden: false, lastaccess: nowS() - 3600, startdate: nowS() - 30 * 86400 }))];
    case "core_course_get_contents": {
      const sc = SHEET_COURSES.find((c) => c.id === Number(p.courseid));
      if (sc) return [{ id: 1, name: "Журнал", modules: [{ id: sc.id * 100, modname: "resource", name: "Журнал", url: `${FAKE}/mod/resource/view.php?id=${sc.id * 100}`,
        contents: [{ type: "file", filename: sc.file, filepath: "/", filesize: existsSync(join(SIM, sc.file)) ? readFileSync(join(SIM, sc.file)).length : 1000, timemodified: nowS() - 86400, fileurl: `${FAKE}/pluginfile/sheet/${encodeURIComponent(sc.file)}` }] }] }];
      const file = (name, size = 2000) => ({ type: "file", filename: name, filepath: "/", filesize: size, fileurl: `${FAKE}/pluginfile/course/${encodeURIComponent(name)}` });
      return [
        { id: 1, name: "Общее", modules: [
          { id: 900, modname: "resource", name: "Шаблон титульного листа", contents: [file("Титульный лист МИСИС.docx")] },
          { id: 901, modname: "resource", name: "Расписание консультаций", contents: [file("Консультации.pdf")] },
          { id: 902, modname: "forum", name: "Новости", contents: [] },
        ] },
        { id: 2, name: "Лабораторные работы", modules: [
          { id: 31780, modname: "assign", name: "ЛР3", contents: [] },
          { id: 31784, modname: "assign", name: "ЛР4", contents: [] },
          { id: 910, modname: "resource", name: "Методические указания к ЛР4", contents: [file("Методичка ЛР4.pdf")] },
          { id: 911, modname: "folder", name: "Примеры отчётов", contents: [file("Пример отчёта ЛР3.docx"), file("Пример отчёта ЛР4.docx")] },
          { id: 912, modname: "url", name: "Репозиторий стенда", contents: [{ type: "url", filename: "Репозиторий", fileurl: "https://git.example/stud/lr4" }] },
          { id: 913, modname: "resource", name: "Видео к ЛР4", contents: [file("Разбор ЛР4.mp4", 200 * 1024 * 1024)] },
          { id: 914, modname: "page", name: "Требования к отчёту", contents: [{ type: "file", filename: "index.html", filesize: 300, fileurl: `${FAKE}/pluginfile/course/index.html` }] },
        ] },
        { id: 3, name: "Должникам", modules: [{ id: 31785, modname: "assign", name: "ЛР5", contents: [] }, { id: 920, modname: "resource", name: "Старая методичка ЛР5", contents: [file("Методичка ЛР5.pdf")] }] },
      ];
    }
    case "mod_assign_get_assignments": return { courses: [{ id: COURSE, fullname: "Оптимизация клиент-серверных приложений. Осень 2026", assignments: assigns() }] };
    case "mod_quiz_get_quizzes_by_courses": return { quizzes: [] };
    case "mod_assign_get_submission_status": {
      if (Number(p.assignid) !== 780) {
        const st = stateOf(Number(p.assignid));
        return { lastattempt: { submission: { id: 1000 + Number(p.assignid), status: st.status, plugins: [{ type: "file", fileareas: [{ area: "submission_files", files: st.files.map((f) => ({ filename: f, filesize: 10, fileurl: `${FAKE}/pluginfile/sub/${encodeURIComponent(f)}` })) }] }] }, canedit: st.canedit, gradingstatus: "notgraded" } };
      }
      const submission = { id: sub.id, status: sub.status, plugins: [{ type: "file", fileareas: [{ area: "submission_files", files: sub.files.map((f) => ({ filename: f, filesize: Buffer.byteLength(fileBody(f)), fileurl: `${FAKE}/pluginfile/sub/${encodeURIComponent(f)}` })) }] }] };
      return { lastattempt: { submission, canedit: sub.canedit, gradingstatus: "graded" }, feedback: { grade: { grade: sub.grade }, gradeddate: sub.gradedAt ?? nowS() - 5 * 86400,
        plugins: [{ type: "comments", editorfields: [{ name: "comments", text: sub.comment.split("\n").map((l) => `<p>${l}</p>`).join("") }] }, { type: "file", fileareas: [{ files: [] }] }] } };
    }
    case "mod_assign_save_submission": {
      const st = stateOf(Number(p.assignmentid)), names = drafts.get(Number(p["plugindata[files_filemanager]"]));
      if (!st.canedit) return [{ item: "submission", message: "Вам не разрешено редактировать ответ" }];
      if (!names?.length) return [{ item: "files", message: "В черновой области нет файла" }];
      st.files = names;
      if (Number(p.assignmentid) === 785) st.status = "submitted"; else if (st.status === "new") st.status = "draft";
      return [];
    }
    case "mod_assign_submit_for_grading": { stateOf(Number(p.assignmentid)).status = "submitted"; return []; }
    case "core_comment_get_comments": return { comments: Number(p.itemid) === sub.id ? sub.thread.map((c, i) => ({ id: i + 1, content: `<div>${c.text}</div>`, fullname: c.author, userid: 9000, timecreated: c.at })) : [] };
    case "mod_quiz_get_user_best_grade": return { hasgrade: false };
    case "mod_quiz_get_user_attempts": return { attempts: [] };
    case "core_group_get_course_user_groups": return { groups: [{ name: (process.env.SIM_GROUP || "БИСТ-24-ПО-2") + "  Глобальная группа" }] };
    case "core_course_get_courses_by_field": return { courses: [{ id: COURSE, fullname: "Оптимизация клиент-серверных приложений. Осень 2026", summary: "", contacts: [{ id: 9000, fullname: "Преподаватель Тестовый" }] }] };
    case "core_user_get_course_user_profiles": return [{ id: 9000, email: "teacher@example.test", roles: [{ name: "Преподаватель" }] }];
    default: return { exception: "x", errorcode: "unknownfn", message: fn };
  }
}
// ---------- поддельный электронный журнал (ej.misis.ru): вход MISIS ID и данные семестра ----------
function flatten(value) { // devalue.stringify в миниатюре: объекты, массивы, примитивы, обещание { __p: id }
  const values = [];
  const add = (v) => {
    if (v === undefined) return -1;
    const i = values.length; values.push(null);
    if (v && typeof v === "object" && "__p" in v) values[i] = ["Promise", add(v.__p)];
    else if (Array.isArray(v)) values[i] = v.map(add);
    else if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = add(x); values[i] = o; }
    else values[i] = v;
    return i;
  };
  add(value);
  return values;
}
const STUD = 5551;
const dayIso = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10) + "T09:00:00";
const ejSubjects = [
  ["Оптимизация клиент-серверных приложений", ["Тестовый П. П."], 92.3, 58.4, 70, 85, 1],
  ["Базы данных", ["Сидорова А. В.", "Петров К. С."], 78.6, 41.2, 55, 62, 2],
  ["Иностранный язык", ["Smith J."], 100, 66.7, 80, 90, 3],
  ["Теория вероятностей и математическая статистика", ["Кузнецов Д. А."], 61.5, 22.5, 40, 45, 1],
  ["Физическая культура и спорт", [], 45, null, 30, 35, 3],
];
const ejList = ejSubjects.map(([name, t, att, rat, tr, trd], i) => ({ id: 100 + i, subject_name: name, workers: t.map((w) => ({ worker_name: w })), statistic: { attendance: att, final_rating: rat, completion_track: tr, completion_track_in_date: trd } }));
const ejJournal = (i) => {
  const [name, , att, , , , control] = ejSubjects[i];
  const n = 12, missed = Math.round(n * (1 - att / 100));
  const slots = Array.from({ length: n + 3 }, (_, k) => ({ id: 1000 * i + k, date: dayIso(-7 * (n - k) + (k % 2)), type_id: [1, 3, 2][k % 3], order_row: Math.floor(k / 3) + 1, subgroup_id: null, works: [{ name: `Тема ${k + 1}`, hours: 2, total: 2 }] }));
  const absent = new Set([1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 0].slice(0, missed));
  const marks = slots.slice(0, n).map((s, k) => ({ id: s.id, student_id: STUD, attendance_slot_id: s.id, is_present: !absent.has(k) }));
  const works = [
    { id: 1000 * i + 501, type_id: 39, order_row: 1, name: "Контрольная работа 1", date: dayIso(-40), hours: 2, scale: 10, failure: 3 },
    { id: 1000 * i + 502, type_id: 40, order_row: 1, name: "Лабораторная работа 1", date: dayIso(-30), hours: 4, scale: 5, failure: 1 },
    { id: 1000 * i + 503, type_id: 40, order_row: 2, name: "Лабораторная работа 2", date: dayIso(-10), hours: 4, scale: 5, failure: 1 },
    { id: 1000 * i + 504, type_id: 39, order_row: 2, name: "Контрольная работа 2", date: dayIso(20), hours: 2, scale: 10, failure: 3 },
  ];
  const got = [[8, 5, 4], [6, 4, null], [9, 5, 5], [3, 3, null], []][i];
  return { subject_name: name, control_form: control, control_importance: 0.5, performed_importance: 0.5, perfect_mark: 0.85, good_mark: 0.7, fine_mark: 0.5,
    my_subgroup: null, students: [{ stud_id: STUD, subgroup: null }], attendance_slots: slots, attendance_students: marks, performance_works: i === 4 ? [] : works,
    performance_students: got.map((m, k) => (m == null ? null : { id: 9000 + k, student_id: STUD, performance_work_id: works[k].id, mark: String(m) })).filter(Boolean) };
};
function ejFake(req, res, url, body) {
  const ck = req.headers.cookie || "";
  const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const go = (loc, cookie) => { res.writeHead(302, { location: loc, ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
  const p = url.pathname.slice(3); // без /ej
  if (p === "/auth/session") return json(/ejs=1/.test(ck) ? { user: { name: "Студент Тестовый" } } : {});
  // Как настоящий MISIS ID (consent-id.misis.ru, SvelteKit): формы принимаются только именованными действиями
  // (?/signin, ?/allow — formaction кнопок), POST на адрес страницы — отказ; согласие спрашивается один раз.
  const html = (code, s) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
  if (p === "/auth/signin/misis_id" && req.method === "POST") return go(`${FAKE}/ej/idp/oauth2/auth?client_id=EJ&scope=openid+profile+email`);
  if (p === "/idp/oauth2/auth") {
    if (!/idps=1/.test(ck)) return go(`${FAKE}/ej/idp/auth/signin?login_challenge=abc`);
    if (!/consent=1/.test(ck)) return go(`${FAKE}/ej/idp/auth/consent?consent_challenge=c1`);
    return go(`${FAKE}/ej/auth/callback/misis_id`);
  }
  if (p === "/idp/auth/signin" && req.method === "GET") return html(200, '<form method="POST" class="flex"><input type="hidden" name="loginChallenge" value="abc"><input value="" type="email" id="email" name="email"><input value="" type="password" id="password" name="password"><input class="checkbox" type="checkbox" id="remember" name="remember" value="1" checked><button disabled formaction="/ej/idp/auth/signin?/signin" class="btn w-full">Войти</button></form>');
  if (p === "/idp/auth/signin" && req.method === "POST") {
    if (url.search !== "?/signin") return html(400, "<p>When using named actions, the default action cannot be used.</p>");
    const f = Object.fromEntries(new URLSearchParams(body));
    if (f.loginChallenge !== "abc" || f.email !== "u1") return html(400, '<form><p class="text-error">Не передан запрос входа или почта</p></form>');
    if (f.password !== (process.env.EJ_PASS || "ok-u1")) return html(400, '<form><p class="text-error">Неверный логин или пароль</p></form>');
    return go(`${FAKE}/ej/idp/oauth2/auth?login_verifier=1`, "idps=1; Path=/; HttpOnly");
  }
  if (p === "/idp/auth/consent" && req.method === "GET") return html(200, '<form method="POST"><input type="hidden" name="consentChallenge" value="c1">' + ["openid", "profile", "email"].map((s) => `<label class="hidden" for="${s}">${s} <input type="checkbox" class="checkbox" name="grantScope" id="${s}" value="${s}"></label>`).join("") + '<label class="hidden"><input class="checkbox" type="checkbox" id="remember" name="remember" value="1"></label><button formaction="/ej/idp/auth/consent?/deny" class="btn">Отклонить</button><button formaction="/ej/idp/auth/consent?/allow" class="btn">Разрешить</button></form>');
  if (p === "/idp/auth/consent" && req.method === "POST") {
    if (url.search !== "?/allow") return html(400, "<p>When using named actions, the default action cannot be used.</p>");
    const f = new URLSearchParams(body);
    if (f.get("consentChallenge") !== "c1" || !f.getAll("grantScope").includes("openid")) return html(400, '<p class="text-error">Нет согласия на openid</p>');
    return go(`${FAKE}/ej/idp/oauth2/auth?consent_verifier=1`, "consent=1; Path=/; HttpOnly");
  }
  if (p === "/auth/callback/misis_id") return go(`${FAKE}/ej/`, "ejs=1; Path=/; HttpOnly");
  if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>журнал</html>"); }
  if (!/ejs=1/.test(ck)) return json({ message: "unauthorized" }, 401);
  if (p === "/student/__data.json") return json({ type: "redirect", location: "/student/osenniy_388" });
  if (p === "/student/osenniy_388/__data.json") { // как у настоящего журнала (2 окт): роль и семестр — в корневом узле
    const root = { session: { currentRole: { role: "student", studId: STUD, groupName: "БИСТ-24-ПО-2" } }, semester: "osenniy", academic_year_id: 388 };
    const layout = { filters: { academic_years: [{ id: 388, start_date: "2026-01-01", end_date: "2027-01-01" }], workers: [] } };
    return json({ type: "data", nodes: [{ type: "data", data: flatten(root) }, { type: "data", data: flatten(layout) }, { type: "data", data: flatten({ search: null, worker: null }) }] });
  }
  if (p === `/api/v2/student/${STUD}/journals`) return json(ejList);
  const jm = p.match(/^\/api\/v2\/student\/\d+\/journals\/(\d+)$/);
  if (jm) return json(ejJournal(Number(jm[1]) - 100));
  json({ message: "not found" }, 404);
}

let dnevuchMoved = false;
const dnevuchDay = (off) => new Date(Date.now() + 3 * 3600e3 + off * 86400e3).toISOString().slice(0, 10);
const dnevuchSlots = () => [
  [0, "09:00 - 10:35", "Оптимизация клиент-серверных приложений", "Лекционные", "ауд. Б-735", ""],
  [0, "10:50 - 12:25", "Базы данных", "Лабораторные", "ауд. Л-556", "(1)"],
  [0, "12:40 - 14:15", "Теория вероятностей и математическая статистика", "Практические", "ауд. А-308", ""],
  [0, "14:30 - 16:05", "Иностранный язык", "Практические", "ауд. Г-412", ""],
  // /sim/dnevuch-move — «перенос»: лекция по базам данных завтра уходит с 10:50 на 16:20.
  [1, dnevuchMoved ? "16:20 - 17:55" : "10:50 - 12:25", "Базы данных", "Лекционные", "ауд. Б-1", ""],
  [1, "12:40 - 14:15", "Оптимизация клиент-серверных приложений", "Лабораторные", "ауд. Л-550", "(1)"],
].map(([off, time, name, lessonType, place, subGroup]) => ({ date: dnevuchDay(off), time, classes: [{ name, lessonType, teacher: "", place, subGroup }] }));
const dnevuchPage = () => `<html><script>var groups=[{"number":"БИСТ-24-ПО-2"}];
let scheduleData = ${JSON.stringify([dnevuchSlots()])};
</script></html>`;
const fake = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, FAKE);
    const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname.startsWith("/tg/")) { try { const j = JSON.parse(body || "{}"); if (url.pathname.endsWith("/sendMessage")) tgSent.push({ chat_id: j.chat_id, text: j.text }); } catch { /* */ } return json({ ok: true, result: {} }); }
    if (url.pathname === "/sim/tg") return json(tgSent);
    if (url.pathname === "/sim/dnevuch-move") { dnevuchMoved = true; return json({ ok: true }); }
    if (url.pathname.startsWith("/ej/")) return ejFake(req, res, url, body);
    if (url.pathname.startsWith("/dnevuch")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(dnevuchPage()); }
    if (url.pathname.startsWith("/campus")) return json({ items: [] });
    if (url.pathname.startsWith("/pluginfile/sheet/")) { const f = join(SIM, decodeURIComponent(url.pathname.slice(18))); if (!existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); return res.end(readFileSync(f)); }
    if (url.pathname.startsWith("/pluginfile/course/")) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end("файл курса " + decodeURIComponent(url.pathname.slice(19))); }
    if (url.pathname === "/pluginfile/metod.txt") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end("методичка"); }
    if (url.pathname.startsWith("/pluginfile/sub/")) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(fileBody(decodeURIComponent(url.pathname.slice(16)))); }
    if (url.pathname === "/sim/submit") { const j = JSON.parse(body || "{}"); if (!sub.canedit) return json({ error: "Вам не разрешено редактировать ответ" }, 400); sub.files = [j.name]; if (j.final) sub.status = "submitted"; return json({ ok: true }); }
    if (url.pathname === "/webservice/upload.php") { // как у настоящего Moodle: multipart с ключом и файлом → номер черновой области
      const name = /filename="([^"]*)"/.exec(body)?.[1], names = [...body.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
      if (!body.includes("tok-u1") || !name) return json({ error: "Неверный ключ", errorcode: "invalidtoken" });
      const itemid = 900000 + drafts.size + 1;
      drafts.set(itemid, names);
      return json([{ itemid, filename: name }]);
    }
    if (url.pathname === "/sim/status") return json({ status: sub.status, canedit: sub.canedit, files: sub.files });
    // «Преподаватель проверил повторно»: новый отзыв к оценке, запись в комментариях, оценка.
    if (url.pathname === "/sim/teacher") {
      const j = JSON.parse(body || "{}");
      if (j.comment != null) { sub.comment = j.comment; sub.gradedAt = nowS(); }
      if (j.thread) sub.thread.push({ author: "Преподаватель Тестовый", text: j.thread, at: nowS() });
      if (j.grade != null) sub.grade = String(j.grade);
      return json({ ok: true, sub });
    }
    const p = Object.fromEntries(new URLSearchParams(body));
    if (url.pathname === "/login/token.php") return json(p.username === "u1" && p.password === "ok-u1" ? { token: "tok-u1" } : { error: "Неверный логин или пароль, попробуйте заново." });
    if (p.wstoken !== "tok-u1") return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Ключ недействителен" });
    json(ws(p.wsfunction, p));
  });
});
await new Promise((r) => fake.listen(9911, "127.0.0.1", r));
makeSheets(); // таблицы преподавателей для курсов SHEET_COURSES

const serverLog = join(SIM, "server.log");
writeFileSync(serverLog, "");
const child = spawn(process.execPath, ["server.mjs"], { cwd: SIM, windowsHide: true,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", USERPROFILE: HOME, HOME, APPDATA, LOCALAPPDATA: join(SIM, "local"), SIM_AGENT_LOG: AGENT_LOG, SIM_NICE: "1", PIN_ASSIGNS: "", LAB_RETRY_MS: "300", GATEWAY_URL: FAKE + "/campus", CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0", MOODLE_PACE: "0", MOODLE_NIGHT: "off", LOCAL_OWNER: "1", PYTHONUSERBASE: join(process.env.APPDATA || "", "Python"), NOTIFY_EVERY_MS: "15000", SCHEDULE_TTL_MS: "5000", LAB_ACTIVE_MS: process.env.LAB_ACTIVE_MS || "8000", LAB_STUCK_MS: process.env.LAB_STUCK_MS || "25000", LAB_PROC_CACHE_MS: "3000" } });
child.stdout.on("data", (d) => appendFileSync(serverLog, d));
child.stderr.on("data", (d) => appendFileSync(serverLog, d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* ещё стартует */ } await sleep(200); }
// Вход «владельцем» (запрос с этого ПК без подписи Telegram) в поддельный Moodle.
const login = await fetch(`${B}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "u1", password: "ok-u1" }) });
console.log(`стенд готов: ${B}/  (вход: HTTP ${login.status})`);
while (!existsSync(join(SIM, "stop"))) await sleep(1000);
try { child.kill(); } catch { /* */ }
fake.close();
console.log("стенд остановлен");
process.exit(0);
