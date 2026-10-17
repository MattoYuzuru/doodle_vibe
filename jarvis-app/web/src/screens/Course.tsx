import { CalendarDays, ExternalLink, Flag, MapPin, User } from "lucide-react";
import { useState } from "react";
import { DeadlineRow } from "../components/DeadlineRow";
import { Teachers, useCourseCard } from "../components/Teachers";
import { Tile, TileLabel } from "../components/Tile";
import { SubjectDot } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { effectiveDue, formatLongDate, todayKey } from "../lib/dates";
import { apiBase } from "../store/api";
import { useSchedule, type Lesson } from "../store/schedule";
import { useAppStore } from "../store/useAppStore";
import { haptic, tg } from "../telegram/webapp";

const TYPE_SHORT: Record<Lesson["type"], string> = { lecture: "лекция", lab: "лаб.", practice: "практика", other: "" };
const sameName = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/ё/g, "е"), y = b.toLowerCase().replace(/ё/g, "е");
  return x === y || x.startsWith(y) || y.startsWith(x);
};

/**
 * Курс: открывается нажатием на пару в расписании. Показывает само занятие (время, аудитория, преподаватель из расписания),
 * ближайшие пары этого предмета, преподавателей курса из Moodle с оценками «Кампуса», описание курса и его работы.
 * Если пара не сопоставилась с курсом Moodle (нет такого курса среди актуальных) — остаётся то, что известно из расписания.
 */
export function CourseScreen({ title, subjectId, lesson }: { title: string; subjectId?: string; lesson?: Lesson }) {
  const { subjects, deadlines } = useAppStore();
  const push = useNav((s) => s.push);
  const now = useNow();
  const subject = subjects.find((s) => s.id === subjectId);
  const courseId = subjectId && /^course:\d+$/.test(subjectId) ? Number(subjectId.slice(7)) : null;
  const today = todayKey();
  const { data: sched, subgroup } = useSchedule();
  // Ближайшие занятия этого предмета (с сегодняшнего дня, своя подгруппа), не больше шести.
  const upcoming = (sched?.lessons ?? [])
    .filter((l) => sameName(l.name, title) && l.date >= today && (!l.subgroup || l.subgroup === subgroup) && l.change !== "removed")
    .slice(0, 6);
  const works = deadlines.filter((d) => d.subjectId === subjectId).sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due));
  const open = works.filter((d) => d.status === "open"), done = works.filter((d) => d.status === "done");

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <p className="flex items-center gap-1.5 text-s font-semibold text-hint"><SubjectDot color={subject?.color} />Курс{lesson?.typeLabel ? ` · ${lesson.typeLabel}` : ""}</p>
        <h1 className="font-display mt-1 text-[24px] leading-[1.15] font-extrabold tracking-[-0.02em]">{subject?.name ?? title}</h1>
      </div>

      {lesson && (
        <Tile index={0} className="!min-h-0 py-3">
          <TileLabel>Занятие</TileLabel>
          <p className="mt-2 flex items-center gap-2 text-m font-semibold"><CalendarDays size={16} strokeWidth={2.25} className="shrink-0 text-accent" />{formatLongDate(lesson.date)}, {lesson.start}–{lesson.end}</p>
          {lesson.place && <p className="mt-1.5 flex items-center gap-2 text-m"><MapPin size={16} strokeWidth={2.25} className="shrink-0 text-accent" />{lesson.place}</p>}
          {lesson.teacher && <p className="mt-1.5 flex items-center gap-2 text-m"><User size={16} strokeWidth={2.25} className="shrink-0 text-accent" />{lesson.teacher}</p>}
          {lesson.subgroup && <p className="mt-1.5 text-s text-hint">Подгруппа {lesson.subgroup}</p>}
        </Tile>
      )}

      {courseId ? (
        <>
          <Teachers courseId={courseId} title="Преподаватели курса" index={1} showEmpty reviews={false} />
          <CourseAbout courseId={courseId} />
        </>
      ) : (
        <Tile index={1} className="!min-h-0 py-3">
          <TileLabel>Курс в Moodle</TileLabel>
          <p className="mt-1 text-s text-hint">Среди ваших актуальных курсов Moodle такого названия нет, поэтому показано только то, что есть в расписании. Если курс есть в Moodle — включите его: Профиль → Курсы.</p>
        </Tile>
      )}

      {upcoming.length > 0 && (
        <Tile index={2} className="!min-h-0 py-1">
          <TileLabel className="pt-2">Ближайшие занятия</TileLabel>
          {upcoming.map((l, i) => (
            <div key={i} className="flex min-h-11 items-center justify-between gap-3 border-t border-separator text-s first:border-t-0">
              <span className="min-w-0 truncate font-semibold">{formatLongDate(l.date)}</span>
              <span className="shrink-0 text-hint tabular">{l.start}–{l.end}{l.place ? ` · ${l.place}` : ""}{TYPE_SHORT[l.type] ? ` · ${TYPE_SHORT[l.type]}` : ""}</span>
            </div>
          ))}
        </Tile>
      )}

      {courseId && (
        <Tile index={3} className="!min-h-0 px-0 py-1">
          <TileLabel className="flex items-baseline gap-2 px-4 pt-2 pb-1"><Flag size={13} strokeWidth={2.5} />Работы курса<span className="text-hint/70">{open.length}{done.length ? ` · сдано ${done.length}` : ""}</span></TileLabel>
          {works.length === 0 && <p className="px-4 pb-3 text-s text-hint">В Moodle у этого курса сейчас нет работ со сроком.</p>}
          {[...open, ...done].slice(0, 12).map((d) => (
            <div key={d.id} className="border-t border-separator px-4 first:border-t-0">
              <DeadlineRow deadline={d} subject={subject} now={now} onOpen={() => { haptic.tap(); push({ name: "deadline", id: d.id }); }} />
            </div>
          ))}
        </Tile>
      )}
    </div>
  );
}

/** Описание курса из Moodle и ссылка на его страницу (через прокладку сервера: приложение Moodle, а без него — сайт). */
function CourseAbout({ courseId }: { courseId: number }) {
  const card = useCourseCard(courseId);
  const [full, setFull] = useState(false);
  if (!card) return null; // грузится или сервер не отдал описание
  const open = () => { const go = `${apiBase()}go/moodle?u=${encodeURIComponent(card.url)}`; if (tg?.openLink) tg.openLink(go); else window.open(go, "_blank"); };
  return (
    <>
      {(card.summary || card.fullname) && (
        <Tile index={1} className="!min-h-0 py-3">
          <TileLabel>О курсе</TileLabel>
          {card.fullname && <p className="mt-2 text-s font-semibold text-hint">{card.fullname}</p>}
          {card.summary && (
            <>
              <p className={`mt-2 whitespace-pre-line text-s leading-[19px] ${full ? "" : "line-clamp-5"}`}>{card.summary}</p>
              {card.summary.length > 260 && <button onClick={() => setFull((f) => !f)} className="mt-1 min-h-9 text-s font-bold text-accent">{full ? "Свернуть" : "Показать полностью"}</button>}
            </>
          )}
        </Tile>
      )}
      <button onClick={open} className="glass flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
        <ExternalLink size={18} strokeWidth={2.5} /> Открыть курс в Moodle
      </button>
    </>
  );
}
