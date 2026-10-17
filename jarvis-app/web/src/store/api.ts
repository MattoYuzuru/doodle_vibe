import { tg } from "../telegram/webapp";
import type { Remark } from "./types";

/** Отзыв преподавателя по работе — свежим запросом в Moodle (GET api/feedback/<assignId>). */
export interface Feedback {
  assignId: number;
  /** Статус ответа в Moodle: new, draft, submitted, reopened. */
  status: string;
  /** Разрешает ли Moodle менять ответ (заменить файл). */
  canEdit: boolean;
  /** false — у задания нет черновика: прикреплённый файл сразу сдаётся на проверку. */
  drafts?: boolean;
  graded: boolean;
  grade: number | null;
  gradeMax: number | null;
  remarks: Remark[];
  files: { name: string; size: number }[];
  feedbackFiles: { name: string; size: number }[];
}

/** Задание «лабораторная» на сервере ПК (jobs/<assignId>.json). */
export interface LabJob {
  id: string;
  title: string;
  course: string;
  status: "idle" | "running" | "waiting" | "report" | "attached" | "submitted" | "error";
  /** kind "report" — сообщение с готовым отчётом (файл показывается прямо в переписке); "brief" — «Кратко о работе». */
  messages: { role: "user" | "assistant" | "system"; text: string; at: number; kind?: "report" | "file" | "brief"; report?: { name: string; size: number; pages: number | null }; file?: { name: string; size: number } }[];
  /** Круг проверки отчёта студентом: pending — ждём «всё хорошо» или правки; approved — подтверждён, можно прикреплять. */
  review?: "pending" | "approved";
  report: { pdf: string; docx: string | null; size: number; pages: number | null; at: number; name: string; mtime?: number } | null;
  /** «Кратко о работе»: at — время сообщения с объяснением в переписке, report — к какой версии отчёта (mtime файла) оно написано. */
  brief?: { at: number; report: number | null } | null;
  /** Агент прямо сейчас готовит «Кратко о работе» (состояние лабы при этом не меняется). */
  briefing?: number;
  /** Плашка этой лабы убрана с Главной (когда); любое новое действие студента по лабе возвращает её. */
  dismissed?: number;
  moodle: { text: string; at: number; ok: boolean } | null;
  agent: { status: "question" | "working" | "report" | "blocked"; text?: string } | null;
  /** Проверочный запуск на уже оценённой работе: отчёт делается, но в Moodle не прикрепляется и не отправляется. */
  trial?: boolean;
  /** Пробный отчёт нового пользователя (lab-trial.mjs) — не путать с trial выше. */
  viaTrial?: boolean;
  /**
   * Идёт или шло исправление по замечаниям преподавателя: n — какое по счёту, name — имя исправленного файла,
   * delivered — замечания дошли до агента, done — исправленный отчёт уже собран.
   */
  fix?: { at: number; n: number; remarks: string; prevFiles: string[]; name?: string | null; delivered?: boolean; done: boolean } | null;
  /** Ход ждёт своей очереди (агент занят лабой другого пользователя). */
  queued?: boolean;
  /** Идёт исправление готового отчёта: по замечаниям преподавателя (teacher) или по правкам студента (review). */
  revising?: "teacher" | "review" | null;
  /** 0–100 и название этапа — из JOB.json агента, обновляется по ходу работы. */
  progress?: number;
  stage?: string;
  /** Пока идёт ход агента — признаки жизни, которые сервер видит сам (без модели). */
  activity?: LabActivity | null;
  error?: string | null;
  token?: string;
  updatedAt?: number;
}

/** База для запросов к серверу: тот же адрес, что и у приложения (base "./"). */
export const apiBase = () => location.origin + location.pathname.replace(/[^/]*$/, "");

