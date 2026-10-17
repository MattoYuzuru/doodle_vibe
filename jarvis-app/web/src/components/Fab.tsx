import { m } from "framer-motion";
import { Plus } from "lucide-react";
import { useLiquidGlass } from "../hooks/useLiquidGlass";
import { useNav } from "../hooks/useNav";
import { useUi } from "../hooks/useUi";
import { haptic } from "../telegram/webapp";
import { TABBAR_H } from "./TabBar";

const spring = { type: "spring", stiffness: 520, damping: 34 } as const;

/** Плавающий «+» из стекла с акцентной заливкой: сразу новый дедлайн (заметки и задачи из него убраны по просьбе владельца). */
export function Fab() {
  const push = useNav((s) => s.push);
  const compact = useUi((s) => s.compact);
  const keyboard = useUi((s) => s.keyboard);
  const glassRef = useLiquidGlass<HTMLButtonElement>({ radius: Infinity, band: 12, strength: 22 });

  // Нажатие — CSS :active вместо whileTap (проверка 15 окт), как у плиток: сжатие идёт на композиторе, а не пружиной
  // framer в главном потоке. Пока открыта клавиатура, «+» уезжает вниз и не закрывает поле ввода.
  return (
    <m.button
      ref={glassRef}
      aria-label="Добавить дедлайн"
      aria-hidden={keyboard || undefined}
      tabIndex={keyboard ? -1 : undefined}
      onClick={() => { haptic.tap(); push({ name: "deadline-form" }); }}
      animate={{ scale: compact ? 0.86 : 1, y: keyboard ? 200 : 0, opacity: keyboard ? 0 : 1 }}
      transition={spring}
      className={`glass glass-float glass-accent fixed right-4 z-30 grid size-14 place-items-center rounded-full text-on-accent transition-[scale] duration-150 ease-out active:scale-90 active:delay-75 ${keyboard ? "pointer-events-none" : ""}`}
      style={{ bottom: `calc(${TABBAR_H + 12}px + var(--safe-bottom))` }}
    >
      <Plus size={26} strokeWidth={2.25} />
    </m.button>
  );
}
