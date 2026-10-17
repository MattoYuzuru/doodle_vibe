// Проверка course-sheets.mjs (таблицы преподавателей в курсах) без сети: копия модуля в своей папке, вместо moodle.mjs,
// users.mjs и official.mjs — заглушки со счётчиками. Что проверяется (находки проверок 16 окт): файлы не качаются заново,
// когда книга вытеснена из памяти; при «лежащем» Moodle ничего не качается; экран не ждёт медленный Moodle дольше
// waitMs (и когда список уже читает другой запрос); сбой всего пакета и ошибка курса не повторяются на каждом запросе;
// одновременные запросы читают список один раз; неразбираемый файл не качается каждые 5 минут.
// Запуск: node ops\stand\course-sheets-test.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const APP = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const TMP = mkdtempSync(join(tmpdir(), "cs-test-"));
for (const f of ["course-sheets.mjs", "sheets.mjs", "moodle-plan.mjs", "sheet_xls.py"]) copyFileSync(join(APP, f), join(TMP, f));
writeFileSync(join(TMP, "official.mjs"), "export const groupPrefixes = () => new Set();\nexport const normGroup = (g) => String(g || '').toUpperCase().replace(/\\s+/g, '');\n");
writeFileSync(join(TMP, "users.mjs"), "export const BASE = 'https://m.test';\n");
writeFileSync(join(TMP, "moodle.mjs"), `
export const st = { down: false, calls: 0, downloads: 0, delay: 0, fail: false, files: new Map(), contents: new Map() };
export const health = () => ({ down: st.down });
export async function callMany(token, reqs) {
  st.calls++;
  if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
  if (st.fail) throw new Error("Moodle не отвечает (сеть МИСИС)");
  return reqs.map((q) => q.fn === "core_course_get_contents"
    ? (st.contents.has(q.params.courseid) ? { data: st.contents.get(q.params.courseid) } : { error: { message: "accessexception" } })
    : { data: { pages: [] } });
}
export async function downloadFile(url) {
  st.downloads++;
  const b = st.files.get(url.replace(/[?].*$/, ""));
  if (!b) throw new Error("файл из Moodle: HTTP 404");
  return b;
}
export async function whoAmI() { return { userid: 7, fullname: "Морозов Пётр Ильич", firstname: "Пётр", lastname: "Морозов" }; }
`);
// Память книг — 50 ячеек: почти каждая книга вытесняет предыдущую (проверяем, что своя запись помнится и без книги).
Object.assign(process.env, { SHEETS_MAX_CELLS: "50", SHEETS_PARSE_TIMEOUT_MS: "20000" });
const cs = await import(pathToFileURL(join(TMP, "course-sheets.mjs")).href);
const { st } = await import(pathToFileURL(join(TMP, "moodle.mjs")).href);

