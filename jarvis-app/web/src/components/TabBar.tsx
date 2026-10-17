import { m, useMotionValue, useSpring, useTransform } from "framer-motion";
import { CalendarDays, Flag, GraduationCap, House } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLiquidGlass } from "../hooks/useLiquidGlass";
import { useNav, type Tab } from "../hooks/useNav";
import { lensDrag, lensProgress } from "../hooks/useTabLens";
import { useUi } from "../hooks/useUi";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";

export const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: "home", label: "Главная", Icon: House },
  { id: "deadlines", label: "Дедлайны", Icon: Flag },
  { id: "plan", label: "План", Icon: CalendarDays },
  { id: "journal", label: "Журнал", Icon: GraduationCap },
];
export const tabIndex = (t: Tab) => TABS.findIndex((x) => x.id === t);

/** Высота панели с отступом от низа — для отступов контента и кнопки «+». */
export const TABBAR_H = 72;

// Критически затухающая пружина: линза и лента приходят на место без перелёта и дрожания.
const lensSpring = spring(420, 42, 1);

/**
 * Плавающая стеклянная панель (Liquid Glass), только иконки. Под активной вкладкой ездит «линза» с пружиной.
 * Ползунок можно удерживать и вести пальцем: вкладки переключаются по ходу, а лента экранов (App) едет синхронно.
 */
export function TabBar() {
  const { tab, setTab } = useNav();
  const { compact, dragging } = useUi();
  const glassRef = useLiquidGlass<HTMLDivElement>({ radius: Infinity, band: 16, strength: 30 });
  const rowRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(0);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    // Ширина ячейки — без внутренних отступов панели, иначе линза съезжает на каждой следующей вкладке.
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      setCell((el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / TABS.length);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Позиция линзы: пружина к ячейке активной вкладки; при удержании — за пальцем (без пружины).
  const x = useMotionValue(0);
  const xs = useSpring(x, lensSpring);
  useEffect(() => { if (!dragging) x.set(tabIndex(tab) * cell); }, [tab, cell, dragging, x]);
  useEffect(() => { lensDrag.jump = (p) => x.jump(p * cell); return () => { lensDrag.jump = () => {}; }; }, [x, cell]);
  // Публикуем положение в «вкладках» для ленты экранов; «желе» — по скорости пружины.
  const velocity = useMotionValue(0);
  useEffect(() => xs.on("change", (v) => {
    velocity.set(xs.getVelocity());
    if (cell) lensProgress.set(v / cell);
  }), [xs, velocity, cell]);
  const stretch = useTransform(velocity, [-2500, 0, 2500], [1.08, 1, 1.08]);
  const squash = useTransform(stretch, (s) => 1 / Math.sqrt(s));

  // Прокрутку в 0 при переключении делает лента экранов (App: TabTrack), выравнивая страницы без прыжка.
  const select = (t: Tab) => {
    if (t === tab) return;
    haptic.select();
    setTab(t);
  };

  // Удержание ползунка: линза и лента экранов идут за пальцем, вкладка меняется при пересечении ячейки.
  const dragRef = useRef<{ start: number; startX: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { start: e.clientX, startX: tabIndex(tab) * cell, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.start;
    if (!d.moved && Math.abs(dx) < 8) return;
    if (!d.moved) {
      d.moved = true;
      useUi.setState({ dragging: true });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const nx = Math.min(Math.max(d.startX + dx, 0), cell * (TABS.length - 1));
    x.jump(nx);
    const under = TABS[Math.round(nx / cell)].id;
    if (under !== tab) { haptic.select(); setTab(under); }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) { useUi.setState({ dragging: false }); x.set(tabIndex(useNav.getState().tab) * cell); }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4" style={{ paddingBottom: "calc(12px + var(--safe-bottom))" }}>
      <m.nav
        ref={glassRef}
        aria-label="Разделы"
        className="glass pointer-events-auto w-full max-w-[448px] rounded-full"
        animate={{ scale: dragging ? 1.02 : compact ? 0.92 : 1, y: dragging ? -3 : compact ? 8 : 0 }}
        transition={lensSpring}
      >
        <div
          ref={rowRef}
          className="relative grid select-none grid-cols-4 p-1.5 touch-pan-y"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        >
          <m.div
            aria-hidden
            className="glass-lens pointer-events-none"
            style={{ inset: "6px auto 6px 6px", width: cell, x: xs, scaleX: stretch, scaleY: squash }}
          />
          {TABS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => select(id)}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={`relative z-10 grid min-h-[48px] place-items-center rounded-full transition-colors duration-200 ${active ? "text-accent" : "text-hint"}`}
              >
                <m.span animate={{ scale: active ? (dragging ? 1.2 : 1.12) : 1 }} transition={lensSpring}>
                  <Icon size={24} strokeWidth={active ? 2.25 : 1.75} />
                </m.span>
              </button>
            );
          })}
        </div>
      </m.nav>
    </div>
  );
}
