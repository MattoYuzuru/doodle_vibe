// Проверка формата ленты календаря (calendar.mjs) без сервера: события из образцов пар и работ → текст iCalendar.
// Запуск: MOODLE_DIRECT=0 node calendar-test.mjs
import { pathToFileURL } from "node:url";

const cal = await import(pathToFileURL("C:/Users/User/moodle-work/jarvis-app/calendar.mjs").href);
let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };

const lesson = { date: "2026-10-05", start: "09:00", end: "10:35", name: "Базы данных; SQL, запросы", type: "lab", typeLabel: "Лабораторные", teacher: "Сидорова А. В.", place: "Б-734", subgroup: "2" };
const moved = { ...lesson, start: "12:40", end: "14:15", change: "place", was: "Л-550" };
const dueMidnight = Date.parse("2026-10-09T00:00:00+03:00"); // срок 00:00 — как 23:59 накануне
const dueDay = Date.parse("2026-10-07T18:30:00+03:00");
const d1 = { id: "moodle:assign:101", kind: "lab", title: "ЛР4. Кэширование", due: dueMidnight, url: "https://newlms.misis.ru/mod/assign/view.php?id=5" };
const d2 = { id: "moodle:quiz:7", kind: "test", title: "Тест 1\nвторая строка", due: dueDay, opensAt: dueDay - 3600e3, url: "https://newlms.misis.ru/mod/quiz/view.php?id=9" };

const e1 = cal.lessonEvent("БИСТ-24-ПО-2", lesson), e1b = cal.lessonEvent("БИСТ-24-ПО-2", lesson), e2 = cal.lessonEvent("БИСТ-24-ПО-2", moved);
const e3 = cal.deadlineEvent(d1, "ОКП"), e4 = cal.deadlineEvent(d2, "Английский");
const now = Date.parse("2026-10-04T10:00:00Z");
const text = cal.ics("Doodle · БИСТ-24-ПО-2", [e1, e2, e3, e4], now);
const lines = text.split("\r\n");
const unfolded = text.replace(/\r\n /g, "");

check("лента начинается и кончается как положено, строки разделены CRLF", lines[0] === "BEGIN:VCALENDAR" && lines.at(-2) === "END:VCALENDAR" && lines.at(-1) === "" && !/[^\r]\n/.test(text));
check("ни одна строка не длиннее 75 байт (длинные перенесены с пробела)", lines.every((l) => Buffer.byteLength(l) <= 75), String(Math.max(...lines.map((l) => Buffer.byteLength(l)))));
check("перенос строк не рвёт русские буквы: после склейки текст цел", unfolded.includes("SUMMARY:Базы данных\\; SQL\\, запросы (лаб.)") && unfolded.includes("X-WR-CALNAME:Doodle · БИСТ-24-ПО-2"));
check("пара: московское время переведено в UTC, есть аудитория, преподаватель и подгруппа", unfolded.includes("DTSTART:20261005T060000Z") && unfolded.includes("DTEND:20261005T073500Z") && unfolded.includes("LOCATION:Б-734") && unfolded.includes("Лабораторные\\nСидорова А. В.\\nподгруппа 2"));
check("у одной и той же пары метка события постоянная, у перенесённой — другая", e1.uid === e1b.uid && e1.uid !== e2.uid && /@doodle-misis$/.test(e1.uid));
check("смена аудитории видна в описании пары", unfolded.includes("Изменение: аудитория Б-734 (была Л-550)."));
check("срок 00:00 — событие кончается в 23:59 накануне (20:59 UTC) и длится полчаса", unfolded.includes("DTSTART:20261008T202900Z") && unfolded.includes("DTEND:20261008T205900Z") && unfolded.includes("SUMMARY:Срок: ЛР4. Кэширование · ОКП"));
check("тест: «Тест до», перевод строки в названии экранирован, ссылка на Moodle на месте", unfolded.includes("SUMMARY:Тест до: Тест 1\\nвторая строка · Английский") && unfolded.includes("DTEND:20261007T153000Z") && unfolded.includes("URL:https://newlms.misis.ru/mod/quiz/view.php?id=9"));
check("пары занимают время, сроки — нет (не мешают расписанию)", (unfolded.match(/TRANSP:OPAQUE/g) || []).length === 2 && (unfolded.match(/TRANSP:TRANSPARENT/g) || []).length === 2);
check("событий четыре, у каждого есть метка, начало, конец и отметка времени", (unfolded.match(/BEGIN:VEVENT/g) || []).length === 4 && (unfolded.match(/DTSTAMP:20261004T100000Z/g) || []).length === 4 && (unfolded.match(/^UID:/gm) || []).length === 4);
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