/** Предел ожидания ответа сервера: туннель Cloudflare сам режет запрос на 100 с, без своего предела экран «обновляю…» висел бы вечно. */
export const API_TIMEOUT_MS = 90_000;
/** Заголовки для запросов к серверу ПК: подпись Telegram и обход страницы-предупреждения ngrok. */
export const apiHeaders = () => ({ "x-telegram-init-data": tg?.initData ?? "", "ngrok-skip-browser-warning": "1" });

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(apiBase() + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...apiHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    // Сетевой сбой — понятным русским текстом, как в syncMoodle (проверка 15 окт): раньше на экран попадали
    // «Failed to fetch», «Load failed» или «signal timed out».
    const n = (e as Error).name;
    throw new Error(n === "TimeoutError" || n === "AbortError" ? "Сервер не ответил вовремя" : e instanceof TypeError ? "Сервер недоступен" : (e as Error).message);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `ошибка ${r.status}`);
  return j as T;
}

/** Лаба, по которой что-то идёт или ждут ответа студента (GET api/labs) — для плашки на Главной. */
/**
 * Что агент делает прямо сейчас (activity.mjs на сервере): active — недавно что-то записал (what — что, at — когда);
 * long — долгая операция (замеры, команда стенда) или тишина меньше 15 мин; slept — сервер спал, ход продолжается сам;
 * stuck — 15 мин и больше ничего (alerted — владельцу уже написали). stageAt — с какого момента идёт этап.
 */
export interface LabActivity { state: "active" | "long" | "slept" | "stuck"; what: string | null; at: number; alerted?: boolean; stageAt?: number | null }

export interface LabSummary {
  id: string; title: string; status: LabJob["status"]; progress: number; stage: string; queued: boolean; revising?: LabJob["revising"]; activity?: LabActivity | null;
  review: "pending" | "approved" | null; question: boolean; updatedAt: number;
}

