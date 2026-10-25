import { urgencyOf } from "./urgency";

/*
 * Логика маскота без отрисовки (DES-004, 25 окт 2026): контекст приложения → что маскот показывает и говорит.
 * Чистая функция: время, пространство, доступность и настройки движения приходят явно; нет запросов, сторов, DOM,
 * localStorage, Date.now() и случайности — при одних входах один результат. Пороги срочности и полночь берутся из
 * общей логики (urgency.ts → effectiveDue), здесь они не дублируются.
 * Маскот зависит от вуза: в МИСИС — сова Дуся, в ВШЭ — ворона Варя. Отрисовка (DES-005) и сезонные образы (DES-007)
 * живут отдельно и получают уже готовое представление.
 */

export type CharacterId = "dusya" | "varya";

export type AssistantDeadline = { id: string; title: string; dueMs: number | null; done: boolean };

export type AssistantContext = {
  spaceId: string;
  nowMs: number;
  timeZone: string;
  availability: "ready" | "unknown" | "empty" | "offline" | "reauth" | "error";
  activity: "idle" | "connecting" | "syncing" | "thinking";
  snapshot: {
    spaceId: string;
    updatedAt: number;
    stale: boolean;
    deadlines: readonly AssistantDeadline[];
  } | null;
  recentEvent: { id: string; spaceId: string; kind: "deadline-completed"; at: number } | null;
  /** Реакции, которые frontend уже показал в этом пространстве: после reload они не проигрываются снова. */
  acknowledgedEventIds?: readonly string[];
  preferences: { seasonal: boolean; motion: "system" | "calm" };
  reducedMotion: boolean;
  lite: boolean;
  visible: boolean;
};

/** Первичный статус: ровно один на экран, по приоритету ошибка → операция → срочная работа → реакция → обычный контекст. */
export type AssistantStatus =
  | "reauth" | "error" | "offline"
  | "connecting" | "syncing" | "thinking"
  | "urgent" | "overdue"
  | "completed"
  | "soon" | "ready" | "empty" | "unknown";

/** Срочность выбранной работы. unknown — открытые работы есть, но ни у одной нет срока; none — открытых работ нет. */
export type UrgencyLevel = "urgent" | "overdue" | "soon" | "calm" | "unknown" | "none";

export type AssistantIntent = "open-deadline" | "open-source" | "open-chat" | "reauth" | "retry" | "connect";

export type AssistantPresentation = {
  spaceId: string;
  character: CharacterId;
  status: AssistantStatus;
  /** Сводка по работам из снимка этого пространства; null — снимка нет. При ошибке или операции показывается бейджем. */
  urgency: {
    level: UrgencyLevel;
    deadlineId: string | null;
    title: string | null;
    dueMs: number | null;
    /** Сколько открытых работ того же уровня (несколько срочных → одна выбранная и счётчик). */
    count: number;
    stale: boolean;
    updatedAt: number;
  } | null;
  /** Акцент поверх позы: огонь только у срочной работы, тёплый — у «скоро»; просрочка без бесконечной паники. */
  accent: "fire" | "warm" | "none";
  text: string;
  action: { intent: AssistantIntent; label: string; deadlineId?: string } | null;
  /** Короткая реакция на подтверждённую сдачу; null — нечего проигрывать. */
  reaction: { eventId: string } | null;
  /** full — обычная анимация, static — та же информация без движения, paused — вкладка скрыта. */
  motion: "full" | "static" | "paused";
};

export type AssistantSpace = { title: string; character: CharacterId };
export type AssistantConfig = { spaces: Readonly<Record<string, AssistantSpace>> };

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  spaces: {
    misis: { title: "МИСИС", character: "dusya" },
    hse: { title: "ВШЭ", character: "varya" },
  },
};
/** Для неизвестного пространства — исходная сова Doodle. */
export const DEFAULT_CHARACTER: CharacterId = "dusya";
/** Реакция на сдачу живёт 1,5 с от события: позже (в том числе после reload) она уже не новая. */
export const REACTION_WINDOW_MS = 1500;

// ---------- выбор работы ----------

type Classified = { d: AssistantDeadline; level: Exclude<UrgencyLevel, "unknown" | "none">; due: number };

