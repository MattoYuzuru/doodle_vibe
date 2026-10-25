import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useNav } from "../hooks/useNav";
import { nextSubjectColor } from "../theme/subjects";
import { API_TIMEOUT_MS, apiHeaders } from "./api";
import { useAuth } from "./auth";
import { CHECKED, createCloudRepository } from "./cloudRepo";
import { usePlatform } from "./platform";
import { useJournal } from "./journal";
import type { Repository } from "./repository";
import { useSchedule } from "./schedule";
import { seedData } from "./seed";
import { useSession } from "./session";
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
/** Сервер отдал копию, потому что Moodle не успел (stale без moodle.down): спросить снова через столько, не больше стольких раз подряд. */
const STALE_RETRY_MS = 25_000, STALE_RETRIES = 3;
/**
 * Пришедшие данные, совпавшие с тем, что уже в сторе, — прежней ссылкой (проверка 15 окт): облако и Moodle каждый раз
 * отдают новые массивы, и без этого все три вкладки (подписки по полям) пересчитывались на каждое «потянуть вниз».
 */
const same = <T,>(prev: T, next: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next);

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
 * at — когда сервер прочитал показанные данные из Moodle (updated ответа); down — Moodle сейчас не отвечает (сбой сети
 * МИСИС или техработы): приложение показывает прежние данные и плашку, since — с какого времени, если сервер это знает.
 */
export interface MoodleState { status: "idle" | "loading" | "ok" | "error"; at?: number; error?: string; down?: { since: number | null; reason: "network" | "maintenance" | "blocked" } | null }
/** Ошибка синхронизации — это сбой самого Moodle (а не сервера бота или входа)? */
const OUTAGE = /Moodle не отвечает|Moodle ответил не данными|Moodle отклонил запрос|техработ/i;

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

/** Слияние с копией с сервера: что есть в приложении — остаётся, чего нет (по id) — добавляется из копии. Ничего не удаляется. */
function mergeCopy(cur: AppData, copy: AppData): AppData {
  const byId = <T extends { id: Id }>(mine: T[], theirs: T[]) => { const have = new Set(mine.map((x) => x.id)); return [...mine, ...theirs.filter((x) => !have.has(x.id))]; };
  return {
    subjects: byId(cur.subjects, copy.subjects), deadlines: byId(cur.deadlines, copy.deadlines), tasks: byId(cur.tasks, copy.tasks), notes: byId(cur.notes, copy.notes),
    settings: { ...copy.settings, ...cur.settings, hiddenMoodleIds: [...new Set([...cur.settings.hiddenMoodleIds, ...copy.settings.hiddenMoodleIds])] },
  };
}