export const labApi = {
  list: () => api<LabSummary[]>("api/labs"),
  get: (id: string) => api<LabJob>(`api/lab/${id}`),
  start: (id: string, meta: { title: string; course: string; due: number; trial?: boolean }) => api<LabJob>(`api/lab/${id}/start`, meta),
  message: (id: string, text: string) => api<LabJob>(`api/lab/${id}/message`, { text }),
  /** «Исправить отчёт»: сервер сам берёт замечания преподавателя из Moodle и передаёт агенту. */
  fix: (id: string, meta: { title: string; course: string; due: number }) => api<LabJob>(`api/lab/${id}/fix`, meta),
  /** «Всё хорошо» под отчётом: после этого его можно прикрепить в Moodle. */
  approve: (id: string) => api<LabJob>(`api/lab/${id}/approve`, {}),
  /** «Кратко о работе»: короткое объяснение сути работы к текущей версии отчёта (приходит сообщением в переписку). */
  explain: (id: string) => api<LabJob>(`api/lab/${id}/explain`, {}),
  /** «Убрать с Главной»: плашка лабы скрывается до следующего действия студента; лаба и отчёт остаются. */
  dismiss: (id: string) => api<LabJob>(`api/lab/${id}/dismiss`, {}),
  attach: (id: string) => api<LabJob>(`api/lab/${id}/attach`, {}),
  submit: (id: string) => api<LabJob>(`api/lab/${id}/submit`, {}),
  reportUrl: (job: LabJob) => `${apiBase()}api/lab/${job.id}/report?t=${job.token ?? ""}`,
  /** Скрепка в чате: снимок экрана или файл студента уходит в папку лабы на сервере ПК, агент узнаёт о нём со следующим сообщением. */
  upload: (id: string, file: File) => new Promise<LabJob>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `${apiBase()}api/lab/${id}/upload`);
    for (const [k, v] of Object.entries(apiHeaders())) x.setRequestHeader(k, v);
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    x.timeout = 3 * 60_000;
    x.onload = () => {
      let j: unknown = {};
      try { j = JSON.parse(x.responseText || "{}"); } catch { /* не JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(j as LabJob);
      else reject(new Error((j as { error?: string }).error || `ошибка ${x.status}`));
    };
    x.onerror = () => reject(new Error("Нет связи с сервером — файл не отправлен, попробуйте ещё раз"));
    x.ontimeout = () => reject(new Error("Сервер не ответил вовремя — попробуйте ещё раз"));
    x.send(file);
  }),
};

/** Замечание проверки своего отчёта: уровень, где в отчёте, что не так и что сделать. */
export interface CheckItem { level: "must" | "should" | "minor"; area: string; where: string; what: string; fix: string }
/** Состояние «Проверки своего отчёта» по работе (lab.mjs checkReport): idle — проверок не было. */
export interface CheckState {
  id: string; status: "idle" | "running" | "done" | "error"; title?: string; course?: string; stage?: string | null;
  at: number; doneAt?: number | null; file: { name: string; size: number }; n: number; error?: string | null;
  result?: { verdict: "ok" | "fix" | "serious"; summary: string; items: CheckItem[]; good: string[]; unchecked: string[] } | null;
}
const sendFile = <T,>(path: string, file: File) => new Promise<T>((resolve, reject) => {
  const x = new XMLHttpRequest();
  x.open("POST", `${apiBase()}${path}`);
  for (const [k, v] of Object.entries(apiHeaders())) x.setRequestHeader(k, v);
  x.setRequestHeader("content-type", file.type || "application/octet-stream");
  x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  x.timeout = 3 * 60_000;
  x.onload = () => {
    let j: unknown = {};
    try { j = JSON.parse(x.responseText || "{}"); } catch { /* не JSON */ }
    if (x.status >= 200 && x.status < 300) resolve(j as T);
    else reject(new Error((j as { error?: string }).error || `ошибка ${x.status}`));
  };
  x.onerror = () => reject(new Error("Нет связи с сервером — файл не отправлен, попробуйте ещё раз"));
  x.ontimeout = () => reject(new Error("Сервер не ответил вовремя — попробуйте ещё раз"));
  x.send(file);
});
export const checkApi = {
  get: (assignId: string) => api<CheckState>(`api/check/${assignId}`),
  /** Файл отчёта студента (PDF или DOCX) уходит на сервер ПК как есть; проверка идёт в фоне, состояние — через get. */
  start: (assignId: string, file: File) => sendFile<CheckState>(`api/check/${assignId}`, file),
};

export const feedbackApi = { get: (assignId: string) => api<Feedback>(`api/feedback/${assignId}`) };

/** Ответ сервера после прикрепления своего файла или отправки на проверку. */
export interface OwnSubmitResult {
  state: { status: string; canEdit: boolean; files: string[]; drafts: boolean } | null;
  /** Файлы, удалённые из ответа (новый встал вместо них). */
  removed?: string[];
  already?: boolean;
  line: string;
}

/** Предел файла на стороне сервера ПК (Moodle может ограничить строже — это видно в настройках задания). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * «Прикрепить PDF»: файл уходит на сервер ПК как есть (XHR — ради процента загрузки), сервер кладёт его в ответ Moodle.
 * onProgress — доля 0…1 загрузки до сервера ПК.
 */
export function uploadOwnFile(assignId: string, file: File, onProgress?: (p: number) => void): Promise<OwnSubmitResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `${apiBase()}api/upload/${assignId}`);
    for (const [k, v] of Object.entries(apiHeaders())) x.setRequestHeader(k, v);
    x.setRequestHeader("content-type", "application/pdf");
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    x.timeout = 5 * 60_000; // медленная сеть + загрузка в Moodle
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let j: unknown = {};
      try { j = JSON.parse(x.responseText || "{}"); } catch { /* не JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(j as OwnSubmitResult);
      else reject(new Error((j as { error?: string }).error || `ошибка ${x.status}`));
    };
    x.onerror = () => reject(new Error("Нет связи с сервером — файл не отправлен, попробуйте ещё раз"));
    x.ontimeout = () => reject(new Error("Сервер не ответил вовремя — проверьте в Moodle, прикрепился ли файл"));
    x.send(file);
  });
}
export const submitOwn = (assignId: string) => api<OwnSubmitResult>(`api/submit/${assignId}`, {});

/** Электронный журнал МИСИС (ej.misis.ru): подключение и данные (посещаемость и успеваемость). */
export interface EjState {
  connected: boolean;
  /** Пароля нет (вошли до 16 окт 2026) или MISIS ID не принял сохранённый — нужен пароль от человека. */
  needPassword?: boolean;
  /** Пароль сохранён: когда вход MISIS ID истечёт, сервер войдёт им сам. */
  saved?: boolean;
  /** MISIS ID не принял сохранённый пароль (скорее всего, его сменили) — нужен текущий. */
  rejected?: boolean;
  at: number | null;
  error: string | null;
  /** Почта MISIS ID (она же логин Moodle). */
  email: string | null;
  data: EjData | null;
  /** Журнал не ответил при этой загрузке: data — последние удачные данные (если были), здесь — причина. */
  loadError?: string | null;
  /**
   * Посещения и баллы из таблиц преподавателей в курсах Moodle — по дисциплинам, о которых журнал не знает (нет в
   * журнале, нет отметок о посещении или оценок). Приходят и без подключённого журнала. ejId — дисциплина журнала,
   * к карточке которой это относится; null — отдельная карточка.
   */
  sheets?: SheetSubject[] | null;
}
export interface SheetSubject {
  /** ejKnown — сервер сопоставлял с журналом этого семестра: ejId null значит «в журнале нет» (не приклеивать по названию). */
  id: string; courseId: number; ejId: number | null; ejKnown?: boolean; name: string;
  /** Процент посещений (были / (были + пропуски)), null — посещений в таблице нет. */
  attendance: number | null;
  lessons: { past: number; present: number; absent: number; excused: number; unmarked: number; missedHours: number } | null;
  absences: { date: string | null; kind: string; n: number | null; hours: number; excused: boolean }[];
  /** Баллы в процентах шкалы (null — максимум неизвестен) и подробно. */
  rating: number | null;
  /** full — таблица на всю дисциплину (шкала как у рейтинга); иначе баллы — только часть или без максимума. */
  points: { have: number; scale: number | null; left: number | null; parts: { name: string; have: number; max: number }[]; label: string | null; confidence: string; full?: boolean; note: string | null } | null;
  sheet: SheetSource | null; attendanceSheet: SheetSource | null;
}
/** Дисциплина семестра: проценты — как в самом журнале; пропуски и оценки — из журнала дисциплины. */
export interface EjSubject {
  id: number;
  name: string;
  teachers: string[];
  /** Проценты 0–100 (null — журнал не посчитал). trackInDate — темп освоения к сегодняшнему дню, по нему цвет. */
  attendance: number | null;
  rating: number | null;
  track: number | null;
  trackInDate: number | null;
  /** «Экзамен» | «Зачёт с оценкой» | «Зачёт». */
  control: string | null;
  /** Рекомендуемая оценка по рейтингу и порогам дисциплины (как в журнале) — только когда все работы семестра позади. */
  grade: number | null;
  /** Пороги оценок дисциплины в процентах рейтинга: { 3: 50, 4: 70, 5: 90 }. */
  thresholds: { 3: number; 4: number; 5: number } | null;
  /** Прошедшие занятия своей подгруппы: были, пропустил, не отмечены; missedHours — пропущено ак. часов. */
  lessons: { past: number; present: number; absent: number; unmarked: number; missedHours: number } | null;
  absences: { date: string; kind: string; n: number | null; hours: number }[];
  works: { name: string; kind: string; n: number | null; date: string | null; mark: number | null; max: number | null; failed: boolean }[];
  /** Подробности дисциплины не загрузились (проценты при этом есть). */
  error: string | null;
}
export interface EjData {
  at: string;
  semester: string | null;
  group: string | null;
  /** Средние и пропуски — только по subjects (без notMine). */
  summary: { attendance: number | null; rating: number | null; absences: number; missedHours: number };
  subjects: EjSubject[];
  /**
   * Дисциплины, которые студент назвал не своими (16 окт 2026): ответ «Нет, не моя» боту или «Не моё» в «Сессии» (from —
   * где сказано последним). Не в subjects и не в средних; «Вернуть» — ejApi.mine.
   */
  notMine?: (EjSubject & { from: "bot" | "session" })[];
}
export const ejApi = {
  get: (refresh = false) => api<EjState>(`api/ej${refresh ? "?refresh" : ""}`),
  connect: (password: string) => api<EjState>("api/ej/connect", { password }),
  /** «Вернуть» не свою дисциплину: снимаются и ответ боту, и «Не моё» в «Сессии»; ответ — журнал заново. */
  mine: (id: number) => api<EjState>("api/ej/mine", { id }),
};

/** «Сессия» (GET api/session, admission.mjs): учебный план группы с misis.ru, расписание экзаменов, долги по журналу и Moodle. */
export interface SessionPeriod { kind: "theory" | "exam" | "holiday" | "practice" | "diploma" | "research" | "other"; label: string; from: string; to: string; weeks: [number, number] }
export interface SessionInfo { semester: number; course: number; label: string; from: string; to: string; weeks: [number, number]; state: "ahead" | "now" | "past"; days: number }
export interface SessionSubject {
  index: string | null; name: string; kind: string;
  /** Формы контроля в этом семестре («Эк», «ЗаО», «За», «КР») и их названия словами. */
  controls: string[]; labels: string[];
  /** Дисциплина по выбору: id группы — студент берёт одну из вариантов. */
  elective: string | null;
  /** Ключ для «не моё» (POST api/session/choice). */
  key: string;
  /** Все варианты группы по выбору (для выбора самим студентом); null — вариант один. */
  variants?: { index: string; name: string }[] | null;
  /** Выбранный вариант определён: сам студент, по журналу или по курсу Moodle. */
  electiveFrom?: "user" | "journal" | "moodle";
  /** Какой вариант выбран, неизвестно: показаны все, их столько. */
  electiveOpen?: number;
  /** Факультатив, на который студент записан (сам сказал или нашёлся в журнале / Moodle). */
  attending?: boolean; attendingFrom?: "user" | "journal" | "moodle" | null;
  exam: boolean; graded: boolean; pass: boolean; coursework: boolean;
  examDates: { date: string; time: string | null; kind: "exam" | "consult" | "test"; place: string; teacher: string }[];
  /** Есть ли дисциплина в электронном журнале (по названию). */
  inJournal: boolean;
  /**
   * Баллы рейтинга из 100 (как в журнале): have — есть, left — можно ещё набрать (работы без оценки и не заведённые
   * контрольные), targets — пороги (на 3/4/5 или «зачёт»): сколько не хватает, набран ли, достижим ли.
   */
  score: SessionScore | null;
  /** red — первый порог уже не набрать оставшимися работами; yellow — есть работа ниже порога. */
  level: "ok" | "yellow" | "red";
  /** Справка, когда баллов онлайн нет вовсе (английский): разбивка и пороги из рабочей программы, что с пропусками. */
  info?: SubjectNote | null;
  /** Таблица преподавателя в курсе есть, но баллы из неё не взяты — почему (однофамильцы, не прочиталась). */
  sheetNote?: string | null;
}
export interface SubjectNote { scale: number; parts: { name: string; max: number }[]; bands: string; notes: string[]; url: string }
/** Откуда таблица преподавателя: файл курса Moodle или ссылка в курсе на Яндекс Диск / Google Таблицы. */
export interface SheetSource {
  kind: "moodle" | "yandex" | "google";
  /** Название элемента курса («Журнал»), имя файла, раздел курса, ссылка на элемент в Moodle, когда файл изменён (мс). */
  title: string | null; file: string | null; section?: string | null; url: string | null; modified: number | null;
  /** Лист книги со своей строкой, код группы листа, своя ли группа, как нашлась строка (ФИО целиком / имя / инициалы). */
  sheet?: string | null; group?: string | null; groupRel?: "same" | "other" | "unknown" | null; match?: "fio" | "name" | "initials" | null;
  /** Какой именно файл (у ссылок со страницы курса url один на несколько таблиц). */
  ref?: string | null;
}
export interface SessionScore {
  /** ej — электронный журнал (шкала 100); moodle — журнал оценок курса Moodle и его рейтинг-план; sheet — таблица преподавателя в курсе. */
  source: "ej" | "moodle" | "sheet";
  /** Максимум баллов дисциплины (100 у журнала; у Moodle — из рейтинг-плана, null — неизвестен). */
  scale: number | null;
  have: number; left: number | null; pending: number | null; max: number | null;
  targets: { key: "3" | "4" | "5" | "pass"; label: string; at: number; need: number; done: boolean; reachable: boolean | null; strict?: boolean }[];
  failed: string[]; grade: number | null;
  /** Насколько расчёту можно верить: none — порогов нет, low — журнал оценок не сходится с планом (пороги только текстом). */
  confidence: "high" | "medium" | "low" | "none";
  note?: string | null;
  /**
   * Только Moodle: сколько работ оценено, какие ещё без оценки (не сдано или не проверено), выставленные итоговые
   * оценки, сумма максимумов заведённых работ, пороги плана текстом, почему порогов нет (planNote), найден ли план, ссылки.
   */
  graded?: number; pendingWorks?: { name: string; max: number }[]; finals?: { name: string; grade: number; max: number }[]; sumMax?: number;
  planStatus?: "ok" | "pass" | "none" | "unparsed" | "ambiguous"; planBands?: string | null; planPass?: number | null;
  planNote?: string | null; planFound?: boolean;
  planUrl?: string | null; gradesUrl?: string | null;
  /**
   * Только таблица преподавателя: откуда, по частям (лекции, лабораторные… — набрано из максимума), подпись итогового
   * столбца (когда максимума нет — что это за баллы), оценка в таблице словом («зачтено», «н/я»), откуда пороги.
   */
  sheet?: SheetSource | null; parts?: { name: string; have: number; max: number }[]; totalLabel?: string | null; gradeText?: string | null;
  thresholdsFrom?: "journal" | "moodle" | "sheet" | null;
  /** Таблица на всю дисциплину (её максимум — как у рейтинга или рейтинг-плана): только тогда считаются пороги. */
  full?: boolean;
}
export interface SessionView {
  needGroup?: boolean; group: string | null; course?: number | null; semester?: number | null; today?: string;
  session?: SessionInfo | null; upcoming?: SessionInfo | null; periods?: SessionPeriod[];
  program?: { code: string; name: string; institute: string | null; admission: number | null; year: string | null; approved: string | null; url: string } | null;
  planError?: string | null;
  exams?: { published: boolean; at: number | null; title: string | null; url: string | null; page: string; checkedAt: number | null };
  subjects?: SessionSubject[]; counts?: { exam: number; graded: number; pass: number; coursework: number; none: number };
  /** Факультативы, на которые студент (насколько известно) не записан. */
  optional?: { key: string; index: string | null; name: string; labels: string[] }[];
  /** Вне плана группы на этот семестр: пересдачи, академическая разница, дисциплины только из журнала. */
  extra?: SessionExtra[];
  /** Скрытое самим студентом («не моё») — чтобы можно было вернуть. */
  /** Скрытое студентом; from — где сказал «не моё» последним: здесь ("session") или ответом боту о дисциплине журнала ("bot"). */
  hidden?: { key: string; index: string | null; name: string; labels: string[]; from?: "bot" | "session" }[];
  /** Загружен ли электронный журнал: без него баллов из журнала нет. */
  journal?: { state: "ok" | "need_password" | "rejected" | "not_connected" | "error" | "not_loaded" | "other_semester"; at?: string | null; error?: string | null; semester?: string | null };
  /** Прочитан ли список курсов Moodle (по нему — дисциплины по выбору, академическая разница, пересдачи). */
  moodle?: { state: "ok" | "not_connected" | "not_loaded" };
  /** Сколько дисциплин, где первый порог уже не набрать. */
  risks?: number; journalAt?: string | null; at: number;
}
export interface SessionExtra {
  key: string; name: string; why: "retake" | "earlier" | "journal"; label: string | null; planSemesters: number[] | null; month: string | null;
  inJournal: boolean; score: SessionScore | null; course: { id: number; name: string; url: string } | null; level: "ok" | "red";
}
/** Уточнение самого студента: дисциплина по выбору (value — индекс варианта), факультатив (true/false), «не моё» (true); null — сбросить. */
export type SessionChoice = { kind: "elective"; key: string; value: string | null } | { kind: "optional"; key: string; value: boolean | null } | { kind: "hidden"; key: string; value: true | null };
export const sessionApi = {
  get: () => api<SessionView>("api/session"),
  choose: (c: SessionChoice) => api<SessionView>("api/session/choice", c),
};

/** Числовой id задания Moodle из id дедлайна «moodle:assign:123», иначе null. */
export const assignIdOf = (deadlineId: string) => deadlineId.match(/^moodle:assign:(\d+)$/)?.[1] ?? null;
