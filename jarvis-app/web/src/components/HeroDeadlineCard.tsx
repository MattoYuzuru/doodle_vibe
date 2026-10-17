import { m } from "framer-motion";
import { effectiveDue, elapsedParts, formatDue, leftParts } from "../lib/dates";
import { heroGradient, urgencyOf } from "../theme/urgency";
import type { Deadline, Subject } from "../store/types";
import { kindOf } from "../theme/kinds";
import { spring, stagger } from "../theme/motion";
import { RollingNumber } from "./RollingNumber";
import { SubjectDot } from "./ui";

const LABEL = { overdue: "Просрочено", urgent: "Меньше суток", soon: "Скоро срок", calm: "Ближайший дедлайн", done: "Сдано" } as const;

/** Большая карточка ближайшего дедлайна: обратный отсчёт, градиент по срочности. */
export function HeroDeadlineCard({ deadline, subject, now, onOpen }: {
  deadline: Deadline; subject?: Subject; now: number; onOpen(): void;
}) {
  const u = urgencyOf(deadline, now);
  const overdue = effectiveDue(deadline.due) <= now;

  return (
    <m.button
      onClick={onOpen}
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...spring(380, 30), delay: stagger(0) }}
      whileTap={{ scale: 0.975 }}
      className="relative col-span-2 block w-full overflow-hidden rounded-[22px] p-4 text-left text-white shadow-lg shadow-black/20"
      style={{ background: heroGradient[u] }}
    >
      {/* кольца, как в варианте B, медленно «дышат»; блик пробегает по карточке при появлении */}
      <m.span aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-56 rounded-full border border-white/15"
        animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }} />
      <m.span aria-hidden className="pointer-events-none absolute -top-16 -right-8 size-40 rounded-full border border-white/15"
        animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut", delay: 0.6 }} />
      <m.span aria-hidden className="pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent"
        initial={{ x: "-120%" }} animate={{ x: "280%" }} transition={{ duration: 0.9, delay: 0.25, ease: "easeOut" }} />

      <div className="relative flex items-center justify-between gap-2 text-s font-medium text-white/80">
        <span>{LABEL[u]}</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 font-semibold text-white">{kindOf(deadline.kind).label}</span>
      </div>

      <div className="font-display relative mt-3 text-l font-bold tabular">
        {(overdue ? elapsedParts(deadline.due, now) : leftParts(deadline.due, now)).map(([n, unit]) => (
          <span key={unit} className="mr-2">
            <RollingNumber value={n} /><span className="ml-0.5 text-m font-semibold text-white/70">{unit}</span>
          </span>
        ))}
        {overdue && <span className="text-m font-semibold text-white/70">назад</span>}
      </div>

      <p className="relative mt-1 line-clamp-2 text-m font-semibold">{deadline.title}</p>

      <div className="relative mt-4 flex items-center justify-between gap-3 text-s text-white/80">
        <span className="flex min-w-0 items-center gap-2">
          <SubjectDot color={subject?.color} className="ring-2 ring-white/40" />
          <span className="truncate">{subject?.short ?? "Без предмета"} · {kindOf(deadline.kind).label}</span>
        </span>
        <span className="shrink-0 tabular">{formatDue(deadline.due)}</span>
      </div>
    </m.button>
  );
}
