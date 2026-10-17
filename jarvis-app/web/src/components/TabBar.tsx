import { m, useMotionValue, useSpring, useTransform } from "framer-motion";
import { CalendarDays, GraduationCap, House, ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLiquidGlass } from "../hooks/useLiquidGlass";
import { useNav, type Tab } from "../hooks/useNav";
import { lensDrag, lensProgress } from "../hooks/useTabLens";
import { useUi } from "../hooks/useUi";
import { SWIPE_SLOP } from "../lib/edge";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";

export const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: "home", label: "Главная", Icon: House },
  { id: "deadlines", label: "Дедлайны", Icon: ListChecks },
  { id: "plan", label: "План", Icon: CalendarDays },
  { id: "journal", label: "Журнал", Icon: GraduationCap },
];
export const tabIndex = (t: Tab) => TABS.findIndex((x) => x.id === t);

/** Высота панели с отступом от низа — для отступов контента и кнопки «+». */
export const TABBAR_H = 80; // панель с подписями под иконками (18 окт 2026)

// Критически затухающая пружина: линза и лента приходят на место без перелёта и дрожания.
const lensSpring = spring(420, 42, 1);

/**
 * Плавающая стеклянная панель (Liquid Glass), только иконки. Под активной вкладкой ездит «линза» с пружиной.
 * Ползунок можно удерживать и вести пальцем: линза и лента экранов (App) едут за пальцем, подсвечивается иконка под
 * линзой, а вкладка меняется при отпускании.
 */
export function TabBar() {
  // Только нужные поля (проверка 15 окт): подписка на весь стор перерисовывала панель на каждое открытие экрана.
  const tab = useNav((s) => s.tab);
  const setTab = useNav((s) => s.setTab);
  const compact = useUi((s) => s.compact);
  const dragging = useUi((s) => s.dragging);
  const keyboard = useUi((s) => s.keyboard);
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

  // Вкладка под линзой, пока её ведут пальцем (здесь или свайпом по ленте): сама вкладка меняется только при
  // отпускании (проверка 15 окт), а подсветку иконки ведём от положения линзы. Перерисовка — только при смене ячейки.
  const [lit, setLit] = useState(() => tabIndex(tab));
  const litRef = useRef(lit);
  useEffect(() => lensProgress.on("change", (p) => {
    const i = Math.min(Math.max(Math.round(p), 0), TABS.length - 1);
    if (i !== litRef.current) { litRef.current = i; setLit(i); }
  }), []);
  const shownIdx = dragging ? lit : tabIndex(tab);

  // Прокрутку в 0 при переключении делает лента экранов (App: TabTrack), выравнивая страницы без прыжка.
  const select = (t: Tab) => {
    if (t === tab) return;
    haptic.select();
    setTab(t);
  };

  // Удержание ползунка: линза и лента экранов идут за пальцем, вибро — при пересечении ячейки, вкладка — при отпускании.
  // Как и свайп по ленте (App: TabTrack), жест берём, только когда браузер уже не забрал его под прокрутку: палец ушёл
  // на SWIPE_SLOP без pointercancel и больше вбок, чем вверх-вниз (проверка 15 окт).
  const dragRef = useRef<{ x0: number; y0: number; startX: number; moved: boolean; under: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x0: e.clientX, y0: e.clientY, startX: tabIndex(tab) * cell, moved: false, under: tabIndex(tab) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) { dragRef.current = null; return; }
      d.moved = true;
      useUi.setState({ dragging: true });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const nx = Math.min(Math.max(d.startX + dx, 0), cell * (TABS.length - 1));
    x.jump(nx);
    const under = Math.round(nx / cell);
    if (under !== d.under) { d.under = under; haptic.select(); }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.moved) return;
    const next = TABS[d.under].id;
    useUi.setState({ dragging: false });
    setTab(next);
    x.set(tabIndex(next) * cell);
  };
  // Отмена (браузер забрал жест, пришёл звонок) — ничего не переключаем: линза пружиной возвращается на свою вкладку.
  const onPointerCancel = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.moved) return;
    useUi.setState({ dragging: false });
    x.set(tabIndex(useNav.getState().tab) * cell);
  };

  // Открыта клавиатура — панель уезжает вниз и не закрывает поле ввода (проверка 15 окт).
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4" style={{ paddingBottom: "calc(12px + var(--safe-bottom))" }}>
      <m.nav
        ref={glassRef}
        aria-label="Разделы"
        aria-hidden={keyboard || undefined}
        className={`glass glass-float w-full max-w-[448px] rounded-full ${keyboard ? "" : "pointer-events-auto"}`}
        animate={{ scale: dragging ? 1.02 : compact ? 0.92 : 1, y: keyboard ? 140 : dragging ? -3 : compact ? 8 : 0, opacity: keyboard ? 0 : 1 }}
        transition={lensSpring}
      >
        <div
          ref={rowRef}
          className="relative grid select-none grid-cols-4 p-1.5 touch-pan-y"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        >
          <m.div
            aria-hidden
            className="glass-lens pointer-events-none"
            // Мягкая синяя подсветка активной вкладки вместо серой линзы (18 окт 2026).
            style={{ inset: "6px auto 6px 6px", width: cell, x: xs, scaleX: stretch, scaleY: squash, background: "color-mix(in srgb, var(--c-accent) 16%, transparent)" }}
          />
          {TABS.map(({ id, label, Icon }, i) => {
            const active = shownIdx === i;
            return (
              <button
                key={id}
                onClick={() => select(id)}
                aria-label={label}
                aria-current={tab === id ? "page" : undefined}
                tabIndex={keyboard ? -1 : undefined}
                className={`relative z-10 flex min-h-[56px] flex-col items-center justify-center gap-0.5 rounded-full transition-colors duration-200 ${active ? "text-accent" : "text-hint"}`}
              >
                <m.span animate={{ scale: active ? (dragging ? 1.12 : 1.05) : 1 }} transition={lensSpring}>
                  <Icon size={22} strokeWidth={active ? 2.25 : 1.85} />
                </m.span>
                {/* Подпись под иконкой: разделы понятны без угадывания (18 окт 2026). */}
                <span className="text-[11px] leading-[14px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </m.nav>
    </div>
  );
}
