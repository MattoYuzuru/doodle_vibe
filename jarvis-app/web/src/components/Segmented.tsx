import { m } from "framer-motion";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";

/** Стеклянный переключатель с плавающей линзой под выбранным пунктом. */
export function Segmented<T extends string>({ value, options, onChange, id }: {
  value: T; options: { value: T; label: string }[]; onChange(v: T): void; id: string;
}) {
  return (
    <div className="glass relative grid rounded-full p-1" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => { if (!active) { haptic.select(); onChange(o.value); } }}
            className={`relative z-10 min-h-10 rounded-full text-s font-bold transition-colors duration-200 ${active ? "text-text" : "text-hint"}`}
          >
            {active && <m.span layoutId={`seg-${id}`} className="glass-lens -z-10" transition={spring(520, 34)} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