const LEVEL_ORDER = ["urgent", "overdue", "soon", "calm"] as const;

function classify(deadlines: readonly AssistantDeadline[], now: number) {
  const dated: Classified[] = [], undated: AssistantDeadline[] = [];
  for (const d of deadlines) {
    if (d.done) continue;
    if (d.dueMs === null || !Number.isFinite(d.dueMs)) { undated.push(d); continue; }
    const u = urgencyOf({ due: d.dueMs, status: "open" }, now);
    if (u !== "done") dated.push({ d, level: u, due: d.dueMs });
  }
  return { dated, undated };
}

const byId = (a: AssistantDeadline, b: AssistantDeadline) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Срочная, «скоро» и спокойная — ближайшая по сроку; просроченная — самая свежая просрочка. Равные сроки — по ID. */
function pick(list: Classified[]): Classified {
  return [...list].sort((a, b) => (a.level === "overdue" ? b.due - a.due : a.due - b.due) || byId(a.d, b.d))[0];
}

function summarize(snapshot: NonNullable<AssistantContext["snapshot"]>, now: number): NonNullable<AssistantPresentation["urgency"]> {
  const { dated, undated } = classify(snapshot.deadlines, now);
  const base = { stale: snapshot.stale, updatedAt: snapshot.updatedAt };
  for (const level of LEVEL_ORDER) {
    const same = dated.filter((c) => c.level === level);
    if (!same.length) continue;
    const top = pick(same);
    return { ...base, level, deadlineId: top.d.id, title: top.d.title, dueMs: top.d.dueMs, count: same.length };
  }
  if (undated.length) {
    const top = [...undated].sort(byId)[0];
    return { ...base, level: "unknown", deadlineId: top.id, title: top.title, dueMs: null, count: undated.length };
  }
  return { ...base, level: "none", deadlineId: null, title: null, dueMs: null, count: 0 };
}

// ---------- реплики ----------

type Say = { space: string | null; title: string; count: number };
type Phrasebook = Record<AssistantStatus, (s: Say) => string> & { clear: () => string; undated: (s: Say) => string };

const inSpace = (s: Say) => (s.space ? ` в ${s.space}` : "");
const who = (s: Say) => s.space ?? "Сайт вуза";
const more = (s: Say) => (s.count > 1 ? ` И ещё ${s.count - 1} рядом по сроку.` : "");

const shared = {
  error: () => "Не получилось обновить данные. Показываю то, что было в прошлый раз.",
  offline: () => "Нет связи с сайтом вуза. Данные могут быть устаревшими.",
  syncing: () => "Обновляю сроки и расписание…",
  thinking: (s: Say) => `Ищу${inSpace(s)}…`,
  overdue: (s: Say) => `Срок «${s.title}» прошёл. Открой работу и посмотри, что можно сделать.${more(s)}`,
  ready: (s: Say) => `Срочного нет. Ближайшая работа — «${s.title}».`,
  unknown: () => "Смотрю, что нового…",
  undated: (s: Say) => `У работы «${s.title}» не указан срок.`,
};

const PHRASES: Record<CharacterId, Phrasebook> = {
  dusya: {
    ...shared,
    reauth: (s) => `${who(s)} просит войти заново. Пока показываю то, что было.`,
    connecting: (s) => `Подключаю учёбу${inSpace(s)}…`,
    urgent: (s) => `«${s.title}» — осталось меньше суток.${more(s)}`,
    completed: () => "Ух! Сдано. Горжусь.",
    soon: (s) => `«${s.title}» — срок через пару дней. Можно начать заранее.${more(s)}`,
    empty: () => "Пока ничего не подключено. Подключи сайт вуза, и я соберу сроки и пары.",
    clear: () => "Открытых работ нет. Можно выдохнуть.",
  },
  varya: {
    ...shared,
    reauth: (s) => `${who(s)} просит войти заново. Пока держу в гнезде то, что было.`,
    connecting: (s) => `Тащу в гнездо учёбу${inSpace(s)}…`,
    urgent: (s) => `Кар! «${s.title}» — осталось меньше суток.${more(s)}`,
    completed: () => "Кар! Сдано. Утащила в гнездо.",
    soon: (s) => `«${s.title}» — срок через пару дней. Начнём заранее?${more(s)}`,
    empty: () => "Гнездо пустое. Скинь ссылку на LMS, и я перетащу туда сроки и пары.",
    clear: () => "Открытых работ нет. Кар — это от радости.",
  },
};

