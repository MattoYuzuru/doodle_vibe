// Пружины и задержки для всех анимаций. ?motion=slow замедляет их в 4 раза (чтобы разглядеть или снять).
const SLOW = new URLSearchParams(location.search).get("motion") === "slow" ? 4 : 1;

export const spring = (stiffness = 520, damping = 34, mass = 1) =>
  ({ type: "spring", stiffness: stiffness / SLOW, damping: damping / Math.sqrt(SLOW), mass }) as const;

/** Задержка появления i-го элемента при «сборке» экрана. */
export const stagger = (i: number, step = 0.06) => i * step * SLOW;

export const dur = (seconds: number) => seconds * SLOW;
