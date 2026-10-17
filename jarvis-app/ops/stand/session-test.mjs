// Проверка session.mjs и session_xls.py: поддельная страница сессии misis.ru, файлы Excel двух вероятных устройств
// (сетка «группы по столбцам» и список «дата | группа | дисциплина»), лишний PDF правил, лист неизвестного вида.
// Настоящий сайт не трогается: адрес страницы и папка кэша подменяются через окружение до загрузки модуля.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

let fails = 0;
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };
const tmp = mkdtempSync(join(tmpdir(), "sess-"));
const files = join(tmp, "files"), cache = join(tmp, "cache");

// Файлы Excel делает Python (openpyxl стоит в пользовательской папке — как у сервера).
const py = ["C:\\Program Files\\Python312\\python.exe", process.env.PYTHON].find((p) => p && existsSync(p)) || "python";
writeFileSync(join(tmp, "make.py"), `
import openpyxl, datetime, os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "ИТКН"
ws.append(["Расписание экзаменационной сессии", None, None, None, None, None])
ws.append(["Дата", "Время", "БИСТ-24-ПО-1", None, "БИСТ-24-ПО-2", "БПМ-23-1"])
ws.append([datetime.datetime(2027, 1, 12), "10:00", "Цифровая электроника\\nИванов И.И.\\nауд. Б-301", None, "Цифровая электроника (экзамен)\\nПетров П.П.\\nБ-302", "Матанализ\\nСидоров С.С.\\nауд. 101"])
ws.append([None, "12:00", None, None, "Консультация: Теория информационных процессов и систем\\nКозлов К.К.\\nБ-305", None])
ws.append([datetime.datetime(2027, 1, 15), None, "Теория инф. процессов", None, "Теория информационных процессов и систем\\nКозлов К.К.\\nБ-305\\n9:00", None])
ws.append(["19.01.2027", "10:00", None, None, "Оптимизация клиент-серверных приложений\\nКолистратов М.В.\\nЛ-220", None])
wb.save(d + "/itkn-sessiya.xlsx")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Лист1"
ws.append(["№", "Дата", "Время", "Группа", "Дисциплина", "Преподаватель", "Аудитория"])
ws.append([1, "13.01.2027", "9:00", "БИСТ-24-ПО-2, БИСТ-24-ПО-1", "Моделирование ИПС", "Колистратов М.В.", "Б-410"])
ws.append([2, datetime.datetime(2027, 1, 20), datetime.time(14, 30), "БПМ-23-1", "Физика", "Орлов О.О.", "А-100"])
wb.save(d + "/list.xlsx")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Прочее"
ws.append(["Какой-то текст", "без групп"]); ws.append(["и без дат", ""])
wb.save(d + "/other.xlsx")
`);
const mk = spawnSync(py, [join(tmp, "make.py"), files], { encoding: "utf8", env: { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python") } });
if (mk.status) { console.log("не удалось сделать файлы Excel:", mk.stderr); process.exit(1); }

let page = `<html><body><h1>Расписание экзаменационной сессии</h1><p>Информация будет опубликована перед экзаменационной сессией.</p>
<a href="/f/1/students/mem/pam-2026_compressed.pdf">Правила внутреннего распорядка обучающихся</a></body></html>`;
const fake = createServer((req, res) => {
  if (req.url.startsWith("/session")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
  const f = /^\/files\/([\w.-]+)$/.exec(req.url);
  if (f && existsSync(join(files, f[1]))) { res.writeHead(200); return res.end(readFileSync(join(files, f[1]))); }
  if (req.url.endsWith("sessiya-gi.pdf")) { res.writeHead(200); return res.end("%PDF-1.4 fake"); }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;
Object.assign(process.env, { MISIS_SESSION_URL: `${base}/session/`, SESSION_CACHE: cache, SESSION_WATCH: "0" });
const s = await import("../../session.mjs");
const events = [];
s.onNew((f) => { events.push(f); });

check("ссылки: Excel берутся все, PDF — только про сессию (правила распорядка — нет)", s.parseLinks(page).length === 0 && s.parseLinks(`<a href="/a/x.xls">ИТКН</a><a href="/b/sessiya-gi.pdf">Сессия ГИ</a><a href="/c/pam.pdf">Правила</a>`).map((l) => l.name).join(",") === "x.xls,sessiya-gi.pdf");
const r0 = await s.check();
check("страница без файлов: ничего нового, расписания у группы нет", r0.length === 0 && (await s.examsFor("БИСТ-24-ПО-2")) === null && events.length === 0);

page = `<html><body><a href="/files/itkn-sessiya.xlsx">Институт компьютерных наук</a> <a href="/files/list.xlsx">Горный институт</a>
<a href="/files/other.xlsx">Прочее</a> <a href="/files/sessiya-gi.pdf">Сессия ГИ (pdf)</a> <a href="/f/1/pam-2026.pdf">Правила</a></body></html>`;
const r1 = await s.check();
check("опубликованы 4 файла: 3 Excel разобраны, PDF скачан без разбора, правила пропущены", r1.length === 4 && r1.filter((f) => f.parsed).length === 3 && r1.find((f) => f.name === "sessiya-gi.pdf")?.parsed === false, r1.map((f) => `${f.name}:${f.parsed}:${f.groups.length}`).join(" "));
check("лист неизвестного вида — пропущен с причиной, не ошибка", r1.find((f) => f.name === "other.xlsx")?.skipped.length === 1 && !r1.find((f) => f.name === "other.xlsx").error, JSON.stringify(r1.find((f) => f.name === "other.xlsx")?.skipped));
check("подписчик узнал о каждом новом файле", events.length === 4);

const ex = await s.examsFor("БИСТ-24-ПО-2");
const L = ex?.list || [], at = (i) => L[i] || {};
const line = (e) => `${e.date} ${e.time || "--:--"} ${e.kind} ${e.name} [${e.place}] ${e.teacher}`;
check("сетка + список: у БИСТ-24-ПО-2 пять записей по датам, из двух файлов", L.length === 5 && L.map((e) => e.date).join(",") === "2027-01-12,2027-01-12,2027-01-13,2027-01-15,2027-01-19", L.map(line).join("\n"));
check("сетка: дата из объединённой ячейки тянется вниз, консультация отличается от экзамена, время из ячейки", at(1).kind === "consult" && at(1).time === "12:00" && at(3).time === "09:00" && at(3).kind === "exam", line(at(1)) + " / " + line(at(3)));
check("сетка: название без «(экзамен)» и без преподавателя, аудитория и преподаватель отдельно", at(0).name === "Цифровая электроника" && at(0).place === "Б-302" && at(0).teacher === "Петров П.П." && at(0).time === "10:00", line(at(0)));
check("список: несколько групп в одной ячейке — экзамен у каждой; время 9:00 → 09:00", at(2).name === "Моделирование ИПС" && at(2).time === "09:00" && at(2).place === "Б-410" && (await s.examsFor("БИСТ-24-ПО-1"))?.list.some((e) => e.name === "Моделирование ИПС"));
const bpm = await s.examsFor("БПМ-23-1");
check("другая группа: свои две записи, дата и время из ячеек-дат Excel", bpm?.list.length === 2 && bpm.list[1].date === "2027-01-20" && bpm.list[1].time === "14:30" && bpm.list[1].name === "Физика", bpm?.list.map(line).join("\n"));
check("подгруппа соседней группы (пустой заголовок) не приписана чужой группе", (await s.examsFor("БИСТ-24-ПО-1"))?.list.length === 3);
const r2 = await s.check();
check("повторная проверка: новых файлов нет, подписчику не звонят", r2.length === 0 && events.length === 4);
const inf = await s.info();
check("сводка о странице: 4 файла, у разобранных число групп", inf.files.length === 4 && inf.files.find((f) => f.name === "itkn-sessiya.xlsx")?.groups === 3, JSON.stringify(inf.files.map((f) => [f.name, f.groups])));
check("состояние на диске: state.json и разбор файла", existsSync(join(cache, "state.json")) && existsSync(join(cache, "itkn-sessiya.xlsx.json")));

fake.close();
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
