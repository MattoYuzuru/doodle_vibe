export type Id = string;

export interface Subject {
  id: Id;
  name: string;
  /** Короткое имя для строк списка: «ОС», «ОКСП». */
  short: string;
  color: string;
}

export interface Subtask {
  id: Id;
  text: string;
  done: boolean;
}

export type Reminder = "day" | "3h" | "none";

/** Замечание преподавателя по работе: отзыв к оценке (author: null) или запись в «комментариях к ответу» (с автором). */
export interface Remark {
  author: string | null; text: string; at: number | null;
  /** Постоянная метка замечания (сервер различает по ней новые и уже учтённые). */
  key?: string;
  /**
   * Пометка по лабе с агентом; появляется после первого исправления. new — пришло после исправления, агент его ещё не
   * видел; work — у агента, исправленного отчёта пока нет; fixed — учтено в исправленном отчёте.
   */
  state?: "new" | "work" | "fixed";
}
/** Состояние ответа в Moodle: статус (new/draft/submitted/reopened), разрешена ли правка, имена прикреплённых файлов. */
/** Настройки «Ответ в виде файла» задания Moodle (для кнопки «Прикрепить PDF»). */
export interface UploadConfig {
  enabled: boolean;
  /** Сколько файлов можно в ответе; при 1 новый файл встаёт вместо прежнего. */
  maxFiles: number;
  /** Предел размера файла в байтах; 0 — по настройке сайта. */
  maxBytes: number;
  /** Разрешённые типы из Moodle (пусто — любые); pdf — подходит ли PDF. */
  types: string;
  pdf: boolean;
  /** Нужно ли подтверждать заявление «работа выполнена мной» при отправке. */
  statement: boolean;
}

export interface SubmissionState {
  status: string; canEdit: boolean; files: string[];
  /** false — у задания нет черновика: прикреплённый файл сразу считается сданным на проверку. */
  drafts?: boolean;
}

/** Тип работы: лабораторная, тест (в Moodle — quiz), курсовая, экзамен/зачёт, другое. */
export type DeadlineKind = "lab" | "test" | "coursework" | "exam" | "other";

export interface Deadline {
  id: Id;
  /** Сначала код работы: «ЛР2 · Профилирование сервиса». */
  title: string;
  subjectId: Id;
  kind: DeadlineKind;
  /** Срок, мс epoch. */
  due: number;
  /** Для тестов: с какого момента открыт (мс epoch). */
  opensAt?: number;
  /** "done" — отмечено сданным в приложении (в Moodle ничего не отправляется). */
  status: "open" | "done";
  note: string;
  subtasks: Subtask[];
  reminder: Reminder;
  /** Откуда: создан вручную или пришёл из Moodle (на будущее, для API). */
  source: "local" | "moodle";
  /** Ссылка на задание в Moodle (для source: "moodle"). */
  url?: string;
  /** Оценка из Moodle и максимум по заданию (если выставлена). */
  grade?: number | null;
  gradeMax?: number | null;
  /** Замечания преподавателя и состояние ответа в Moodle (для заданий; приходят с каждой синхронизацией). */
  remarks?: Remark[];
  submission?: SubmissionState | null;
  /** Принимает ли задание ответ файлом и с какими ограничениями. */
  upload?: UploadConfig | null;
}

export interface Task {
  id: Id;
  text: string;
  /** День "2026-09-30". */
  date: string;
  /** "10:00" или пусто. */
  time: string;
  done: boolean;
  createdAt: number;
}

export interface Note {
  id: Id;
  title: string;
  body: string;
  pinned: boolean;
  updatedAt: number;
}

export interface Settings {
  /** Дедлайны Moodle, которые пользователь удалил: при синхронизации не возвращаем. */
  hiddenMoodleIds: string[];
  /** Тестовые данные первого запуска уже убраны после первой синхронизации с Moodle. */
  seedCleared?: boolean;
}

export interface AppData {
  subjects: Subject[];
  deadlines: Deadline[];
  tasks: Task[];
  notes: Note[];
  settings: Settings;
}

/**
 * Курс «под вопросом»: по названию он из прошлого семестра, но в нём появилась новая работа со сроком впереди.
 * Сам он в дедлайны не попадает — приложение просит пользователя уточнить (экран «Курсы»).
 */
export interface PendingCourse { id: number; name: string; fullname: string; reason: string; title: string; due: number; section: string | null }

/** Работает ли Moodle, по наблюдениям сервера: network — сеть МИСИС не отвечает, maintenance — отвечает не данными (техработы). */
export interface MoodleHealth { down: boolean; since: number | null; reason: "network" | "maintenance" | null; okAt: number | null }

/** Ответ сервера /api/deadlines. */
export interface MoodleResponse {
  updated: number;
  /** Moodle сейчас не отвечает: это последние загруженные данные (на момент updated), а не свежие. */
  stale?: boolean;
  moodle?: MoodleHealth;
  pendingCourses?: PendingCourse[];
  items: { id: string; kind: DeadlineKind; title: string; courseId: number; due: number; opensAt?: number; url: string; status: "open" | "done"; grade?: number | null; gradeMax?: number | null; remarks?: Remark[]; submission?: SubmissionState; upload?: UploadConfig }[];
  courses: { id: number; name: string; short: string }[];
}

export type Collection = keyof AppData;
