// Проверка curriculum.mjs на поддельной странице программ misis.ru и настоящем учебном плане БИСТ-24 (fixtures).
// Настоящий сайт не трогается: адрес страницы и папка кэша подменяются через окружение до загрузки модуля.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF = readFileSync(join(HERE, "fixtures", "09.03.02-BIST-24.plx.pdf"));
let fails = 0, hits = { page: 0, pdf: 0 };
const check = (name, ok, info = "") => { fails += ok ? 0 : 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  | ${info}` : ""}`); };

// Страница программ: у плана БИСТ-24 есть кириллическое упоминание (как на сайте), у БПМ-23 — только латинское имя файла.
const page = `<html><body>
<a href="/sveden/files/aiq/Opisanie_rezulytatov_09.03.02-BIST-24.plx.pdf">Описание результатов освоения образовательных траекторий 09.03.02-БИСТ-24.plx</a>
<a href="/sveden/files/aic/09.03.02-BIST-24.plx.pdf">Учебный план</a>
<a href="/sveden/files/eih/09.03.02-BIST-23.plx.pdf">Учебный план</a>
<a href="/sveden/files/zzz/01.03.04-BPM-23.plx.pdf">Учебный&nbsp;план</a>
<a href="/sveden/files/q/Rabochaya_programma.pdf">Рабочая программа</a>
<a class="word-break-all" target="_blank" rel="noopener" href="/sveden/files/rik/09.03.01-BIVT-24.plx(1).pdf" title="Учебный план"><span class="icon-signature"></span>Учебный план </a>
<a href="/sveden/files/riq/09.03.01-BIVT-24-2.plx(2).pdf">Учебный план</a>
</body></html>`;
const fake = createServer((req, res) => {
  if (req.url.startsWith("/eduop")) { hits.page++; res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
  if (req.url.endsWith("09.03.02-BIST-24.plx.pdf")) { hits.pdf++; res.writeHead(200, { "content-type": "application/pdf" }); return res.end(PDF); }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;
const cache = mkdtempSync(join(tmpdir(), "curr-"));
process.env.MISIS_EDUOP_URL = `${base}/eduop/`;
process.env.CURRICULUM_CACHE = cache;
const cur = await import("../../curriculum.mjs");

const idx = cur.parseIndex(page);
check("список планов: поток — по кириллическому упоминанию на странице, иначе транслитерацией; «(1)» в имени файла и разложенная «й» не мешают", idx["БИСТ-24"]?.name === "09.03.02-BIST-24.plx.pdf" && idx["БИСТ-23"]?.code === "09.03.02" && idx["БПМ-23"]?.url.endsWith("01.03.04-BPM-23.plx.pdf") && idx["БИВТ-24"]?.name === "09.03.01-BIVT-24.plx(1).pdf" && idx["БИВТ-24-2"]?.code === "09.03.01" && Object.keys(idx).length === 5, JSON.stringify(Object.keys(idx)));
check("план группы — по самому длинному совпадению: БИВТ-24-2-… → «БИВТ-24-2», БИВТ-24-1 → «БИВТ-24», БИСТ-24-ПО-2 → «БИСТ-24», ИВТ-30 — нет", cur.planKey("БИВТ-24-2-ПО", idx) === "БИВТ-24-2" && cur.planKey("БИВТ-24-1", idx) === "БИВТ-24" && cur.planKey("БИСТ-24-ПО-2", idx) === "БИСТ-24" && cur.planKey("ИВТ-30-1", idx) === null);
check("префикс группы: «БИСТ-24-ПО-2» (и с похожей латинской буквой «БИСT») → БИСТ-24; не группа → null", cur.prefixOf("БИСТ-24-ПО-2") === "БИСТ-24" && cur.prefixOf("БИСT-24-ПО-2") === "БИСТ-24" && cur.prefixOf("БПМ-23-1") === "БПМ-23" && cur.prefixOf("что-то") === null);

const t = (s) => Date.parse(`${s}T12:00:00+03:00`);
const s1 = await cur.status("БИСТ-24-ПО-2", t("2026-10-15"));
check("план скачан и разобран: программа, институт, год набора", s1.program?.code === "09.03.02" && /компьютерных наук/i.test(s1.program.institute) && s1.program.admission === 2024 && s1.program.year === "2026-2027", JSON.stringify(s1.program).slice(0, 200));
check("15 окт 2026: 3 курс, 5 семестр, 7-я неделя", s1.course === 3 && s1.semester === 5 && s1.week === 7, `${s1.course}/${s1.semester}/${s1.week} ${s1.error || ""}`);
check("зимняя сессия 3 курса — 5–25 января 2027, впереди, 82 дня", s1.session?.from === "2027-01-05" && s1.session.to === "2027-01-25" && s1.session.state === "ahead" && s1.session.days === 82 && s1.session.label === "зимняя" && s1.upcoming?.from === "2027-01-05", JSON.stringify(s1.session));
const kinds = s1.periods.map((p) => `${p.kind}:${p.weeks[0]}-${p.weeks[1]}`).join(" ");
check("отрезки года: учёба 1–18, сессия 19–21, каникулы 22–23, учёба 24–41, сессия 42–43, практика 44–47, каникулы 48–52", kinds === "theory:1-18 exam:19-21 holiday:22-23 theory:24-41 exam:42-43 practice:44-47 holiday:48-52", kinds);
check("каникулы после сессии: 26 января – 8 февраля", s1.periods[2].from === "2027-01-26" && s1.periods[2].to === "2027-02-08", `${s1.periods[2].from}..${s1.periods[2].to}`);
const names = s1.subjects.map((s) => s.name);
check("дисциплины 5 семестра: 11 (с элективами), экзамены первыми, у «Оптимизации…» экзамен и курсовая", s1.subjects.length === 11 && s1.subjects[0].exam && names.includes("Оптимизация клиент-серверных приложений") && s1.subjects.find((s) => /Оптимизация/.test(s.name))?.labels.join(", ") === "экзамен, курсовая работа", names.join(" | "));
check("итог форм контроля семестра: 3 экзамена, 7 зачётов с оценкой, 2 курсовые, 1 без аттестации", s1.counts.exam === 3 && s1.counts.graded === 7 && s1.counts.coursework === 2 && s1.counts.none === 1 && cur.countsText(s1.counts) === "3 экзамена, 7 зачётов с оценкой, 2 курсовые", JSON.stringify(s1.counts));
check("элективы помечены парой (студент берёт один из двух)", s1.subjects.filter((s) => s.elective === "Б1.В.ДВ.01").length === 2);

const s2 = await cur.status("БИСТ-24-ПО-2", t("2027-01-10"));
check("10 января 2027: сессия идёт, до конца 15 дней, семестр всё ещё 5-й", s2.semester === 5 && s2.session?.state === "now" && s2.session.days === 15, JSON.stringify(s2.session));
const s3 = await cur.status("БИСТ-24-ПО-2", t("2027-03-01"));
// Недели графика идут по дням от 1 сентября (неделя 42 — 15–21 июня), а не по календарным понедельникам.
check("1 марта 2027: 6 семестр, летняя сессия 15–28 июня, зимняя уже прошла", s3.semester === 6 && s3.session?.label === "летняя" && s3.session.from === "2027-06-15" && s3.session.to === "2027-06-28" && s3.upcoming?.from === "2027-06-15", JSON.stringify(s3.session));
const s4 = await cur.status("БИСТ-24-ПО-2", t("2027-07-10"));
check("10 июля 2027: летняя сессия прошла, ближайшая — зимняя 4 курса (5 января 2028, 7 семестр)", s4.session?.state === "past" && s4.upcoming?.course === 4 && s4.upcoming.semester === 7 && s4.upcoming.from === "2028-01-05", JSON.stringify(s4.upcoming));
const s5 = await cur.status("БИСТ-24-ПО-2", t("2025-10-15"));
check("год назад: 2 курс, 3 семестр", s5.course === 2 && s5.semester === 3 && s5.subjects.some((s) => /Базы данных/.test(s.name)), `${s5.course}/${s5.semester}`);
const s6 = await cur.status("БИСТ-24-ПО-2", t("2030-10-15"));
check("после выпуска — понятная причина, не падение", !!s6.error && /закончено/.test(s6.error), s6.error);
const e1 = await cur.status("БПМ-23-1", t("2026-10-15"));
check("план есть в списке, но файл не скачался — ошибка с текстом, не падение", /HTTP 404/.test(e1.error || ""), e1.error);
const e2 = await cur.status("ИВТ-30-1", t("2026-10-15"));
check("потока нет в списке — «нет учебного плана для потока»", /нет учебного плана для потока ИВТ-30/.test(e2.error || ""), e2.error);
check("страница программ и PDF запрошены по одному разу — дальше из кэша", hits.page === 1 && hits.pdf === 1, JSON.stringify(hits));
check("кэш на диске: index.json и БИСТ-24.json", readFileSync(join(cache, "index.json"), "utf8").includes("БИСТ-24") && readFileSync(join(cache, "БИСТ-24.json"), "utf8").includes("calendar"));

fake.close();
rmSync(cache, { recursive: true, force: true });
console.log(fails ? `ИТОГ: сбоев ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