// Файлы: openpyxl собирает книги «журнал своей группы» с разными цифрами.
const PY = [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"].find((p) => p && existsSync(p)) || "python";
const PY_ENV = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python") };
writeFileSync(join(TMP, "make.py"), "import json, sys, openpyxl\nfor b in json.load(open(sys.argv[1], encoding='utf-8')):\n    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'ГР-24-ПО-2'\n    for r in b['rows']: ws.append(r)\n    wb.save(b['out'])\n");
const COURSES = [101, 102, 103, 104, 105, 106], PER = 8, spec = [];
for (const c of COURSES) for (let i = 0; i < PER; i++) spec.push({ out: join(TMP, `c${c}-${i}.xlsx`), rows: [["ФИО", "ЛР1", "ЛР2", "Итого"], [null, 10, 10, 20], ["Морозов Пётр Ильич", i, c % 10, i + (c % 10)], ["Белова Анна Ивановна", 9, 9, 18]] });
writeFileSync(join(TMP, "spec.json"), JSON.stringify(spec));
const mk = spawnSync(PY, [join(TMP, "make.py"), join(TMP, "spec.json")], { encoding: "utf8", env: PY_ENV, windowsHide: true });
if (mk.status) { console.log("openpyxl:", mk.stderr); process.exit(1); }
const { readFileSync } = await import("node:fs");
const section = (c, n = PER) => [{ name: "Журнал", modules: Array.from({ length: n }, (_, i) => ({ id: c * 100 + i, modname: "resource", name: `Ведомость ${i}`, url: `https://m.test/mod/resource/view.php?id=${c * 100 + i}`,
  contents: [{ type: "file", filename: `ведомость-${i}.xlsx`, fileurl: `https://m.test/pluginfile.php/${c}/${i}.xlsx`, filesize: 6000, timemodified: 1790000000 }] })) }];
for (const c of COURSES) { st.contents.set(c, section(c)); for (let i = 0; i < PER; i++) st.files.set(`https://m.test/pluginfile.php/${c}/${i}.xlsx`, readFileSync(join(TMP, `c${c}-${i}.xlsx`))); }
const G = { group: "ГР-24-ПО-2" };

{
  const r = await cs.forCourses("tok", COURSES, G);
  const first = st.downloads;
  const rec = r.get(101)?.record;
  check("48 файлов в 6 курсах: каждый скачан один раз, своя строка найдена (лучший — с наибольшей уверенностью)", first === COURSES.length * PER && rec?.have != null && r.size === 6, `скачиваний ${first}, have ${rec?.have}`);
  await cs.forCourses("tok", COURSES, G);
  await cs.forCourses("tok", COURSES, G);
  check("повторные открытия при вытесненных книгах — ни одного нового скачивания (своя запись помнится по версии файла)", st.downloads === first, `скачиваний ${st.downloads - first}`);
  const c0 = st.calls;
  await Promise.all([cs.forCourses("tok", COURSES, G), cs.forCourses("tok", COURSES, G)]);
  check("список файлов в течение 30 минут не перечитывается", st.calls === c0, `вызовов ${st.calls - c0}`);
}
{
  // Другой студент того же курса (свой токен, свой userid в заглушке тот же — важна только своя запись токена): список свой.
  st.contents.set(201, section(201, 1)); st.files.set("https://m.test/pluginfile.php/201/0.xlsx", readFileSync(join(TMP, "c101-0.xlsx")));
  const c0 = st.calls;
  await Promise.all([cs.forCourses("tok2", [201], G), cs.forCourses("tok2", [201], G)]);
  check("одновременные запросы («Журнал» и «Сессия» на старте) читают список курса одним пакетом", st.calls === c0 + 1, `вызовов ${st.calls - c0}`);
}
{
  st.contents.set(301, section(301, 1)); st.files.set("https://m.test/pluginfile.php/301/0.xlsx", readFileSync(join(TMP, "c101-1.xlsx")));
  st.delay = 2500;
  let t = Date.now();
  const slow = cs.forCourses("tok3", [301], { ...G, waitMs: 300 });
  const other = cs.forCourses("tok3", [301], { ...G, waitMs: 300 });
  const [a, b] = await Promise.all([slow, other]);
  const ms = Date.now() - t;
  check("медленный Moodle: оба экрана получают ответ через ~waitMs (0,3 с), а не через время чтения (2,5 с)", ms < 1500 && a.size === 0 && b.size === 0, `${ms} мс`);
  await new Promise((r) => setTimeout(r, 2800));
  st.delay = 0;
  t = Date.now();
  const c = await cs.forCourses("tok3", [301], { ...G, waitMs: 300 });
  check("начатое чтение доделалось в фоне: следующее открытие — уже с данными", c.get(301)?.record?.have != null, `${Date.now() - t} мс`);
}
{
  st.contents.set(401, section(401, 1)); st.files.set("https://m.test/pluginfile.php/401/0.xlsx", readFileSync(join(TMP, "c101-2.xlsx")));
  st.fail = true;
  const c0 = st.calls;
  for (let i = 0; i < 3; i++) await cs.forCourses("tok4", [401], G);
  check("пакет со списком не прочитался — повтор не на каждом открытии (3 открытия → 1 пакет)", st.calls === c0 + 1, `вызовов ${st.calls - c0}`);
  st.fail = false;
  const c1 = st.calls;
  for (let i = 0; i < 3; i++) await cs.forCourses("tok4", [999], G); // курса нет — accessexception
  check("курс, которого Moodle не отдал, — пустой список с повтором через 5 минут, а не на каждом запросе", st.calls === c1 + 1, `вызовов ${st.calls - c1}`);
}
{
  // Неразбираемый файл: «PK» в начале, а внутри мусор — ошибка разбора помнится, файл не качается снова.
  st.contents.set(501, [{ name: "Журнал", modules: [{ id: 50100, modname: "resource", name: "Журнал", contents: [{ type: "file", filename: "битый.xlsx", fileurl: "https://m.test/pluginfile.php/501/bad.xlsx", filesize: 100, timemodified: 1790000000 }] }] }]);
  st.files.set("https://m.test/pluginfile.php/501/bad.xlsx", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from("мусор вместо архива")]));
  const d0 = st.downloads;
  const r = await cs.forCourses("tok5", [501], G);
  await cs.forCourses("tok5", [501], G);
  const f = r.get(501)?.files?.[0];
  check("битый xlsx: ошибка разбора («не разобрать»), не временная, файл скачан один раз", f?.status === "error" && /разобрать/.test(f.error || "") && !f.transient && st.downloads === d0 + 1, JSON.stringify(f));
}
{
  // Moodle «лежит»: срок книг истёк (новые курсы), а скачиваний нет — только прочитанное раньше.
  st.contents.set(601, section(601, 1)); st.files.set("https://m.test/pluginfile.php/601/0.xlsx", readFileSync(join(TMP, "c101-3.xlsx")));
  st.down = true;
  const d0 = st.downloads, c0 = st.calls;
  const r = await cs.forCourses("tok6", [601], G);
  check("Moodle не работает: ни списков, ни скачиваний; нечитанный курс — просто без данных", st.downloads === d0 && st.calls === c0 && !r.has(601));
  st.down = false;
}

rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
