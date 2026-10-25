import type { Section, SourceItem, SpaceData, UniversitySpace } from "../store/platform";
import type { Lesson } from "../store/schedule";
import type { Deadline, Subject } from "../store/types";
import type { AssistantConfig, AssistantContext, CharacterId } from "../theme/assistant-state";
import { SUBJECT_COLORS } from "../theme/subjects";
import { dayKey, mskParts } from "./dates";

/*
 * Адаптер «ответ /api/v1 → то, что рисуют экраны» (DES-010). Чистые функции: без сторов, сети и Date.now() — время
 * приходит параметром. Экранные типы (Deadline, Lesson, Subject) те же, что у прежних экранов, поэтому строки дедлайнов
 * и пар переиспользуются. Идентификаторы с префиксом вуза: одинаковый внешний ID в двух вузах не смешивается.
 */

/** ВШЭ — ворона Варя, остальные (МИСИС и любые новые вузы) — сова Дуся. */
export function characterFor(space: Pick<UniversitySpace, "universityId" | "name">): CharacterId {
  return /\bhse\b|вшэ|вышк|высшая школа экономики/i.test(`${space.universityId} ${space.name}`) ? "varya" : "dusya";
}

export function assistantConfig(spaces: readonly UniversitySpace[]): AssistantConfig {
  return { spaces: Object.fromEntries(spaces.map((s) => [s.id, { title: s.name, character: characterFor(s) }])) };
}

const ms = (iso?: string) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const itemId = (spaceId: string, it: SourceItem) => `space:${spaceId}:${it.connectionId}:${it.id}`;
const courseKey = (spaceId: string, it: Pick<SourceItem, "connectionId" | "courseId">) =>
  it.courseId ? `space:${spaceId}:${it.connectionId}:course:${it.courseId}` : `space:${spaceId}:other`;

/** Сокращение для строк списка: «Математический анализ» → «МА». */
export const shortName = (title: string) => {
  const words = title.replace(/[«»"()]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const s = words.slice(0, 3).map((w) => w[0].toUpperCase()).join("");
  return s || title.slice(0, 3);
};

export function toSubjects(spaceId: string, courses: Section | null): Subject[] {
  return (courses?.items ?? []).map((c, i) => ({
    id: courseKey(spaceId, { connectionId: c.connectionId, courseId: c.courseId ?? c.externalId }),
    name: c.title, short: shortName(c.title), color: SUBJECT_COLORS[i % SUBJECT_COLORS.length],
  }));
}

/** Работы со сроком — как дедлайны прежних экранов (только чтение: сдают их на сайте вуза). Без срока — не здесь. */
export function toDeadlines(spaceId: string, section: Section | null): Deadline[] {
  return (section?.items ?? []).flatMap((it) => {
    const due = ms(it.dueAt);
    if (due === null) return [];
    return [{
      id: itemId(spaceId, it), title: it.title, subjectId: courseKey(spaceId, it), kind: "other" as const, due,
      status: "open" as const, note: "", subtasks: [], reminder: "none" as const, source: "moodle" as const, url: it.url,
    }];
  });
}

const hhmm = (t: number) => { const p = mskParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };

export function toLessons(section: Section | null): Lesson[] {
  return (section?.items ?? []).flatMap((it) => {
    const start = ms(it.startsAt);
    if (start === null) return [];
    const end = ms(it.endsAt) ?? start;
    return [{ date: dayKey(start), start: hhmm(start), end: hhmm(end), name: it.title, type: "other" as const, typeLabel: "", teacher: "", place: it.location ?? "", subgroup: "" }];
  }).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/** Все подключения вуза (каждый раздел ответа несёт их список; берём первый непустой). */
export const connectionsOf = (d: SpaceData | null) =>
  d?.deadlines?.connections ?? d?.schedule?.connections ?? d?.courses?.connections ?? [];

/** Свежесть: время последнего полного снимка и есть ли устаревшие (старше суток — так решает сервер). */
export function freshness(d: SpaceData | null): { updatedAt: number | null; stale: boolean } {
  const sources = [d?.deadlines, d?.schedule, d?.courses].flatMap((s) => s?.sources ?? []);
  const times = sources.map((s) => ms(s.fetchedAt)).filter((t): t is number => t !== null);
  return { updatedAt: times.length ? Math.max(...times) : null, stale: sources.some((s) => s.stale) };
}

/** Контекст маскота для активного вуза. Ошибка доступа и загрузка видны отдельно; старые данные остаются снимком. */
export function toAssistantContext(
  space: UniversitySpace,
  d: SpaceData | null,
  env: { nowMs: number; reducedMotion: boolean; lite: boolean; visible: boolean; acknowledged: readonly string[] },
): AssistantContext {
  const own = d && d.spaceId === space.id ? d : null;
  const connections = connectionsOf(own);
  const fresh = freshness(own);
  const loaded = !!own?.deadlines;

  let availability: AssistantContext["availability"] = "ready";
  let activity: AssistantContext["activity"] = "idle";
  if (!own || (!loaded && own.status === "loading")) { availability = "unknown"; activity = "syncing"; }
  else if (own.error) availability = own.error.kind === "offline" ? "offline" : "error";
  else if (loaded && connections.length === 0) availability = "empty";
  else if (connections.some((c) => c.status === "user_action_required")) availability = "reauth";
  else if (connections.length && connections.every((c) => c.status === "error")) availability = "error";
  if (availability === "ready" && (own?.status === "loading" || connections.some((c) => c.status === "pending"))) activity = "syncing";

  return {
    spaceId: space.id,
    nowMs: env.nowMs,
    timeZone: "Europe/Moscow",
    availability,
    activity,
    snapshot: loaded ? {
      spaceId: space.id,
      updatedAt: fresh.updatedAt ?? own!.loadedAt ?? env.nowMs,
      stale: fresh.stale || !!own!.error,
      deadlines: own!.deadlines!.items.map((it) => ({ id: itemId(space.id, it), title: it.title, dueMs: ms(it.dueAt), done: false })),
    } : null,
    recentEvent: null,
    acknowledgedEventIds: env.acknowledged,
    preferences: { seasonal: true, motion: "system" },
    reducedMotion: env.reducedMotion,
    lite: env.lite,
    visible: env.visible,
  };
}
