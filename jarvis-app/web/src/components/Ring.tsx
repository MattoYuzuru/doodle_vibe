import { m } from "framer-motion";
import { spring } from "../theme/motion";

/** Кольцо прогресса: дуга заполняется с пружиной от 0 до value (0…1). */
export function Ring({ value, size = 44, stroke = 5, color = "var(--c-accent)", delay = 0, className = "" }: {
  value: number; size?: number; stroke?: number; color?: string; delay?: number; className?: string;
}) {
  const r = (size - stroke) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-raised)" strokeWidth={stroke} />
      <m.circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        style={{ rotate: -90, transformOrigin: "50% 50%" }}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: Math.max(Math.min(value, 1), 0.001) }}
        transition={{ ...spring(90, 20), delay }}
      />
    </svg>
  );
}
