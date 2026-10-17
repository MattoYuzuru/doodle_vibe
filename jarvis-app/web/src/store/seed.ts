import { DAY, HOUR, addDays, dayKey, keyToUtc, todayKey } from "../lib/dates";
import { SUBJECT_COLORS } from "../theme/subjects";
import type { AppData } from "./types";

/** Момент по Москве: день относительно сегодня + время "ЧЧ:ММ". */
function msk(dayOffset: number, time: string) {
  const [h, m] = time.split(":").map(Number);
  return keyToUtc(addDays(todayKey(), dayOffset)) + (h - 3) * HOUR + m * 60e3; // МСК = UTC+3
}

/** Тестовые данные: 6 дедлайнов (один просрочен, один сдан), 4 задачи на сегодня, 4 заметки. */
export function seedData(now = Date.now()): AppData {
  const today = dayKey(now);
  const subjects = [
    { id: "os", name: "Операционные системы и среды", short: "ОС", color: SUBJECT_COLORS[0] },
    { id: "oksp", name: "Оптимизация клиент-серверных приложений", short: "ОКСП", color: SUBJECT_COLORS[1] },
    { id: "py", name: "Сетевые приложения на Python", short: "Python", color: SUBJECT_COLORS[2] },
    { id: "ce", name: "Цифровая электроника", short: "Электроника", color: SUBJECT_COLORS[3] },
    { id: "mips", name: "Моделирование информационных процессов", short: "Моделирование", color: SUBJECT_COLORS[4] },
  ];
  const base = { note: "", subtasks: [], reminder: "day" as const, source: "local" as const, status: "open" as const, kind: "lab" as const };
  const deadlines = [
    { ...base, id: "d1", title: "ЛР3 · Имитационная модель очереди", subjectId: "mips", due: msk(-1, "23:59"),
      note: "Преподаватель просил приложить исходники модели." },
    { ...base, id: "d2", title: "ЛР1 · TCP-эхо-сервер на asyncio", subjectId: "py", due: now + 19 * HOUR, reminder: "3h" as const },
    { ...base, id: "t1", title: "Тест 1 · Процессы, потоки, планирование", subjectId: "os", kind: "test" as const,
      opensAt: msk(-3, "09:00"), due: msk(2, "23:59"), note: "20 вопросов, 30 минут, одна попытка." },
    { ...base, id: "d3", title: "ЛР01 · Процессы и потоки в Linux", subjectId: "os", due: msk(3, "00:00"),
      subtasks: [
        { id: "s1", text: "Прочитать методичку", done: true },
        { id: "s2", text: "Поднять виртуальную машину", done: true },
        { id: "s3", text: "Выполнить задания 1–5", done: false },
        { id: "s4", text: "Оформить отчёт", done: false },
      ] },
    { ...base, id: "d4", title: "Этап курсовой № 1 · Веб-сервис по варианту и исходные показатели", subjectId: "oksp", kind: "coursework" as const, due: msk(8, "23:59") },
    { ...base, id: "t2", title: "Контрольный тест · Комбинационные схемы", subjectId: "ce", kind: "test" as const,
      opensAt: msk(6, "10:00"), due: msk(10, "20:00") },
    { ...base, id: "d5", title: "ЛР2 · Логические элементы и триггеры", subjectId: "ce", due: msk(12, "23:59"), reminder: "none" as const },
    { ...base, id: "d6", title: "ЛР4 · Профилирование сервиса", subjectId: "oksp", due: msk(15, "23:59") },
    { ...base, id: "d7", title: "ЛР3 · Нагрузочное испытание", subjectId: "oksp", due: msk(-2, "23:59"), status: "done" as const },
  ];
  const tasks = [
    { id: "t1", text: "Прочитать методичку ЛР01 по ОС", date: today, time: "10:00", done: true, createdAt: now - 5 * HOUR },
    { id: "t2", text: "Поднять стенд для ЛР01", date: today, time: "12:30", done: false, createdAt: now - 4 * HOUR },
    { id: "t3", text: "Набросать план курсовой", date: today, time: "16:00", done: false, createdAt: now - 3 * HOUR },
    { id: "t4", text: "Спортзал", date: today, time: "19:00", done: false, createdAt: now - 2 * HOUR },
  ];
  const notes = [
    { id: "n1", title: "Защита ЛР3", body: "Повторить: p95, граница пропускной способности, почему пул БД = 10.\nВопросы преподавателя записать сюда.", pinned: true, updatedAt: now - 2 * HOUR },
    { id: "n2", title: "Курсовая, этап 1", body: "Вариант 04. Стек: Node + PostgreSQL. Замерить исходные показатели.", pinned: false, updatedAt: now - DAY },
    { id: "n3", title: "Идеи для бота", body: "Утренняя сводка в 8:00.\nНапоминание за сутки до срока.", pinned: false, updatedAt: now - 3 * DAY },
    { id: "n4", title: "Купить", body: "Кофе\nТетрадь в клетку\nЗарядку для ноутбука", pinned: false, updatedAt: now - 5 * DAY },
  ];
  return { subjects, deadlines, tasks, notes, settings: { hiddenMoodleIds: [] } };
}