const STALE_NOTE = " Данные могли устареть.";

// ---------- главное ----------

export function resolveAssistantPresentation(
  ctx: AssistantContext,
  config: AssistantConfig = DEFAULT_ASSISTANT_CONFIG,
): AssistantPresentation {
  const space = config.spaces[ctx.spaceId] ?? null;
  const character = space?.character ?? DEFAULT_CHARACTER;
  const phrases = PHRASES[character];

  // Данные другого пространства (после переключения вуза, до нового снимка) не попадают ни в текст, ни в реакцию.
  const snapshot = ctx.snapshot && ctx.snapshot.spaceId === ctx.spaceId ? ctx.snapshot : null;
  const urgency = snapshot ? summarize(snapshot, ctx.nowMs) : null;

  const event = ctx.recentEvent;
  const freshEvent = !!event && event.spaceId === ctx.spaceId && event.kind === "deadline-completed"
    && ctx.nowMs - event.at >= 0 && ctx.nowMs - event.at <= REACTION_WINDOW_MS
    && !(ctx.acknowledgedEventIds ?? []).includes(event.id);

  const say: Say = { space: space?.title ?? null, title: urgency?.title ?? "", count: urgency?.count ?? 0 };
  const openDeadline = (label: string) =>
    urgency?.deadlineId ? { intent: "open-deadline" as const, label, deadlineId: urgency.deadlineId } : null;

  let status: AssistantStatus;
  let action: AssistantPresentation["action"] = null;
  let text: string;

  const a = ctx.availability;
  if (a === "reauth") { status = "reauth"; action = { intent: "reauth", label: "Войти снова" }; }
  else if (a === "error") { status = "error"; action = { intent: "retry", label: "Повторить" }; }
  else if (a === "offline") { status = "offline"; action = { intent: "retry", label: "Повторить" }; }
  else if (ctx.activity === "connecting") status = "connecting";
  else if (ctx.activity === "syncing") status = "syncing";
  else if (ctx.activity === "thinking") { status = "thinking"; action = { intent: "open-chat", label: "К чату" }; }
  else if (a === "empty") { status = "empty"; action = { intent: "connect", label: "Подключить учёбу" }; }
  else if (!urgency) status = "unknown"; // данных этого вуза ещё нет: не «всё сдано»
  else if (urgency.level === "urgent") { status = "urgent"; action = openDeadline("Открыть работу"); }
  else if (urgency.level === "overdue") { status = "overdue"; action = openDeadline("Открыть работу"); }
  else if (freshEvent) { status = "completed"; action = openDeadline("Следующая работа"); }
  else if (urgency.level === "soon") { status = "soon"; action = openDeadline("Открыть работу"); }
  else { status = "ready"; action = openDeadline("Открыть работу"); }

  if (status === "ready" && urgency?.level === "none") text = phrases.clear();
  else if (status === "ready" && urgency?.level === "unknown") text = phrases.undated(say);
  else text = phrases[status](say);
  if (urgency?.stale && ["urgent", "overdue", "soon", "ready", "completed"].includes(status)) text += STALE_NOTE;

  // Праздник не перекрывает ошибки и операции; рядом со срочной работой он короткий и второстепенный.
  const blocked = ["reauth", "error", "offline", "connecting", "syncing", "thinking", "empty", "unknown"].includes(status);
  const reaction = freshEvent && !blocked ? { eventId: event!.id } : null;

  const motion = !ctx.visible ? "paused"
    : ctx.reducedMotion || ctx.lite || ctx.preferences.motion === "calm" ? "static"
    : "full";

  return {
    spaceId: ctx.spaceId,
    character,
    status,
    urgency,
    accent: status === "urgent" ? "fire" : status === "soon" ? "warm" : "none",
    text,
    action,
    reaction,
    motion,
  };
}
