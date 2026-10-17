import { create } from "zustand";
import { api } from "./api";
import { useAuth } from "./auth";

export interface Lesson {
  date: string; start: string; end: string; name: string;
  type: "lecture" | "lab" | "practice" | "other"; typeLabel: string; teacher: string; place: string;
  /** "1" | "2" — подгруппа, "" — вся группа. */
  subgroup: string;
  /** Откуда пара: официальное расписание МИСИС (основа) или «Дневач» (там видны переносы и замены). */
  source?: "official" | "dnevuch";
  /** Отличие от расписания МИСИС по данным «Дневача»: новая пара, отменённая (показывается зачёркнутой), другая аудитория (was — прежняя). */
  change?: "added" | "removed" | "place";
  was?: string;
}
interface ScheduleResponse {
  at: number; group: string | null; lessons: Lesson[]; subgroup?: "1" | "2"; needGroup?: boolean; stale?: boolean; error?: string;
  /** Официальный файл МИСИС — основа расписания (updated — дата выкладки, YYYY-MM-DD); changes — сколько пар отличается по «Дневачу». */
  official?: { file: string; updated: string } | null;
  changes?: number;
}

const LS = "jarvis.schedule";
const read = (): ScheduleResponse | null => { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; } };

/**
 * Расписание пар группы пользователя с сервера: основа — официальное расписание МИСИС на текущую и две следующие недели,
 * а где «Дневач» показывает перенос, отмену или замену — его вариант с пометкой change (и уведомление в Telegram).
 * Копия в localStorage; подгруппа хранится в профиле.
 */
export const useSchedule = create<{
  data: ScheduleResponse | null; status: "idle" | "loading" | "ok" | "error"; error?: string;
  subgroup: "1" | "2"; setSubgroup(s: "1" | "2"): void; load(force?: boolean): Promise<void>;
  /** Пары дня своей подгруппы; отменённые — только с withRemoved (их показывает «План», зачёркнутыми). */
  forDay(date: string, withRemoved?: boolean): Lesson[];
}>((set, get) => ({
  data: read(),
  status: "idle",
  subgroup: read()?.subgroup ?? "1",
  setSubgroup: (s) => { set({ subgroup: s }); void useAuth.getState().setGroup(useAuth.getState().profile?.group ?? null, s).catch(() => {}); },
  async load(force = false) {
    if (new URLSearchParams(location.search).has("demo")) { set({ status: "ok" }); return; } // иначе на Главной вечное «Загружаю расписание…»
    set({ status: "loading" });
    try {
      const data = await api<ScheduleResponse>(`api/schedule${force ? "?refresh" : ""}`);
      set({ data, status: "ok", error: undefined, ...(data.subgroup ? { subgroup: data.subgroup } : {}) });
      try { localStorage.setItem(LS, JSON.stringify(data)); } catch { /* приватный режим */ }
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },
  forDay: (date, withRemoved = false) => {
    const sub = get().subgroup;
    return (get().data?.lessons ?? []).filter((l) => l.date === date && (!l.subgroup || l.subgroup === sub) && (withRemoved || l.change !== "removed"));
  },
}));
