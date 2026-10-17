import { m } from "framer-motion";
import { effectiveDue, elapsedParts, formatDue, leftParts } from "../lib/dates";
import { heroGradient, urgencyOf } from "../theme/urgency";
import type { Deadline, Subject } from "../store/types";
import { kindOf } from "../theme/kinds";
import { spring, stagger } from "../theme/motion";
import { RollingNumber } from "./RollingNumber";
import { subjectIcon } from "../lib/subjectIcon";

const LABEL = { overdue: "Просрочено", urgent: "Меньше суток", soon: "Скоро срок", calm: "Ближайший дедлайн", done: "Сдано" } as const;

/** Большая карточка ближайшего дедлайна: обратный отсчёт, градиент по срочности. */
export function HeroDeadlineCard({ deadline, subject, now, onOpen }: {
  deadline: Deadline; subject?: Subject; now: number; onOpen(): void;
}) {
  const u = urgencyOf(deadline, now);
  const overdue = effectiveDue(deadline.due) <= now;
  const kind = kindOf(deadline.kind).label;
  // Плашка типа не повторяет название: «Контрольная» рядом с «Контрольная работа № 1» — лишнее (18 окт 2026).
  const kindInTitle = deadline.title.toLowerCase().includes(kind.toLowerCase().slice(0, 6));
  const SubjectIcon = subjectIcon(subject?.name, subject?.short);

  return (
    // Нажатие — CSS :active с задержкой входа, как у Tile (проверка 15 окт): whileTap сжимал карточку на каждом
    // pointerdown, в том числе в начале взмаха.
    <m.button
      onClick={onOpen}
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...spring(380, 30), delay: stagger(0) }}
      className="relative col-span-2 block w-full overflow-hidden rounded-[22px] p-4 text-left text-white shadow-lg shadow-black/20 transition-[scale] duration-150 ease-out active:scale-[0.975] active:delay-75"
      style={{ background: heroGradient[u] }}
    >
      {/* Едва заметная иконка дисциплины вместо колец (18 окт 2026): акцент — на сроке и названии, иконка — фон. */}
      <SubjectIcon aria-hidden className="pointer-events-none absolute top-4 right-4 text-white opacity-[0.14]" size={72} strokeWidth={1.75} />
      <m.span aria-hidden className="pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent"
        initial={{ x: "-120%" }} animate={{ x: "280%" }} transition={{ duration: 0.9, delay: 0.25, ease: "easeOut" }} />

      <div className="relative flex items-center justify-between gap-2 text-s font-medium text-white/80">
        <span>{LABEL[u]}</span>
        {!kindInTitle && <span className="relative mr-20 rounded-full bg-white/20 px-2 py-0.5 font-semibold text-white">{kind}</span>}
      </div>

      <div className="font-display relative mt-2 text-[40px] leading-[44px] font-extrabold tracking-[-0.02em] tabular">
        {(overdue ? elapsedParts(deadline.due, now) : leftParts(deadline.due, now)).map(([n, unit]) => (
          <span key={unit} className="mr-2">
            <RollingNumber value={n} /><span className="ml-0.5 text-[18px] font-bold tracking-normal text-white/70">{unit}</span>
          </span>
        ))}
        {overdue && <span className="text-[18px] font-bold tracking-normal text-white/70">назад</span>}
      </div>

      <p className="relative mt-1 line-clamp-2 text-[19px] leading-[24px] font-bold">{deadline.title}</p>

      <div className="relative mt-4 flex items-center justify-between gap-3 text-s text-white/80">
        <span className="min-w-0 truncate">{subject?.short ?? "Без предмета"}</span>
        <span className="shrink-0 tabular">{formatDue(deadline.due)}</span>
      </div>
    </m.button>
  );
}
