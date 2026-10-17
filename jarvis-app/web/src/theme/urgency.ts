import { DAY, HOUR, effectiveDue } from "../lib/dates";
import type { Deadline } from "../store/types";

/** Срочность: done — только «сдано» (зелёный), overdue/urgent — красный, soon — жёлтый, calm — серый. */
export type Urgency = "done" | "overdue" | "urgent" | "soon" | "calm";

// Порог «скоро» пока 3 дня (пользователь решит позже, возможно 7).
export const SOON_MS = 3 * DAY;
export const URGENT_MS = 24 * HOUR;

export function urgencyOf(d: Pick<Deadline, "due" | "status">, now = Date.now()): Urgency {
  if (d.status === "done") return "done";
  const left = effectiveDue(d.due) - now;
  if (left <= 0) return "overdue";
  if (left <= URGENT_MS) return "urgent";
  if (left <= SOON_MS) return "soon";
  return "calm";
}

/** Классы бейджа: тонированная подложка + цветной текст. */
export const badgeClass: Record<Urgency, string> = {
  done: "bg-green/15 text-green",
  overdue: "bg-red/15 text-red",
  urgent: "bg-red/15 text-red",
  soon: "bg-yellow/15 text-yellow",
  calm: "bg-raised text-hint",
};

/** Градиент большой карточки ближайшего дедлайна. */
export const heroGradient: Record<Urgency, string> = {
  // Спокойный синий фирменного цвета вместо сине-фиолетового (18 окт 2026).
  calm: "linear-gradient(135deg, #4a8dff 0%, #2f7bf6 45%, #2463d8 100%)",
  soon: "radial-gradient(130% 150% at 100% 0%, #ffd46b 0%, #f5a524 34%, #c86b12 70%, #6e3508 100%)",
  urgent: "radial-gradient(130% 150% at 100% 0%, #ff9a8a 0%, #ff4d3d 34%, #c4221a 70%, #5e0d0a 100%)",
  overdue: "radial-gradient(130% 150% at 100% 0%, #ff9a8a 0%, #ff4d3d 34%, #c4221a 70%, #5e0d0a 100%)",
  done: "radial-gradient(130% 150% at 100% 0%, #7fe0a0 0%, #30b35d 40%, #1c6e39 100%)",
};
