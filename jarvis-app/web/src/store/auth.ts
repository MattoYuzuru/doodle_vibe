import { create } from "zustand";
import { tg } from "../telegram/webapp";
import { api } from "./api";
import { useJournal } from "./journal";
import { useSession } from "./session";

/** Профиль пользователя на сервере: вошёл ли в Moodle, группа для расписания, доступ к лабам. */
export interface Profile {
  tgId: number;
  loggedIn: boolean;
  moodle: { userId?: number; fullName?: string; username?: string } | null;
  group: string | null;
  groupCandidates: string[];
  subgroup: "1" | "2";
  /** Номер варианта для титульного листа отчётов (свободный текст, например «04»). */
  variant: string | null;
  labsAllowed: boolean;
  /** Лабы выключены на сервере (переезд, нет агента): готовые отчёты видны, новые ходы агента не запускаются. */
  labsOff?: boolean;
  /**
   * Пробный отчёт (у кого нет полного доступа): "available" — один пробный положен; объект — пробная лаба по работе id
   * (closed — владелец закрыл, otherAccount — сейчас вход под другой учёткой Moodle); null — не положен. См. lib/labGate.ts.
   */
  labTrial?: "available" | { id: string; title: string | null; at: number; closed?: boolean; otherAccount?: boolean } | null;
  /** Когда пользователь просил доступ к отчётам (null — не просил); isOwner — владелец бота. */
  labRequest: number | null;
  isOwner: boolean;
  /** Ручной выбор курсов: { [courseId]: true | false }; без записи — автоматика. */
  courseOverrides: Record<string, boolean>;
  /** Делится ли замечаниями преподавателя к своим работам (обезличенно) — для проверки отчётов агентом. */
  shareRemarks: boolean;
  /** Какие сообщения бота включены: news — объявления и новые материалы курсов, journal — пропуски и посещаемость. */
  notify?: { news: boolean; journal: boolean };
  /** Месячный лимит отчётов с агентом: сколько процентов израсходовано; null — лимита нет. */
  /** level: ok — можно всё; start — закрыты новый отчёт, исправление и проверка (100 %); all — и сообщения в начатой работе (125 %); closed — лимит 0. */
  quota?: { percent: number; level?: "ok" | "start" | "all" | "closed" } | null;
}

/**
 * Сервер отдаёт полный профиль (как /api/me), но при сбое — запасной, без полей лимита и пробного отчёта. Тогда берём их
 * из прежнего профиля, иначе пропадало предложение пробного (ревью 16 окт). null с сервера — честное «нет», его не трогаем.
 */
const withServerFields = (p: Profile, prev: Profile | null): Profile => ({ ...p, quota: p.quota !== undefined ? p.quota : prev?.quota ?? null, labTrial: p.labTrial !== undefined ? p.labTrial : prev?.labTrial ?? null });

/** «Ким Александр Евгеньевич» → «Ким А. Е.» — так ФИО попадёт на титульный лист. */
export const shortName = (full?: string | null) => (full ?? "").trim().split(/\s+/).filter(Boolean).map((w, i) => (i ? `${w[0]}.` : w)).join(" ");

const DEMO = new URLSearchParams(location.search).has("demo");

// Копия профиля на телефоне: при запуске он есть сразу (плитка отчётов, группа, имя — без ожидания сервера), свежий
// приходит следом. Только вошедшего и только своего аккаунта Telegram (на одном телефоне их бывает несколько).
const LS = "jarvis.profile";
const myTgId = () => tg?.initDataUnsafe?.user?.id ?? null;
const readProfile = (): Profile | null => {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || "null") as Profile | null;
    return p?.loggedIn && (myTgId() === null || p.tgId === myTgId()) ? p : null;
  } catch { return null; }
};
const writeProfile = (p: Profile | null) => {
  try { if (p?.loggedIn) localStorage.setItem(LS, JSON.stringify(p)); else localStorage.removeItem(LS); } catch { /* приватный режим */ }
};

export const useAuth = create<{
  profile: Profile | null;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  load(): Promise<Profile | null>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  setGroup(group: string | null, subgroup?: "1" | "2"): Promise<void>;
  setVariant(variant: string): Promise<void>;
  requestLabAccess(): Promise<void>;
  setShareRemarks(on: boolean): Promise<void>;
  setNotifyPref(key: "news" | "journal", on: boolean): Promise<void>;
}>((set, get) => ({
  profile: DEMO ? { tgId: 0, loggedIn: true, moodle: { fullName: "Демо Пользователь" }, group: "БИСТ-24-ПО-2", groupCandidates: [], subgroup: "1", variant: "04", labsAllowed: true, labRequest: null, isOwner: true, courseOverrides: {}, shareRemarks: false } : readProfile(),
  status: "idle",
  async load() {
    if (DEMO) return get().profile;
    set({ status: "loading" });
    try { const p = await api<Profile>("api/me"); set({ profile: p, status: "ready", error: undefined }); return p; }
    catch (e) { set({ status: "error", error: (e as Error).message }); return null; }
  },
  async login(username, password) {
    const p = await api<Profile>("api/login", { username, password });
    // Вход мог быть другой учётной записью (или после выхода по мёртвому токену, когда копии не стирались): журнал и
    // «Сессию» прежнего входа на телефоне не держим — иначе при сбое журнала показались бы чужие данные (ревью 16 окт).
    useJournal.getState().clear();
    useSession.getState().clear();
    set({ profile: p, status: "ready" });
    // Запасной ответ входа — без пробного отчёта и лимита; прежние не подставляем (могла войти другая учётка) — перечитать.
    if (p.labTrial === undefined) void get().load().catch(() => {});
  },
  async logout() {
    const p = await api<Profile>("api/logout", {});
    set({ profile: p });
    useJournal.getState().clear(); // выход из бота — выход и из журнала: его данные на телефоне не оставляем
    useSession.getState().clear(); // сводка «Сессия» строится по журналу и Moodle — тоже стираем
  },
  async setGroup(group, subgroup) {
    const p = await api<Profile>("api/group", { group, subgroup });
    set({ profile: withServerFields(p, get().profile) });
  },
  async requestLabAccess() {
    await api("api/lab/request", {});
    set({ profile: { ...get().profile!, labRequest: Date.now() } });
  },
  async setShareRemarks(on) {
    if (DEMO) { set({ profile: { ...get().profile!, shareRemarks: on } }); return; }
    const p = await api<Profile>("api/share-remarks", { on });
    set({ profile: p });
  },
  async setNotifyPref(key, on) {
    if (DEMO) { set({ profile: { ...get().profile!, notify: { news: true, journal: true, ...get().profile!.notify, [key]: on } } }); return; }
    const p = await api<Profile>("api/notify-prefs", { key, on });
    set({ profile: p });
  },
  async setVariant(variant) {
    if (DEMO) { set({ profile: { ...get().profile!, variant: variant || null } }); return; }
    const p = await api<Profile>("api/group", { variant });
    set({ profile: withServerFields(p, get().profile) });
  },
}));

if (!DEMO) useAuth.subscribe((s, prev) => { if (s.profile !== prev.profile) writeProfile(s.profile); });
