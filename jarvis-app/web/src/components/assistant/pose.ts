import type { AssistantPresentation, CharacterId } from "../../theme/assistant-state";
import type { Eyes } from "./sprites";

/*
 * Второй слой маскота (DES-005): семантическое состояние из assistant-state → поза. Три кадра глаз (как у Дуси раньше:
 * сразу, через 0,6 с, через 2 с), значки над головой в два такта, анимация тела и глаза в покое. Чистая функция.
 * Значки у персонажей свои: у Дуси мысль — лампочка, у Вари — пузырьки.
 */

export type Anim = "think" | "panic" | "stern" | "sleepy" | "happy" | "alert" | "party";
export type Pose = {
  anim: Anim | null;
  frames: readonly [Eyes, Eyes, Eyes];
  rest: Eyes;
  /** Значки в первый такт и во второй (второй заменяет первый). */
  props: readonly string[];
  props2: readonly string[];
};

const thought = (c: CharacterId) => (c === "varya" ? "bubbles" : "idea");

export function poseFor(p: Pick<AssistantPresentation, "status" | "character" | "urgency">): Pose {
  const c = p.character;
  const pose = (anim: Anim | null, frames: [Eyes, Eyes, Eyes], props: string[] = [], props2 = props, rest: Eyes = "open"): Pose =>
    ({ anim, frames, rest, props, props2 });
  switch (p.status) {
    case "reauth": return pose("think", ["up", "open", "open"], ["q"]);
    case "error":
    case "offline": return pose(null, ["half", "half", "open"], ["sweat"]);
    case "connecting":
    case "thinking": return pose("think", ["up", "up", "open"], ["q"], [thought(c)]);
    case "syncing": return pose("think", ["up", "open", "open"], ["q"]);
    case "urgent": return pose("panic", ["wide", "wide", "open"], ["excl"], ["excl", "sweat"]);
    // Просрочено: внимание без паники и без укора.
    case "overdue": return pose("alert", ["wide", "open", "open"], ["excl"]);
    case "completed": return pose("party", ["happy", "happy", "happy"], ["spark"], ["spark"], "happy");
    case "soon": return pose("alert", ["up", "open", "open"], ["clock"]);
    case "empty": return pose("think", ["up", "open", "open"], ["q"], [thought(c)]);
    case "ready":
      if (p.urgency?.level === "none") return pose("happy", ["happy", "happy", "happy"], ["spark"], ["spark"], "happy");
      if (p.urgency?.level === "unknown") return pose("think", ["up", "open", "open"], ["q"]);
      return pose(null, ["open", "open", "open"]);
    case "unknown": return pose(null, ["open", "open", "open"]);
  }
}
