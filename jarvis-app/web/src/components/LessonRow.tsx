import { ChevronRight, FlaskConical, GraduationCap, MapPin, Users } from "lucide-react";
import type { Lesson } from "../store/schedule";
import type { Subject } from "../store/types";

const ICON = { lecture: GraduationCap, lab: FlaskConical, practice: Users, other: Users } as const;

/**
 * Пара в плане дня: время слева, название, тип, аудитория. Цвет — предмета из Moodle, если названия совпали.
 * Изменения по «Дневачу» против расписания МИСИС: отменённая — зачёркнута, новая — с пометкой, у другой аудитории — прежняя.
 */
export function LessonRow({ lesson, subject, past, onOpen }: { lesson: Lesson; subject?: Subject; past?: boolean; onOpen?(): void }) {
  const Icon = ICON[lesson.type];
  // С onOpen строка — кнопка: нажатие открывает экран курса (занятие, преподаватели, работы курса).
  const Row = onOpen ? "button" : "div";
  return (
    <Row onClick={onOpen} className={`flex min-h-12 w-full items-start gap-3 py-2 text-left ${past || lesson.change === "removed" ? "opacity-50" : ""}`}>
      <span className="w-[46px] shrink-0 pt-0.5 text-s font-bold text-hint tabular leading-[17px]">{lesson.start}<br /><span className="font-semibold text-hint/70">{lesson.end}</span></span>
      <span className="mt-[3px] grid size-6 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${subject?.color ?? "var(--c-hint)"} 22%, transparent)`, color: subject?.color ?? "var(--c-hint)" }}>
        <Icon size={13} strokeWidth={2.5} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`line-clamp-2 text-m font-semibold leading-[20px] ${lesson.change === "removed" ? "line-through decoration-red/70" : ""}`}>{lesson.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-s text-hint">
          {lesson.change === "removed" && <span className="font-bold text-red">отменена</span>}
          {lesson.change === "added" && <span className="rounded-full bg-green/15 px-1.5 text-[11px] font-bold text-green">новая</span>}
          <span>{lesson.typeLabel || "Занятие"}</span>
          {lesson.place && <span className={`flex min-w-0 max-w-full items-center gap-0.5 break-words ${lesson.change === "place" ? "font-bold text-yellow" : ""}`}><MapPin size={12} strokeWidth={2.5} className="shrink-0" /><span className="min-w-0">{lesson.place}</span>{lesson.change === "place" && lesson.was ? <span className="font-normal text-hint"> (была {lesson.was})</span> : null}</span>}
          {lesson.subgroup && <span>подгр. {lesson.subgroup}</span>}
        </span>
      </span>
      {onOpen && <ChevronRight size={16} className="mt-1 shrink-0 text-hint/60" />}
    </Row>
  );
}

/** Сопоставление пары с предметом Moodle по названию (без хвоста «. Осень 2026»). */
export function matchSubject(subjects: Subject[], name: string) {
  const n = name.toLowerCase().replace(/ё/g, "е");
  return subjects.find((s) => { const sn = s.name.toLowerCase().replace(/ё/g, "е"); return sn === n || n.startsWith(sn) || sn.startsWith(n); });
}
