import { create } from "zustand";
import { sessionApi, type SessionChoice, type SessionView } from "./api";
import { useAuth } from "./auth";

const LS = "jarvis.session";
const read = (): SessionView | null => { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; } };
const write = (v: SessionView | null) => { try { if (v) localStorage.setItem(LS, JSON.stringify(v)); else localStorage.removeItem(LS); } catch { /* приватный режим */ } };

/**
 * Счётчик запросов (проверка 15 окт): раньше второй load() при уже идущем просто выходил, и запрос, начатый до смены
 * группы, приносил «Укажите группу» уже после того, как её выбрали. Теперь ответ записывает только последний запрос;
 * повтор пропускаем, лишь когда уже идёт запрос для той же группы (Главная и вкладка просят одновременно при запуске).
 */
let seq = 0;
let inflightGroup: string | null = null;
/** Растёт только при выходе (clear): ответ, пришедший после выхода, не записывается. */
let epoch = 0;
let chooseSeq = 0;
let chooseApplied = 0;

/**
 * «Сессия» (экран и плитка на Главной): даты сессии и формы контроля из учебного плана, расписание экзаменов, долги —
 * с сервера; копия в localStorage открывается сразу, свежие данные догружаются.
 */
export const useSession = create<{
  data: SessionView | null;
  status: "idle" | "loading" | "ok" | "error";
  error?: string;
  load(): Promise<void>;
  /** Уточнение самого студента (дисциплина по выбору, факультатив, «не моё»): сервер сохраняет и отдаёт новую сводку. */
  choose(c: SessionChoice): Promise<void>;
  clear(): void;
}>((set, get) => ({
  data: read(),
  status: "idle",
  async load() {
    if (new URLSearchParams(location.search).has("demo")) { set({ status: "ok" }); return; }
    const group = useAuth.getState().profile?.group ?? null;
    if (get().status === "loading" && inflightGroup === group) return;
    const n = ++seq;
    inflightGroup = group;
    set({ status: "loading" });
    try {
      const data = await sessionApi.get();
      if (n !== seq) return; // пока шёл, начали новый (сменилась группа) — его ответ свежее
      set({ data, status: "ok", error: undefined });
      write(data);
    } catch (e) {
      if (n !== seq) return;
      set({ status: "error", error: (e as Error).message });
    }
  },
  // Ошибку не глотаем: экран покажет её уведомлением. Идущую загрузку отменяем только после удачного ответа (её сводка —
  // без этого уточнения); при ошибке она спокойно закончится сама (проверка 15 окт: раньше неудачное нажатие выбрасывало
  // свежую загрузку и оставляло старую копию с телефона). Из нескольких уточнений подряд применяется каждый удачный ответ,
  // если он новее уже применённого: неудача на одной карточке не отменяет удачу на другой.
  async choose(c) {
    const e0 = epoch, n = ++chooseSeq;
    const data = await sessionApi.choose(c);
    if (e0 !== epoch || n < chooseApplied) return; // пока шёл — вышли из бота или уже применён ответ на более позднее нажатие
    chooseApplied = n;
    seq++;
    set({ data, status: "ok", error: undefined });
    write(data);
  },
  // Выход из бота: запрос, который ещё идёт, не должен вернуть сводку на телефон.
  clear() { seq++; epoch++; set({ data: null, status: "idle", error: undefined }); write(null); },
}));
