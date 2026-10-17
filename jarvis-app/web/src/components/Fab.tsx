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
  const glassRef = useLiquidGlass<HTMLButtonElement>({ radius: Infinity, band: 12, strength: 22 });

  return (
    <m.button
      ref={glassRef}
      aria-label="Добавить дедлайн"
      onClick={() => { haptic.tap(); push({ name: "deadline-form" }); }}
      whileTap={{ scale: 0.9 }}
      animate={{ scale: compact ? 0.86 : 1 }}
      transition={spring}
      className="glass glass-accent fixed right-4 z-30 grid size-14 place-items-center rounded-full text-on-accent"
      style={{ bottom: `calc(${TABBAR_H + 12}px + var(--safe-bottom))` }}
    >
      <Plus size={26} strokeWidth={2.25} />
    </m.button>
  );
}