export const useAppStore = create<State>((set, get) => {
  /*
   * Копия личных данных на сервере (cloud-backup.mjs; 5 окт 2026, переезд на нового бота): свои дедлайны, предметы,
   * задачи и настройки живут в облаке Telegram, а оно у каждого бота своё. Приложение шлёт копию на сервер сразу после
   * запуска, через пару секунд после любого изменения и при сворачивании. В хранилище бота стоит отметка CHECKED —
   * «сверено с копией на сервере». Пока её нет (первый запуск в этом боте), приложение спрашивает у сервера копию и
   * сливает её со своими данными; отметка ставится только после ответа сервера и записи всех коллекций. Нет связи —
   * отметки нет, копию на сервере не трогаем (backupOk = false) и спрашиваем снова при следующем запуске: так состояние
   * «только Moodle» не затрёт настоящую копию.
   */
  let backupOk = false, backupTimer: ReturnType<typeof setTimeout> | undefined, lastSent = "";
  const sendBackup = (keepalive = false) => {
    clearTimeout(backupTimer);
    if (!backupOk || DEMO || EMPTY || !repo) return;
    const s = get();
    const body = JSON.stringify({ subjects: s.subjects, deadlines: s.deadlines, tasks: s.tasks, notes: s.notes, settings: s.settings });
    if (body === lastSent) return;
    const was = lastSent;
    lastSent = body;
    // keepalive — запрос доживёт до конца, даже если приложение закрывают (браузер разрешает так только небольшие тела).
    void fetch("api/cloud", { method: "POST", headers: { "content-type": "application/json", ...apiHeaders() }, body, keepalive: keepalive && body.length < 60_000, signal: keepalive ? undefined : AbortSignal.timeout(API_TIMEOUT_MS) })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); })
      .catch(() => { if (lastSent === body) lastSent = was; /* сеть: уйдёт после следующего изменения */ });
  };
  const scheduleBackup = () => { clearTimeout(backupTimer); backupTimer = setTimeout(() => sendBackup(), 2000); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") sendBackup(true); });
  const persist = (c: Collection) => { void repo?.save(c, get()[c]).catch(() => { /* сеть: сохранится при следующем изменении */ }); scheduleBackup(); };
  const patch = <C extends Collection>(c: C, items: AppData[C]) => { set({ [c]: items } as Partial<State>); persist(c); };
  /*
   * Копия вместо свежих данных (15 окт 2026, NOTES п. 141): Moodle или очередь сервера не ответили за ~6 с (например,
   * сразу после перезапуска сервера), и он отдал прочитанное раньше — stale без moodle.down. Чтение на сервере тем временем
   * идёт; спрашиваем ещё раз через STALE_RETRY_MS, не больше STALE_RETRIES раз подряд. Счёт — заново после свежего ответа
   * и после «Обновить». При сбое Moodle (есть moodle.down) не повторяем: раз в минуту опрашивает плашка MoodleDown.
   */
  let staleTimer: ReturnType<typeof setTimeout> | undefined, staleTries = 0;
  const retryIfStale = (stale: boolean) => {
    if (!stale) { staleTries = 0; return; }
    if (staleTries >= STALE_RETRIES) return;
    staleTries++;
    staleTimer = setTimeout(() => void get().syncMoodle(false), STALE_RETRY_MS);
  };

  async function loadAll(): Promise<AppData> {
    if (EMPTY) return EMPTY_DATA;
    if (DEMO || !repo) return seedData();
    const data = await repo.load().catch(() => repo.loadCached());
    let cur = data ? normalize(data) : EMPTY_DATA;
    if (await repo.flag(CHECKED).catch(() => false)) backupOk = true;
    else {
      try {
        // Короткий срок: пока идёт этот запрос, новый пользователь видит заготовку экрана.
        const res = await fetch("api/cloud", { headers: apiHeaders(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`ошибка ${res.status}`);
        const r = (await res.json()) as { backup: { at: number; data: AppData } | null };
        if (r.backup?.data) cur = mergeCopy(cur, normalize(r.backup.data));
        backupOk = true;
        // Отметка — последней, после записи всех коллекций: недописанное хранилище не должно считаться сверенным.
        const merged = cur;
        void Promise.all(COLLECTIONS.map((c) => repo.save(c, merged[c]))).then(() => repo.setFlag(CHECKED)).catch(() => { /* спросим копию ещё раз при следующем запуске */ });
      } catch { /* сервер не ответил — работаем с тем, что есть; копию на сервере не трогаем */ }
    }
    // Копия уходит сразу после запуска (а не только после синхронизации с Moodle): приложение могут закрыть через пару секунд.
    scheduleBackup(); // через пару секунд: к этому времени данные уже лежат в сторе
    return cur;
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
      // С новым backend (DES-010) данные вузов грузит store/platform: старых маршрутов Moodle там нет.
      if (prof?.loggedIn && !prof.platformApi) { if (!known) void useSchedule.getState().load(false); void get().syncMoodle(false, pre); }
    },
    async refresh() {
      // Повторный рывок «потянуть вниз», пока обновление ещё идёт, второго не запускает (проверка 15 окт).
      if (get().refreshing) return;
      if (useAuth.getState().profile?.platformApi) {
        set({ refreshing: true });
        try { await usePlatform.getState().reload(); } finally { set({ refreshing: false }); }
        return;
      }
      set({ refreshing: true });
      // Журнал и «Сессия» — только когда открыта их вкладка: журнал с ?refresh ходит в ej.misis.ru, и дёргать его
      // каждым рывком на Главной незачем. Не ждём: у них свой значок обновления в шапке вкладки.
      const nav = useNav.getState();
      if (nav.tab === "journal") void (nav.journalView === "journal" ? useJournal.getState().load(true) : useSession.getState().load());
      try {
        const data = await loadAll(), cur = get();
        set(Object.fromEntries(COLLECTIONS.map((c) => [c, same(cur[c], data[c])])) as Partial<State>);
        await Promise.all([get().syncMoodle(true), useSchedule.getState().load(true)]);
      } finally {
        set({ refreshing: false }); // иначе при сбое refreshing залип бы, и обновление больше не запускалось
      }
    },

    /**
     * Синхронизация с Moodle через server.mjs на ПК: курсы становятся предметами, задания и тесты — дедлайнами
     * (source: "moodle"). Свои дедлайны, задачи и заметки не трогаем; отметку «сдано», поставленную вручную, сохраняем;
     * удалённые пользователем дедлайны Moodle держим в settings.hiddenMoodleIds и не возвращаем.
     */
    async syncMoodle(force = false, pre) {
      if (DEMO || EMPTY) return;
      // Отложенный повтор отменяем: решит ответ на этот запрос.
      clearTimeout(staleTimer);
      if (force) staleTries = 0;
      set({ moodle: { ...get().moodle, status: "loading" } });
      try {
        const r = await (pre ?? fetch(`api/deadlines${force ? "?refresh" : ""}`, { headers: apiHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
        const j = await r.json().catch(() => ({}));
        // Не вошёл (или сервер снял вход: токен Moodle перестал действовать) — обновляем профиль, и App покажет экран входа.
        if (r.status === 401) { set({ moodle: { status: "idle" } }); void useAuth.getState().load(); return; }
        if (!r.ok) throw new Error(j.error === "forbidden" ? "нет доступа" : j.error || `ошибка ${r.status}`);
        const data = j as MoodleResponse;
        const st = get();
        // Moodle не отвечает, сервер отдал последние загруженные данные: показываем их и плашку о сбое.
        const down = data.stale && data.moodle?.down ? { since: data.moodle.since ?? st.moodle.down?.since ?? null, reason: data.moodle.reason ?? "network" } : null;
        // Данные старше уже слитых (запоздавший ответ, когда «Обновить» уже принесло новые) не сливаем — назад не откатываемся.
        // Состояние Moodle (down) из ответа берём: сервер узнал его только что.
        if (st.moodle.at && data.updated < st.moodle.at) {
          set({ moodle: { status: "ok", at: st.moodle.at, down } });
          retryIfStale(!!data.stale && !down);
          return;
        }
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
        // Время — когда сервер прочитал эти данные из Moodle, и для свежих тоже: они бывают из кэша сервера, не этой минуты.
        set({
          subjects: same(st.subjects, subjects), deadlines: same(st.deadlines, merged), tasks: same(st.tasks, tasks), notes: same(st.notes, notes), settings: same(st.settings, settings),
          moodle: { status: "ok", at: data.updated, down }, pendingCourses: same(st.pendingCourses, data.pendingCourses ?? []),
        });
        COLLECTIONS.forEach(persist);
        retryIfStale(!!data.stale && !down);
      } catch (e) {
        const msg = (e as Error).message;
        // Сбой самого Moodle (у сервера нет даже прежних данных — например, после перезапуска): та же плашка, данные — из копии в телефоне.
        const down = OUTAGE.test(msg) ? { since: get().moodle.down?.since ?? Date.now(), reason: /отклонил/i.test(msg) ? "blocked" as const : /не данными|техработ/i.test(msg) ? "maintenance" as const : "network" as const } : null;
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

/**
 * Первая загрузка из Moodle (проверка 15 окт): пока данных Moodle ещё нет (moodle.at пуст) и нет ни одного дедлайна,
 * «Все сроки закрыты» — неправда. pending — загрузка идёт: вместо пустого состояния скелетон; failed — не удалась
 * (синхронизация с ошибкой или сервер не отдал профиль, и синхронизация не начиналась): плитка с «Повторить».
 * С ?demo и ?empty Moodle не опрашивается — там пустое состояние настоящее. idle без ошибки профиля — синхронизация
 * ещё не стартовала (init сначала ждёт профиль и облако Telegram, 1–3 с): это тоже ожидание, а не «Все сроки закрыты».
 */
export function useFirstLoad() {
  const authErr = useAuth((s) => s.status === "error");
  return useAppStore(useShallow((s) => {
    const noData = !DEMO && !EMPTY && s.deadlines.length === 0 && !s.moodle.at;
    const pending = noData && (s.moodle.status === "loading" || s.refreshing || (s.moodle.status === "idle" && !authErr));
    const failed = noData && !pending && (s.moodle.status === "error" || (authErr && s.moodle.status === "idle"));
    return { pending, failed };
  }));
}

/** «Повторить» после неудачной первой загрузки: профиль (без него нет расписания) и обновление всего, параллельно. */
export function retryFirstLoad() {
  void useAuth.getState().load();
  void useAppStore.getState().refresh();
}
