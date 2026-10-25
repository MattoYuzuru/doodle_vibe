import { create } from "zustand";
import type { AuthMethod } from "../lib/sources";
import { API_TIMEOUT_MS, apiBase, apiHeaders } from "./api";

/*
 * Вузы и их данные через новый API (DES-010, 25 окт 2026; backend/contracts.d.ts, docs/backend-api.md). Работает,
 * когда сервер в /api/me сообщает platformApi: "/api/v1" — так отвечает новый backend; старый сервер МИСИС этого поля не
 * знает, и приложение остаётся в прежнем режиме (useAppStore, Moodle).
 * Данные вузов живут только здесь: в useAppStore их не пишем — он копирует свои коллекции в облако Telegram, и данные
 * ВШЭ смешались бы с МИСИС. В памяти — данные только активного вуза; при переключении они сразу сбрасываются, чтобы
 * экран не показывал прежний вуз, пока грузится новый. Ошибка обновления оставляет последние полученные данные.
 */

export type SourceKind = "lms" | "schedule" | "document" | "table" | "website";
export interface UniversitySpace { id: string; universityId: string; name: string; createdAt: string }
export interface Connection {
  id: string; spaceId: string; sourceUrl: string; kind: SourceKind; label: string;
  status: "pending" | "ready" | "user_action_required" | "error"; errorCode: string | null;
  adapterId: string | null; createdAt: string; updatedAt: string;
}
export interface SourceItem {
  id: string; externalId: string; connectionId: string; title: string; url: string;
  sourceUrl: string; fetchedAt: string; startsAt?: string; endsAt?: string;
  dueAt?: string; location?: string; courseId?: string;
}
export interface Job {
  id: string; spaceId: string; connectionId: string; type: "discover" | "sync";
  status: "queued" | "running" | "succeeded" | "failed"; errorCode: string | null; attempts: number;
}
export interface Section { items: SourceItem[]; sources: { connectionId: string; fetchedAt: string; stale: boolean }[]; connections: Connection[] }
export interface SpaceData {
  spaceId: string;
  status: "loading" | "ready" | "error";
  /** Ошибка последней загрузки: offline — сервер не ответил, иначе код ошибки API. */
  error: { kind: "offline" | "error"; code: string } | null;
  deadlines: Section | null; schedule: Section | null; courses: Section | null;
  loadedAt: number | null;
}

export class PlatformError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

/** Запрос к /api/v1: подпись Telegram в заголовке, ошибки — по коду из {error:{code}}, сетевой сбой — OFFLINE. */
export async function v1<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let r: Response;
  try {
    r = await fetch(apiBase() + "api/v1/" + path, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      headers: { ...apiHeaders(), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(Math.min(API_TIMEOUT_MS, 30_000)),
    });
  } catch {
    throw new PlatformError("OFFLINE", 0);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PlatformError((j as { error?: { code?: string } }).error?.code ?? `HTTP_${r.status}`, r.status);
  return j as T;
}

const LS = "doodle.activeSpace";
const CALM = "doodle.calmMascot";
const readCalm = () => { try { return localStorage.getItem(CALM) === "1"; } catch { return false; } };
const readActive = () => { try { return localStorage.getItem(LS); } catch { return null; } };
const writeActive = (id: string) => { try { localStorage.setItem(LS, id); } catch { /* приватный режим */ } };
const emptyData = (spaceId: string): SpaceData => ({ spaceId, status: "loading", error: null, deadlines: null, schedule: null, courses: null, loadedAt: null });

interface PlatformState {
  spaces: UniversitySpace[];
  spacesStatus: "idle" | "loading" | "ready" | "error";
  activeId: string | null;
  data: SpaceData | null;
  /** Показанные реакции маскота на сдачу (не проигрывать снова). */
  acknowledged: string[];
  /** Спокойный маскот (DES-009): без анимаций, та же информация. Выбор пользователя, хранится на телефоне. */
  calm: boolean;
  setCalm(on: boolean): void;
  /** Профиль с /api/me уже сообщил список вузов — не ждать отдельного запроса. */
  seed(spaces: UniversitySpace[]): void;
  loadSpaces(): Promise<void>;
  setActive(id: string): void;
  reload(): Promise<void>;
  createSpace(universityId: string, name: string): Promise<UniversitySpace>;
  addSource(spaceId: string, sourceUrl: string, kind: SourceKind, label?: string): Promise<{ connection: Connection; job: Job }>;
  /** Ровно одна форма входа: {origin, token} | {origin, username, password} | {origin, calendarUrl} | {origin, identifier}. */
  saveAuth(connectionId: string, auth: Record<string, string>): Promise<{ job: Job }>;
  /** Подключение и способы входа, которые предлагает сервер (порядок — рекомендуемый). */
  getConnection(connectionId: string): Promise<{ connection: Connection; authMethods: AuthMethod[] }>;
  /** Вход через OAuth-провайдера: сервер отдаёт адрес страницы входа. */
  startOAuth(connectionId: string, providerId: string): Promise<{ authorizationUrl: string }>;
  sync(connectionId: string): Promise<Job>;
  /** Опрос задачи до конца (до ~40 с): discovery/sync идут в фоне на сервере. */
  waitJob(id: string): Promise<Job>;
  acknowledge(eventId: string): void;
}

