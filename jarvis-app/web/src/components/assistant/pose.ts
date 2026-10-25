import type { AssistantPresentation, CharacterId } from "../../theme/assistant-state";
import type { Eyes } from "./sprites";

/*
 * Второй слой маскота (DES-005): семантическое состояние из assistant-state → поза. Три кадра глаз (как у Дуси раньше:
 * сразу, через 0,6 с, через 2 с), значки над головой в два такта, анимация тела и глаза в покое. Чистая функция.
 * Значки у персонажей свои: у Дуси мысль — лампочка, у Вари — пузырьки. Подключение, обновление и загрузка — бег на
 * месте (running): оболочка рядом показывает полоску без процентов, потому что настоящий прогресс неизвестен.
 * Реакция на сдачу рядом со срочной работой (DES-006) — короткая улыбка в первом кадре, дальше снова срочность.
 */

export type Anim = "think" | "panic" | "stern" | "sleepy" | "happy" | "alert" | "party";
export type Pose = {
  anim: Anim | null;
  frames: readonly [Eyes, Eyes, Eyes];
  rest: Eyes;
  /** Значки в первый такт и во второй (второй заменяет первый). */
  props: readonly string[];
  props2: readonly string[];
  running: boolean;
};

const thought = (c: CharacterId) => (c === "varya" ? "bubbles" : "idea");

export function poseFor(p: Pick<AssistantPresentation, "status" | "character" | "urgency"> & Partial<Pick<AssistantPresentation, "reaction">>): Pose {
  const base = statusPose(p);
  if (!p.reaction || p.status === "completed" || base.running) return base;
  return { ...base, frames: ["happy", base.frames[1], base.frames[2]], props: ["spark"] };
}

function statusPose(p: Pick<AssistantPresentation, "status" | "character" | "urgency">): Pose {
  const c = p.character;
  const pose = (anim: Anim | null, frames: [Eyes, Eyes, Eyes], props: string[] = [], props2 = props, rest: Eyes = "open"): Pose =>
    ({ anim, frames, rest, props, props2, running: false });
  const run = (frames: [Eyes, Eyes, Eyes]): Pose => ({ anim: null, frames, rest: frames[2], props: [], props2: [], running: true });
  switch (p.status) {
    case "reauth": return pose("think", ["up", "open", "open"], ["q"]);
    case "error":
    case "offline": return pose(null, ["half", "half", "open"], ["sweat"]);
    case "connecting":
    case "syncing": return run(["open", "open", "open"]);
    case "thinking": return pose("think", ["up", "up", "open"], ["q"], [thought(c)]);
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
    case "unknown": return run(["open", "up", "open"]);
  }
}
