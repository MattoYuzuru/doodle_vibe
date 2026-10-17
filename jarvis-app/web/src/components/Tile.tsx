import { m } from "framer-motion";
import type { ReactNode } from "react";
import { lite } from "../lib/perf";
import { spring, stagger } from "../theme/motion";

/**
 * Стеклянная плитка бенто: появляется с пружиной по очереди (index), при нажатии чуть сжимается.
 * enter="fade" — просто проявляется без сдвига, сжатия и очереди (списки, где содержимое меняется переключателем).
 *
 * Нажатие — CSS :active, а не whileTap (проверка 15 окт): framer сжимал плитку уже на pointerdown, и в начале каждого
 * взмаха плитка под пальцем дёргалась, а пружина масштаба запускалась в главном потоке ровно в момент старта прокрутки.
 * Chromium ставит :active только после короткой паузы без сдвига пальца и снимает, когда началась прокрутка; задержка
 * входа (delay-75) — для WebKit, где :active включается прямо на касании. Отпускание — без задержки. scale в Tailwind 4 —
 * отдельное CSS-свойство: складывается с transform от анимации появления, а переход идёт на композиторе.
 */
const PRESS ="transition-[scale] duration-150 ease-out active:scale-[0.975] active:delay-75";

export function Tile({ children, index = 0, span = 1, className = "", onClick, style, enter = "spring" }: {
  children: ReactNode; index?: number; span?: 1 | 2; className?: string; onClick?: () => void; style?: React.CSSProperties; enter?: "spring" | "fade";
}) {
  const Comp = onClick ? m.button : m.div;
  const fade = enter === "fade";
  return (
    <Comp
      // Без layout-анимации: при обновлении данных плитки встают на место сразу. С ней при «потянуть вниз» (лента
      // сдвинута и пружинит назад) framer мерил положения со сдвигом, и плитки с текстом подёргивались; раньше ещё
      // и масштаб искажал мелкие иконки. Облегчённый режим: без анимации появления.
      onClick={onClick}
      initial={lite ? false : fade ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
      animate={fade ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      transition={fade ? { duration: 0.22, ease: "easeOut" } : { ...spring(380, 30), delay: stagger(index) }}
      style={style}
      className={`glass-tile block w-full overflow-hidden rounded-[22px] p-4 text-left ${onClick ? PRESS : ""} ${fade ? "transform-gpu [backface-visibility:hidden]" : ""} ${className.includes("min-h-") ? "" : "min-h-[124px]"} ${span === 2 ? "col-span-2" : ""} ${className}`}
    >
      {children}
    </Comp>
  );
}

export function TileLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12px] font-bold uppercase tracking-[0.06em] text-hint ${className}`}>{children}</p>;
}
