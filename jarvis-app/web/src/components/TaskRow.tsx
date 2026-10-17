import { AnimatePresence, m } from "framer-motion";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";
import type { Task } from "../store/types";

/** Удержание строки задачи (мс) открывает редактирование. */
const LONG_PRESS_MS = 450;
const checkSpring = spring(600, 26);
const PARTICLES = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);

/** Чекбокс: пружинит при нажатии, при выполнении «лопается» частицами (burst — счётчик запусков). */
export function Checkbox({ checked, onToggle, label, burst = 0 }: { checked: boolean; onToggle(): void; label: string; burst?: number }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="relative -m-2.5 grid size-11 shrink-0 place-items-center"
    >
      <AnimatePresence>
        {burst > 0 && (
          <m.span key={burst} aria-hidden className="pointer-events-none absolute inset-0" initial={false} exit={{ opacity: 0 }}>
            {PARTICLES.map((a, i) => (
              <m.i
                key={i}
                className="absolute left-1/2 top-1/2 block size-1.5 rounded-full bg-accent"
                initial={{ x: -3, y: -3, scale: 1, opacity: 1 }}
                animate={{ x: -3 + Math.cos(a) * 18, y: -3 + Math.sin(a) * 18, scale: 0, opacity: 0 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
              />
            ))}
          </m.span>
        )}
      </AnimatePresence>
      <m.span
        initial={false}
        animate={{
          backgroundColor: checked ? "var(--c-accent)" : "rgba(0,0,0,0)",
          borderColor: checked ? "var(--c-accent)" : "var(--c-hint)",
          scale: checked ? [1, 1.25, 1] : 1,
        }}
        whileTap={{ scale: 0.85 }}
        transition={{ duration: 0.3, scale: checkSpring }}
        className="grid size-6 place-items-center rounded-full border-2"
      >
        <m.span initial={false} animate={{ scale: checked ? 1 : 0, opacity: checked ? 1 : 0 }} transition={checkSpring}>
          <Check size={14} strokeWidth={3} className="text-on-accent" />
        </m.span>
      </m.span>
    </button>
  );
}

/**
 * Задача. Одно нажатие — переключить выполнение (зачёркивается сразу, без ожидания).
 * Удержание (450 мс) — открыть редактирование; выполнение при этом не трогаем.
 * Правило одно для всех экранов; выполненные сортируются вниз снаружи (sortTasks).
 */
export function TaskRow({ task, onToggle, onOpen }: { task: Task; onToggle(): void; onOpen?(): void }) {
  const [burst, setBurst] = useState(0);
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const origin = useRef({ x: 0, y: 0 });

  const toggle = () => {
    if (!task.done) { haptic.success(); setBurst((b) => b + 1); } else haptic.tap();
    onToggle();
  };
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!onOpen) return;
    fired.current = false;
    origin.current = { x: e.clientX, y: e.clientY };
    cancel();
    timer.current = window.setTimeout(() => { timer.current = null; fired.current = true; haptic.warning(); onOpen(); }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (timer.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 10) cancel();
  };
  const tap = () => {
    if (fired.current) { fired.current = false; return; } // клик после удержания — не переключать
    toggle();
  };

  return (
    <m.div layout="position" transition={spring(500, 38)} className="flex min-h-12 items-center gap-3 py-2">
      <Checkbox checked={task.done} onToggle={toggle} label={task.text} burst={burst} />
      <button onClick={tap} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
        onContextMenu={(e) => e.preventDefault()} style={{ WebkitTouchCallout: "none" }}
        className="min-h-11 min-w-0 flex-1 select-none text-left touch-manipulation">
        <span
          className={`box-decoration-clone bg-[linear-gradient(currentColor,currentColor)] bg-no-repeat bg-[position:0_55%] text-m transition-[background-size,color] duration-300 ${
            task.done ? "bg-[length:100%_1px] text-hint" : "bg-[length:0%_1px]"
          }`}
        >
          {task.text}
        </span>
        {task.time && <span className="block text-s text-hint tabular">{task.time}</span>}
      </button>
    </m.div>
  );
}

/** Правило для всех экранов: невыполненные по времени, выполненные внизу. */
export const sortTasks = (tasks: Task[]) =>
  [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.time || "99").localeCompare(b.time || "99") || a.createdAt - b.createdAt);
