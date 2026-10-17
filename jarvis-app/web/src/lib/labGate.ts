import { useAuth, type Profile } from "../store/auth";

/**
 * Что пользователь может с отчётом по этой работе (16 окт 2026, пробный отчёт — сервер lab-trial.mjs):
 * full — полный доступ (белый список, владелец); trial-own — это его пробная лаба; trial-offer — пробный положен и ещё
 * не начат (начать можно эту работу); trial-used — пробный уже потрачен на другую работу или закрыт; none — доступа нет.
 * Окончательно решает сервер; здесь — чтобы показать нужные кнопки.
 */
export type LabGate = "full" | "trial-own" | "trial-offer" | "trial-used" | "none";

export function labGate(p: Profile | null | undefined, assignId: string | null | undefined): LabGate {
  if (!p) return "none";
  if (p.labsAllowed) return "full";
  const t = p.labTrial;
  if (t === "available") return assignId ? "trial-offer" : "none";
  if (t && typeof t === "object") return t.id === assignId && !t.closed && !t.otherAccount ? "trial-own" : "trial-used";
  return "none";
}

/** Можно ли открыть экран лабы по этой работе (полный доступ, своя пробная или пробный, который можно начать на ней). */
export const canOpenLab = (g: LabGate) => g === "full" || g === "trial-own" || g === "trial-offer";

/** Лабы выключены на сервере (profile.labsOff, отказ labs_off) — одна фраза для плашки и для отказа. */
export const LABS_OFF_TEXT = "Отчёты с агентом временно недоступны: Doodle переезжает на новый сервер. Готовые отчёты можно открыть, прикрепить и отправить в Moodle, остальное в Doodle работает как обычно.";

/** Коды отказа сервера (403) — человеческим текстом; остальные сообщения — как есть. */
const LAB_ERRORS: Record<string, string> = {
  labs_not_allowed: "Отчёты с агентом вам пока не открыты. Запросите доступ в карточке работы.",
  trial_used: "Пробный отчёт уже использован на другой работе. Чтобы делать отчёты дальше, запросите доступ в карточке работы.",
  trial_start_first: "Сначала начните пробный отчёт кнопкой «Сделать отчёт».",
  trial_other_account: "Пробный отчёт привязан к другой учётной записи Moodle — войдите под ней.",
  labs_off: LABS_OFF_TEXT,
};
export const labErrorText = (msg: string) => LAB_ERRORS[msg] ?? msg;

/**
 * Сервер отказал по доступу — значит, профиль на телефоне устарел (пробный потрачен на другой работе, закрыт, сменилась
 * учётка): перечитываем /api/me, чтобы кнопки стали верными. Не чаще раза в 30 с — опросы карточек идут каждые 5–10 с.
 */
let deniedAt = 0;
export function onLabDenied(msg: string): boolean {
  if (!(msg in LAB_ERRORS)) return false;
  if (Date.now() - deniedAt > 30e3) { deniedAt = Date.now(); void useAuth.getState().load().catch(() => {}); }
  return true;
}
