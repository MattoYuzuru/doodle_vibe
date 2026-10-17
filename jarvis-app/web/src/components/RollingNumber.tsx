import { AnimatePresence, m } from "framer-motion";
import { lite } from "../lib/perf";

const BLUR = lite ? {} : { filter: "blur(2px)" };
const SHARP = lite ? {} : { filter: "blur(0px)" };

/** Число, у которого каждая цифра перекатывается вверх/вниз при изменении (как счётчик). */
export function RollingNumber({ value, className = "" }: { value: number; className?: string }) {
  const digits = String(value).split("");
  return (
    <span className={`inline-flex overflow-hidden align-baseline ${className}`} aria-label={String(value)}>
      {digits.map((d, i) => (
        <span key={digits.length - i} className="relative inline-block" style={{ width: "0.62em", height: "1.05em" }}>
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={d}
              className="absolute inset-x-0 top-0 text-center"
              initial={{ y: "70%", opacity: 0, ...BLUR }}
              animate={{ y: 0, opacity: 1, ...SHARP }}
              exit={{ y: "-70%", opacity: 0, ...BLUR }}
              transition={{ type: "spring", stiffness: 480, damping: 32 }}
            >
              {d}
            </m.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}
