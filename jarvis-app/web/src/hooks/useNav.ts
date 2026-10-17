import { create } from "zustand";

/** Четвёртая вкладка — электронный журнал (посещаемость и успеваемость); заметок в приложении больше нет. */
export type Tab = "home" | "deadlines" | "plan" | "journal";
export type Screen =
  | { name: "deadline"; id: string }
  | { name: "lab"; id: string }
  | { name: "check"; id: string }
  | { name: "profile" }
  | { name: "teachers" }
  | { name: "access" }
  | { name: "env" }
  | { name: "calendar" }
  | { name: "usage" }
  | { name: "courses" }
  /** Экран курса по нажатию на пару в расписании: lesson — занятие, с которого пришли; subjectId — курс Moodle, если найден. */
  | { name: "course"; title: string; subjectId?: string; lesson?: import("../store/schedule").Lesson }
  | { name: "deadline-form"; id?: string }
  | { name: "task-form"; id?: string; date?: string };

// Навигация: вкладка + стек вложенных экранов поверх неё (для системной кнопки «Назад»).
interface Nav {
  tab: Tab;
  stack: Screen[];
  setTab(t: Tab): void;
  push(s: Screen): void;
  pop(): void;
}

const initialTab = new URLSearchParams(location.search).get("tab") as Tab | null;

export const useNav = create<Nav>((set) => ({
  tab: initialTab && ["home", "deadlines", "plan", "journal"].includes(initialTab) ? initialTab : "home",
  stack: [],
  setTab: (tab) => set({ tab, stack: [] }),
  push: (s) => set((st) => ({ stack: [...st.stack, s] })),
  pop: () => set((st) => ({ stack: st.stack.slice(0, -1) })),
}));
