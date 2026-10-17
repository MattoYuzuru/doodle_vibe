import { create } from "zustand";
import { ejApi, type EjState } from "./api";

const LS = "jarvis.journal";
const read = (): EjState | null => { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; } };
const write = (st: EjState | null) => { try { if (st) localStorage.setItem(LS, JSON.stringify(st)); else localStorage.removeItem(LS); } catch { /* приватный режим */ } };

/**
 * Электронный журнал (вкладка «Журнал» и плитка на Главной): состояние подключения и данные семестра с сервера,
 * копия в localStorage — открывается сразу, свежие данные догружаются. Если журнал не ответил, остаются прошлые данные.
 */
export const useJournal = create<{
  st: EjState | null;
  status: "idle" | "loading" | "ok" | "error";
  error?: string;
  load(refresh?: boolean): Promise<void>;
  connect(password: string): Promise<void>;
  /** «Вернуть» дисциплину, которую студент назвал не своей (в боте или в «Сессии»): сервер снимает обе отметки. */
  restore(id: number): Promise<void>;
  clear(): void;
}>((set, get) => ({
  st: read(),
  status: "idle",
  async load(refresh = false) {
    if (new URLSearchParams(location.search).has("demo")) { set({ status: "ok" }); return; }
    if (get().status === "loading") return;
    set({ status: "loading" });
    try {
      const st = await ejApi.get(refresh);
      if (st.loadError) {
        // Журнал не ответил: остаются прошлые данные (с сервера или с телефона) и показывается причина.
        const data = st.data ?? (st.connected ? get().st?.data ?? null : null);
        set({ st: { ...st, data }, status: "error", error: st.loadError });
        return;
      }
      set({ st, status: "ok", error: undefined });
      write(st);
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },
  async connect(password) {
    await ejApi.connect(password);
    set({ status: "idle" });
    await get().load(true);
  },
  // Ошибку не глотаем: экран покажет её. Журнал не ответил — сервер отдаёт прошлые данные с причиной: их и показываем.
  async restore(id) {
    const st = await ejApi.mine(id);
    const data = st.data ?? (st.connected ? get().st?.data ?? null : null);
    set({ st: { ...st, data }, status: st.loadError ? "error" : "ok", error: st.loadError || undefined });
    if (!st.loadError) write(st);
  },
  clear() { set({ st: null, status: "idle", error: undefined }); write(null); },
}));
