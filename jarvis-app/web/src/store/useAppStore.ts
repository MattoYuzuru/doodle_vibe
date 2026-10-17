import { create } from "zustand";
import { nextSubjectColor } from "../theme/subjects";
import { API_TIMEOUT_MS, apiHeaders } from "./api";
import { useAuth } from "./auth";
import { createCloudRepository } from "./cloudRepo";
import type { Repository } from "./repository";
import { useSchedule } from "./schedule";
import { seedData } from "./seed";
import type { AppData, Collection, Deadline, Id, MoodleResponse, Note, PendingCourse, Settings, Task } from "./types";

// Параметры адреса для проверки дизайна вне Telegram:
//   ?demo  — всегда тестовые данные, ничего не сохраняется и Moodle не опрашивается;   ?empty — пустые данные;
//   ?slow=1500 — задержка загрузки (посмотреть скелетоны).
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const EMPTY = params.has("empty");
const SLOW = Number(params.get("slow") || 0);

const EMPTY_SETTINGS: Settings = { hiddenMoodleIds: [] };
const EMPTY_DATA: AppData = { subjects: [], deadlines: [], tasks: [], notes: [], settings: EMPTY_SETTINGS };
const COLLECTIONS: Collection[] = ["subjects", "deadlines", "tasks", "notes", "settings"];
// Идентификаторы тестовых данных первого запуска: убираем при первой успешной синхронизации с Moodle.
const SEED_IDS = new Set(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "t1", "t2", "t3", "t4", "t5", "n1", "n2", "n3", "n4", "os", "oksp", "py", "ce", "mips"]);
const repo: Repository | null = DEMO || EMPTY ? null : createCloudRepository();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Настройки напоминаний по дедлайнам Moodle → сервер (reminders.json), который шлёт их в Telegram. */
async function pushReminders(deadlines: Deadline[]) {
  const prefs = Object.fromEntries(deadlines.filter((d) => d.id.startsWith("moodle:")).map((d) => [d.id, d.reminder]));
  try {
    await fetch("api/reminders", { method: "POST", headers: { "content-type": "application/json", ...apiHeaders() }, body: JSON.stringify(prefs), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch { /* ПК недоступен: отправим при следующем изменении */ }
}

/** Короткое имя предмета для строк списка: до 16 символов как есть, иначе инициалы значимых слов. */
export function shortSubjectName(name: string) {
  const n = name.trim();
  if (n.length <= 16) return n;
  const words = n.split(/\s+/).filter((w) => w.length > 2 && !/^(и|на|по|для|в|из)$/i.test(w));
  return words.slice(0, 4).map((w) => w[0].toUpperCase()).join("") || n.slice(0, 16);
}

/** Приводим данные из хранилища к текущей модели (поля, появившиеся позже). */
function normalize(data: AppData): AppData {
  return {
    ...EMPTY_DATA,
    ...data,
    deadlines: (data.deadlines ?? []).map((d) => ({ ...d, kind: d.kind ?? "lab", subtasks: d.subtasks ?? [], note: d.note ?? "" })),
    settings: { ...EMPTY_SETTINGS, ...(data.settings ?? {}) },
  };
}

/**
 * at — когда данные Moodle последний раз были свежими; down — Moodle сейчас не отвечает (сбой сети МИСИС или техработы):
 * приложение показывает прежние данные и плашку, since — с какого времени, если сервер это знает.
 */
export interface MoodleState { status: "idle" | "loading" | "ok" | "error"; at?: number; error?: string; down?: { since: number | null; reason: "network" | "maintenance" } | null }
/** Ошибка синхронизации — это сбой самого Moodle (а не сервера бота или входа)? */
const OUTAGE = /Moodle не отвечает|Moodle ответил не данными|техработ/i;

interface State extends AppData {
  status: "loading" | "ready";
  refreshing: boolean;
  moodle: MoodleState;
  /** Курсы, про которые сервер просит уточнить «это ваш курс сейчас?» (не сохраняется, приходит с каждой синхронизацией). */
  pendingCourses: PendingCourse[];
  init(): Promise<void>;
  refresh(): Promise<void>;
  /** pre — уже начатый запрос api/deadlines (при запуске он идёт параллельно с облаком). */
  syncMoodle(force?: boolean, pre?: Promise<Response>): Promise<void>;

  toggleTask(id: Id): void;
  addTask(t: Omit<Task, "id" | "createdAt" | "done">): void;
  updateTask(id: Id, patch: Partial<Task>): void;
  deleteTask(id: Id): void;

  addDeadline(d: Omit<Deadline, "id">): Id;
  updateDeadline(id: Id, patch: Partial<Deadline>): void;
  deleteDeadline(id: Id): void;
  addSubject(name: string, color: string): Id;

  saveNote(n: Partial<Note> & { title: string; body: string }): Id;
  deleteNote(id: Id): void;
}

export const useAppStore = create<State>((set, get) => {
  const persist = (c: Collection) => { void repo?.save(c, get()[c]).catch(() => { /* сеть: сохранится при следующем изменении */ }); };
  const patch = <C extends Collection>(c: C, items: AppData[C]) => { set({ [c]: items } as Partial<State>); persist(c); };

  async function loadAll(): Promise<AppData> {
    if (EMPTY) return EMPTY_DATA;
    if (DEMO || !repo) return seedData();
    const data = await repo.load().catch(() => repo.loadCached());
    return data ? normalize(data) : EMPTY_DATA;
  }

  return {
    ...EMPTY_DATA,
    status: "loading",
    refreshing: false,
    moodle: { status: "idle" },
    pendingCourses: [],

    async init() {
      // Первый кадр — из локальной копии, сразу. Облако, Moodle и расписание догружаются параллельно.
      const cached = !SLOW && repo?.loadCached();
      if (cached) set({ ...normalize(cached), status: "ready" });
      if (SLOW) await sleep(SLOW);
      // Профиль (вошёл ли в Moodle) и облако грузим параллельно, но Moodle сливаем только ПОСЛЕ того, как облако легло
      // в стор: иначе запоздавший ответ облака затирал свежие предметы и дедлайны Moodle («Без предмета» у части работ).
      // Сами запросы расписания и дедлайнов при сохранённом профиле стартуют сразу, не дожидаясь облака и профиля.
      const known = !DEMO && !EMPTY && useAuth.getState().profile?.loggedIn;
      if (known) void useSchedule.getState().load(false);
      const pre = known ? fetch("api/deadlines", { headers: apiHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) }) : undefined;
      pre?.catch(() => {}); // ошибку разберёт syncMoodle
      const [prof, data] = await Promise.all([useAuth.getState().load(), loadAll()]);
      set({ ...data, status: "ready" });
      if (prof?.loggedIn) { if (!known) void useSchedule.getState().load(false); void get().syncMoodle(false, pre); }
    },
    async refresh() {
      set({ refreshing: true });
      set({ ...(await loadAll()) });
      await Promise.all([get().syncMoodle(true), useSchedule.getState().load(true)]);
      set({ refreshing: false });
    },

    /**
     * Синхронизация с Moodle через server.mjs на ПК: курсы становятся предметами, задания и тесты — дедлайнами
     * (source: "moodle"). Свои дедлайны, задачи и заметки не трогаем; отметку «сдано», поставленную вручную, сохраняем;
     * удалённые пользователем дедлайны Moodle держим в settings.hiddenMoodleIds и не возвращаем.
     */
    async syncMoodle(force = false, pre) {
      if (DEMO || EMPTY) return;
      set({ moodle: { ...get().moodle, status: "loading" } });
      try {
        const r = await (pre ?? fetch(`api/deadlines${force ? "?refresh" : ""}`, { headers: apiHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
        const j = await r.json().catch(() => ({}));
        // Не вошёл (или сервер снял вход: токен Moodle перестал действовать) — обновляем профиль, и App покажет экран входа.
        if (r.status === 401) { set({ moodle: { status: "idle" } }); void useAuth.getState().load(); return; }
        if (!r.ok) throw new Error(j.error === "forbidden" ? "нет доступа" : j.error || `ошибка ${r.status}`);
        const data = j as MoodleResponse;
        const st = get();
        const settings: Settings = { ...EMPTY_SETTINGS, ...st.settings };
        let { subjects, deadlines, tasks, notes } = st;
        // Демо-данные (seed) вычищаем при КАЖДОМ слиянии, а не по флагу: однажды флаг seedCleared сохранился, а демо-дедлайны
        // вернулись из облака — и висели «Без предмета» (их предметы mips/py/os/… уже удалены).
        subjects = subjects.filter((s) => !SEED_IDS.has(s.id));
        deadlines = deadlines.filter((d) => !SEED_IDS.has(d.id) && !SEED_IDS.has(d.subjectId));
        tasks = tasks.filter((t) => !SEED_IDS.has(t.id));
        notes = notes.filter((n) => !SEED_IDS.has(n.id));
        settings.seedCleared = true;
        // Предметы старых курсов Moodle, которых больше нет в выдаче и на которые никто не ссылается, тоже убираем.
        const liveCourses = new Set(data.courses.map((c) => `course:${c.id}`));
        const referenced = new Set(deadlines.map((d) => d.subjectId));
        subjects = subjects.filter((s) => !s.id.startsWith("course:") || liveCourses.has(s.id) || referenced.has(s.id));
        for (const c of data.courses) {
          const id = `course:${c.id}`;
          const i = subjects.findIndex((s) => s.id === id);
          if (i < 0) subjects.push({ id, name: c.name, short: c.short, color: nextSubjectColor(subjects.map((s) => s.color)) });
          else subjects[i] = { ...subjects[i], name: c.name, short: c.short };
        }
        const hidden = new Set(settings.hiddenMoodleIds);
        const incoming = new Map(data.items.map((it) => [it.id, it]));
        // Диагностика «Без предмета»: что было в сторе до слияния у работ без предмета (id, источник, предмет) — на сервер, в diag/.
        const subjectIds = new Set(subjects.map((s) => s.id));
        const orphans = deadlines.filter((d) => !subjectIds.has(d.subjectId));
        if (orphans.length) {
          void fetch("api/diag", { method: "POST", headers: { "content-type": "application/json", ...apiHeaders() }, signal: AbortSignal.timeout(API_TIMEOUT_MS),
            body: JSON.stringify({ orphans: orphans.slice(0, 40).map((d) => ({ id: d.id, title: d.title.slice(0, 50), subjectId: d.subjectId, source: d.source ?? null, kind: d.kind, status: d.status })), subjects: [...subjectIds] }) }).catch(() => {});
        }
        const isMoodle = (d: Deadline) => d.source === "moodle" || d.id.startsWith("moodle:");
        const merged: Deadline[] = deadlines
          // Дедлайны Moodle, которых больше нет в выдаче (старые курсы, прежняя схема id), убираем — иначе висят без предмета.
          .filter((d) => !isMoodle(d) || incoming.has(d.id))
          .map((d) => {
            const it = incoming.get(d.id);
            if (!it) return d;
            incoming.delete(d.id);
            return { ...d, title: it.title, kind: it.kind, subjectId: `course:${it.courseId}`, due: it.due, opensAt: it.opensAt, url: it.url,
              grade: it.grade ?? null, gradeMax: it.gradeMax ?? null, remarks: it.remarks ?? [], submission: it.submission ?? null, upload: it.upload ?? null,
              status: it.status === "done" ? "done" : d.status };
          });
        for (const it of incoming.values()) {
          if (hidden.has(it.id)) continue;
          merged.push({ id: it.id, title: it.title, kind: it.kind, subjectId: `course:${it.courseId}`, due: it.due, opensAt: it.opensAt, url: it.url,
            grade: it.grade ?? null, gradeMax: it.gradeMax ?? null, remarks: it.remarks ?? [], submission: it.submission ?? null, upload: it.upload ?? null,
            status: it.status, note: "", subtasks: [], reminder: "day", source: "moodle" });
        }
        // Moodle не отвечает, сервер отдал последние загруженные данные: показываем их и плашку о сбое (время данных — прежнее).
        const down = data.stale && data.moodle?.down ? { since: data.moodle.since ?? get().moodle.down?.since ?? null, reason: data.moodle.reason ?? "network" } : null;
        set({ subjects, deadlines: merged, tasks, notes, settings, moodle: { status: "ok", at: data.stale ? data.updated : Date.now(), down }, pendingCourses: data.pendingCourses ?? [] });
        COLLECTIONS.forEach(persist);
      } catch (e) {
        const msg = (e as Error).message;
        // Сбой самого Moodle (у сервера нет даже прежних данных — например, после перезапуска): та же плашка, данные — из копии в телефоне.
        const down = OUTAGE.test(msg) ? { since: get().moodle.down?.since ?? Date.now(), reason: /не данными|техработ/i.test(msg) ? "maintenance" as const : "network" as const } : null;
        set({ moodle: { ...get().moodle, status: "error", down, error: /fetch|network/i.test(msg) ? "Сервер недоступен" : /abort|timeout/i.test(msg) ? "Сервер не ответил вовремя" : msg } });
      }
    },

    toggleTask: (id) => patch("tasks", get().tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t))),
    addTask: (t) => patch("tasks", [...get().tasks, { ...t, id: uid(), done: false, createdAt: Date.now() }]),
    updateTask: (id, p) => patch("tasks", get().tasks.map((t) => (t.id === id ? { ...t, ...p } : t))),
    deleteTask: (id) => patch("tasks", get().tasks.filter((t) => t.id !== id)),

    addDeadline: (d) => { const id = uid(); patch("deadlines", [...get().deadlines, { ...d, id }]); return id; },
    updateDeadline: (id, p) => {
      patch("deadlines", get().deadlines.map((d) => (d.id === id ? { ...d, ...p } : d)));
      // Напоминания по дедлайнам Moodle шлёт сервер на ПК — отправляем ему настройку.
      if (p.reminder && id.startsWith("moodle:")) void pushReminders(get().deadlines);
    },
    deleteDeadline: (id) => {
      if (id.startsWith("moodle:")) patch("settings", { ...get().settings, hiddenMoodleIds: [...new Set([...get().settings.hiddenMoodleIds, id])] });
      patch("deadlines", get().deadlines.filter((d) => d.id !== id));
    },
    addSubject: (name, color) => {
      const id = uid();
      patch("subjects", [...get().subjects, { id, name: name.trim(), short: shortSubjectName(name), color }]);
      return id;
    },

    saveNote: (n) => {
      const id = n.id ?? uid();
      const note: Note = { pinned: false, ...get().notes.find((x) => x.id === id), ...n, id, updatedAt: Date.now() };
      const rest = get().notes.filter((x) => x.id !== id);
      patch("notes", [note, ...rest]);
      return id;
    },
    deleteNote: (id) => patch("notes", get().notes.filter((n) => n.id !== id)),
  };
});

/** Удобные выборки. */
export const subjectOf = (subjects: AppData["subjects"], id: Id) => subjects.find((s) => s.id === id);
