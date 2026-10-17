import { MessageSquareText } from "lucide-react";
import { formatDue } from "../lib/dates";
import type { Deadline, Subject } from "../store/types";
import { kindOf } from "../theme/kinds";
import { SubjectDot, UrgencyBadge } from "./ui";

/** Строка дедлайна: точка предмета, название (до 2 строк), справа срок с бейджем; ниже предмет и тип работы с иконкой. */
export function DeadlineRow({ deadline, subject, now, onOpen }: {
  deadline: Deadline; subject?: Subject; now: number; onOpen(): void;
}) {
  const kind = kindOf(deadline.kind);
  return (
    <button onClick={onOpen} className="flex min-h-14 w-full items-start gap-3 py-3 text-left">
      <SubjectDot color={subject?.color} className="mt-[7px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-3">
          <span className="line-clamp-2 min-w-0 flex-1 text-m font-semibold">{deadline.title}</span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-s text-hint tabular">{formatDue(deadline.due)}</span>
            <UrgencyBadge deadline={deadline} now={now} />
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-s text-hint">
          <kind.Icon size={13} strokeWidth={2.25} className="shrink-0" />
          <span className="truncate">{subject?.name ?? "Без предмета"} · {kind.label}</span>
          {/* Есть замечания преподавателя — значок с их числом (подробности в карточке работы). Когда все они уже учтены
              в исправленном отчёте или находятся у агента, значок серый; новое замечание снова делает его цветным. */}
          {!!deadline.remarks?.length && (
            <span className={`flex shrink-0 items-center gap-0.5 font-semibold ${deadline.remarks.every((r) => r.state === "fixed" || r.state === "work") ? "text-hint" : "text-accent"}`}>
              <MessageSquareText size={12} strokeWidth={2.5} />{deadline.remarks.filter((r) => r.state === "new").length || deadline.remarks.length}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
