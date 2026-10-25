import { create } from "zustand";

/** Четвёртая вкладка — электронный журнал (посещаемость и успеваемость); заметок в приложении больше нет. */
export type Tab = "home" | "deadlines" | "plan" | "journal";
/** Вид вкладки «Журнал»: сам журнал или «Сессия» (переключатель наверху вкладки; просьба владельца, 15 окт 2026: не отдельная вкладка). */
export type JournalView = "journal" | "session";
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
  /** Подключить вуз или учебный сайт (новый API, DES-010). */
  | { name: "connect"; spaceId?: string }
  | { name: "task-form"; id?: string; date?: string };

/**
 * Экран в стеке: uid — свой на каждое открытие (проверка 15 окт). Весь стек теперь в DOM, и ключ по номеру в стеке
 * при быстром «Назад» → открыть другой экран подхватывал уезжающий экземпляр: анимация ухода разворачивалась, а внутри
 * оказывался чужой экран со старыми хуками.
 */
export type StackEntry = Screen & { uid: number };

// Навигация: вкладка + стек вложенных экранов поверх неё (для системной кнопки «Назад»).
interface Nav {
  tab: Tab;
  stack: StackEntry[];
  journalView: JournalView;
  setTab(t: Tab): void;
  push(s: Screen): void;
  pop(): void;
  setJournalView(v: JournalView): void;
}

const params = new URLSearchParams(location.search);
const initialTab = params.get("tab") as Tab | null;
// «?open=session» из сообщений бота о сессии — вкладка «Журнал» сразу в виде «Сессия», без мигания журнала.
const openSession = params.get("open") === "session";
let uidSeq = 0;

export const useNav = create<Nav>((set) => ({
  tab: openSession ? "journal" : initialTab && ["home", "deadlines", "plan", "journal"].includes(initialTab) ? initialTab : "home",
  stack: [],
  journalView: openSession ? "session" : "journal",
  // Та же вкладка без открытых экранов — состояние не трогаем (проверка 15 окт): иначе подписчики (лента, панель,
  // экраны) перерисовывались впустую — например, когда свайп вкладок вернулся на исходную.
  setTab: (tab) => set((st) => (st.tab === tab && !st.stack.length ? st : { tab, stack: [] })),
  push: (s) => set((st) => ({ stack: [...st.stack, { ...s, uid: ++uidSeq }] })),
  pop: () => set((st) => ({ stack: st.stack.slice(0, -1) })),
  setJournalView: (journalView) => set({ journalView }),
}));
