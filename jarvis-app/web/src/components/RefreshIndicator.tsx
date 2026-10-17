import { m, useMotionValue, useTransform } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pullPending, pullY } from "../hooks/usePullToRefresh";
import { useAppStore } from "../store/useAppStore";

const THRESHOLD = 72;

/**
 * Значок обновления сверху: проявляется, когда контент вытянут почти до порога, крутится, пока идёт
 * обновление (минимум 450 мс, чтобы его успели заметить), и исчезает сразу после.
 */
export function RefreshIndicator() {
  const refreshing = useAppStore((s) => s.refreshing);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (refreshing) { setSpinning(true); return; }
    const t = setTimeout(() => setSpinning(false), 450);
    return () => clearTimeout(t);
  }, [refreshing]);

  const shown = useMotionValue(0);
  useEffect(() => { shown.set(spinning ? 1 : 0); }, [spinning, shown]);
  // pullPending: обновление уже запрошено, но стартует, когда лента доедет назад, — значок всё это время виден.
  const opacity = useTransform([pullY, shown, pullPending], ([p, s, q]: number[]) =>
    Math.max(s, q, Math.min(Math.max((p - THRESHOLD * 0.5) / (THRESHOLD * 0.5), 0), 1)));
  const y = useTransform([pullY, shown, pullPending], ([p, s, q]: number[]) => (s || q ? 0 : Math.min(p, THRESHOLD) - THRESHOLD));
  const rotate = useTransform(pullY, (p) => p * 3);

  // Размытие под стеклом — только пока значок виден (проверка 15 окт): невидимый backdrop-filter у верхнего края
  // всё равно мог пересчитываться на каждом кадре прокрутки. Класс ставим прямо на элемент, без перерисовки React.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const set = (v: number) => ref.current?.classList.toggle("glass-float", v > 0.01);
    set(opacity.get());
    return opacity.on("change", set);
  }, [opacity]);

  return (
    <m.div
      ref={ref}
      aria-hidden
      className="glass pointer-events-none fixed left-1/2 z-30 grid size-10 place-items-center rounded-full text-accent"
      style={{ top: "calc(10px + var(--safe-top))", x: "-50%", y, opacity }}
    >
      <m.span style={{ rotate }} className="grid place-items-center">
        <m.span
          className="grid place-items-center"
          animate={spinning ? { rotate: 360 } : { rotate: 0 }}
          transition={spinning ? { repeat: Infinity, duration: 0.7, ease: "linear" } : { duration: 0.2 }}
        >
          <RefreshCw size={18} strokeWidth={2.5} />
        </m.span>
      </m.span>
    </m.div>
  );
}
