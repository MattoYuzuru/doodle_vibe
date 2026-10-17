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
  const r = await fetch(apiBase() + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...apiHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
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
  /** Вход MISIS ID истёк — нужен пароль один раз. */
  needPassword?: boolean;
  at: number | null;
  error: string | null;
  /** Почта MISIS ID (она же логин Moodle). */
  email: string | null;
  data: EjData | null;
  /** Журнал не ответил при этой загрузке: data — последние удачные данные (если были), здесь — причина. */
  loadError?: string | null;
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
  summary: { attendance: number | null; rating: number | null; absences: number; missedHours: number };
  subjects: EjSubject[];
}
export const ejApi = {
  get: (refresh = false) => api<EjState>(`api/ej${refresh ? "?refresh" : ""}`),
  connect: (password: string) => api<EjState>("api/ej/connect", { password }),
};

/** Числовой id задания Moodle из id дедлайна «moodle:assign:123», иначе null. */
export const assignIdOf = (deadlineId: string) => deadlineId.match(/^moodle:assign:(\d+)$/)?.[1] ?? null;