export const usePlatform = create<PlatformState>((set, get) => {
  const pickActive = (spaces: UniversitySpace[]) => {
    const cur = get().activeId ?? readActive();
    return spaces.find((s) => s.id === cur)?.id ?? spaces[0]?.id ?? null;
  };
  const applySpaces = (spaces: UniversitySpace[]) => {
    const activeId = pickActive(spaces);
    const changed = activeId !== get().activeId;
    set({ spaces, spacesStatus: "ready", activeId });
    if (activeId && (changed || !get().data)) { set({ data: emptyData(activeId) }); void get().reload(); }
    if (!activeId) set({ data: null });
  };
  return {
    spaces: [],
    spacesStatus: "idle",
    activeId: null,
    data: null,
    acknowledged: [],
    calm: readCalm(),
    setCalm(on) { set({ calm: on }); try { localStorage.setItem(CALM, on ? "1" : "0"); } catch { /* приватный режим */ } },
    seed(spaces) { if (get().spacesStatus === "idle") applySpaces(spaces); },
    async loadSpaces() {
      set({ spacesStatus: get().spaces.length ? "ready" : "loading" });
      try { applySpaces((await v1<{ spaces: UniversitySpace[] }>("spaces")).spaces); }
      catch { set({ spacesStatus: "error" }); }
    },
    setActive(id) {
      if (id === get().activeId) return;
      writeActive(id);
      // Сразу пусто: прежний вуз не должен мелькать ни в данных, ни в маскоте, пока грузится новый.
      set({ activeId: id, data: emptyData(id) });
      void get().reload();
    },
    async reload() {
      const spaceId = get().activeId;
      if (!spaceId) return;
      const prev = get().data?.spaceId === spaceId ? get().data : null;
      set({ data: { ...(prev ?? emptyData(spaceId)), status: "loading", error: null } });
      try {
        const [deadlines, schedule, courses] = await Promise.all(
          (["deadlines", "schedule", "courses"] as const).map((k) => v1<Section>(`spaces/${encodeURIComponent(spaceId)}/${k}`)));
        if (get().activeId !== spaceId) return; // пока ждали, выбрали другой вуз
        set({ data: { spaceId, status: "ready", error: null, deadlines, schedule, courses, loadedAt: Date.now() } });
      } catch (e) {
        if (get().activeId !== spaceId) return;
        const code = e instanceof PlatformError ? e.code : "INTERNAL_ERROR";
        const cur = get().data?.spaceId === spaceId ? get().data! : emptyData(spaceId);
        set({ data: { ...cur, status: "error", error: { kind: code === "OFFLINE" ? "offline" : "error", code } } });
      }
    },
    async createSpace(universityId, name) {
      const { space } = await v1<{ space: UniversitySpace }>("spaces", { body: { universityId, name } });
      set({ spaces: [...get().spaces, space], spacesStatus: "ready" });
      get().setActive(space.id);
      return space;
    },
    addSource(spaceId, sourceUrl, kind, label) {
      return v1(`spaces/${encodeURIComponent(spaceId)}/connections`, { body: { sourceUrl, kind, ...(label ? { label } : {}) } });
    },
    saveAuth(connectionId, auth) {
      return v1(`connections/${encodeURIComponent(connectionId)}/auth`, { body: auth });
    },
    getConnection(connectionId) {
      return v1(`connections/${encodeURIComponent(connectionId)}`);
    },
    startOAuth(connectionId, providerId) {
      return v1(`connections/${encodeURIComponent(connectionId)}/oauth`, { body: { providerId } });
    },
    async sync(connectionId) {
      return (await v1<{ job: Job }>(`connections/${encodeURIComponent(connectionId)}/sync`, { body: {} })).job;
    },
    async waitJob(id) {
      for (let i = 0; i < 40; i++) {
        const { job } = await v1<{ job: Job }>(`jobs/${encodeURIComponent(id)}`);
        if (job.status === "succeeded" || job.status === "failed") return job;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new PlatformError("JOB_TIMEOUT", 0);
    },
    acknowledge(eventId) { if (!get().acknowledged.includes(eventId)) set({ acknowledged: [...get().acknowledged, eventId] }); },
  };
});
