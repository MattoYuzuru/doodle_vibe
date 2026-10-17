import { AnimatePresence, m } from "framer-motion";
import { ChevronLeft, ChevronRight, Flag, ListTodo } from "lucide-react";
import { useState } from "react";
import { GroupPicker } from "../components/GroupPicker";
import { LessonRow, matchSubject } from "../components/LessonRow";
import { TaskRow, sortTasks } from "../components/TaskRow";
import { Tile, TileLabel } from "../components/Tile";
import { EmptyState, ProgressBar, Skeleton, SubjectDot, UrgencyBadge } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { WEEKDAYS_SHORT, addDays, dueDayKey, effectiveDue, formatDue, keyToUtc, mskParts, todayKey, weekStart } from "../lib/dates";
import { useSchedule } from "../store/schedule";

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
/** «2026-10-01» → «1 окт» */
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;
import { subjectOf, useAppStore } from "../store/useAppStore";
import { kindOf } from "../theme/kinds";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";

const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

function dayTitle(key: string, today: string) {
  const d = new Date(keyToUtc(key));
  const date = `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`;
  if (key === today) return `Сегодня, ${date}`;
  if (key === addDays(today, 1)) return `Завтра, ${date}`;
  if (key === addDays(today, -1)) return `Вчера, ${date}`;
  const w = WEEKDAYS[(d.getUTCDay() + 6) % 7];
  return `${w[0].toUpperCase()}${w.slice(1)}, ${date}`;
}

/**
 * План: неделя с точками, панель дня из задач и дедлайнов. Панель прижата к низу экрана (под большой палец),
 * свайп по ней влево/вправо листает дни. Тап по задаче — выполнено, двойной — редактировать.
 */
export function PlanScreen() {
  const { status, subjects, deadlines, tasks, toggleTask } = useAppStore();
  const push = useNav((s) => s.push);
  const now = useNow();
  const today = todayKey();
  const [day, setDay] = useState(today);
  const [dir, setDir] = useState(1);
  const ws = weekStart(day);
  const week = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const wsDate = new Date(keyToUtc(ws)), weDate = new Date(keyToUtc(addDays(ws, 6)));
  const monthTitle = wsDate.getUTCMonth() === weDate.getUTCMonth()
    ? `${MONTHS_NOM[wsDate.getUTCMonth()]} ${wsDate.getUTCFullYear()}`
    : `${MONTHS_NOM[wsDate.getUTCMonth()]} – ${MONTHS_NOM[weDate.getUTCMonth()]}`;

  const { forDay, subgroup, setSubgroup, data: sched } = useSchedule();
  const needGroup = !!sched?.needGroup || (!!sched && !sched.group);
  // С отменёнными: «План» показывает их зачёркнутыми; считаются и решают «пар нет» только идущие пары.
  const lessons = forDay(day, true);
  const active = lessons.filter((l) => l.change !== "removed");
  const nowP = mskParts(now);
  const nowHM = `${String(nowP.hh).padStart(2, "0")}:${String(nowP.mm).padStart(2, "0")}`;
  const openDl = deadlines.filter((d) => d.status === "open");
  const dayTasks = sortTasks(tasks.filter((t) => t.date === day));
  const dayDeadlines = openDl.filter((d) => dueDayKey(d.due) === day).sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due));
  const doneCount = dayTasks.filter((t) => t.done).length;

  const go = (key: string) => { if (key !== day) { haptic.select(); setDir(key > day ? 1 : -1); setDay(key); } };

  return (
    // Панель дня — сразу под строкой недели (раньше прижималась к низу экрана, и между ними зияла пустота).
    <div className="flex flex-col gap-3">
      <m.header className="flex items-center justify-between px-1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <div>
          <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">План</h1>
          <p className="mt-0.5 text-s font-semibold text-hint first-letter:uppercase">{monthTitle}</p>
        </div>
        {day !== today && (
          <button onClick={() => go(today)} className="glass min-h-9 rounded-full px-3.5 text-s font-bold text-accent">Сегодня</button>
        )}
      </m.header>

      {/* Неделя: стрелки листают на 7 дней, точки под днями — задачи (акцент) и дедлайны (красная). */}
      <div className="glass flex items-center gap-1 rounded-[22px] p-1.5">
        <button onClick={() => go(addDays(day, -7))} aria-label="Предыдущая неделя" className="grid size-10 shrink-0 place-items-center rounded-full text-hint"><ChevronLeft size={20} /></button>
        <div className="grid flex-1 grid-cols-7 gap-0.5">
          {week.map((k, i) => {
            const selected = k === day, isToday = k === today;
            const hasTasks = tasks.some((t) => t.date === k && !t.done);
            const hasDl = openDl.some((d) => dueDayKey(d.due) === k);
            const hasLessons = forDay(k).length > 0;
            return (
              <button key={k} onClick={() => go(k)} aria-label={k} aria-pressed={selected}
                className={`relative flex min-h-14 flex-col items-center justify-center rounded-2xl pt-1 pb-2 text-s font-semibold transition-colors ${selected ? "text-on-accent" : isToday ? "text-accent" : "text-hint"}`}>
                {selected && <m.span layoutId="plan-day" className="absolute inset-0 -z-10 rounded-2xl bg-accent" transition={spring(520, 40)} />}
                <span className="text-[11px] uppercase">{WEEKDAYS_SHORT[i]}</span>
                <span className={`text-m font-bold tabular ${selected ? "" : isToday ? "text-accent" : "text-text"}`}>{new Date(keyToUtc(k)).getUTCDate()}</span>
                <span className="mt-0.5 flex h-1 gap-0.5">
                  {hasLessons && <i className={`size-1 rounded-full ${selected ? "bg-on-accent/50" : "bg-hint/60"}`} />}
                  {hasTasks && <i className={`size-1 rounded-full ${selected ? "bg-on-accent" : "bg-accent"}`} />}
                  {hasDl && <i className={`size-1 rounded-full ${selected ? "bg-on-accent/70" : "bg-red"}`} />}
                </span>
              </button>
            );
          })}
        </div>
        <button onClick={() => go(addDays(day, 7))} aria-label="Следующая неделя" className="grid size-10 shrink-0 place-items-center rounded-full text-hint"><ChevronRight size={20} /></button>
      </div>

      {needGroup && <GroupPicker />}

      {status === "loading" ? (
        <Skeleton className="h-64 rounded-[22px]" />
      ) : (
        <div className="overflow-x-hidden">
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <m.div
              key={day}
              custom={dir}
              initial={{ opacity: 0, x: dir * 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -40 }} transition={spring(420, 40)}
              data-own-swipe
              drag="x"
              dragDirectionLock
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.45}
              onDragEnd={(_, info) => {
                // Свайп по панели дня: влево — следующий день, вправо — предыдущий.
                if (info.offset.x < -56 || info.velocity.x < -450) go(addDays(day, 1));
                else if (info.offset.x > 56 || info.velocity.x > 450) go(addDays(day, -1));
              }}
            >
              <Tile index={0} className="min-h-0 px-0 pb-2">
                <div className="px-4">
                  <TileLabel className="flex items-baseline justify-between">
                    <span>{dayTitle(day, today)}</span>
                    {dayTasks.length > 0 && <span className="text-hint/70 normal-case tracking-normal">Выполнено {doneCount} из {dayTasks.length}</span>}
                  </TileLabel>
                  {dayTasks.length > 0 && <div className="mt-3"><ProgressBar value={doneCount / dayTasks.length} /></div>}
                </div>

                {/* Пары из расписания группы: до первой задачи, прошедшие сегодня приглушены. */}
                {lessons.length > 0 && (
                  <div className="mt-1 px-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-hint">Пары · {active.length}</span>
                      <div className="flex gap-1">
                        {(["1", "2"] as const).map((s) => (
                          <button key={s} onClick={() => { haptic.select(); setSubgroup(s); }} aria-pressed={subgroup === s}
                            className={`min-h-7 rounded-full px-2.5 text-[12px] font-bold ${subgroup === s ? "bg-accent text-on-accent" : "bg-raised text-hint"}`}>подгр. {s}</button>
                        ))}
                      </div>
                    </div>
                    {/* Основа — расписание МИСИС; где «Дневач» показывает перенос, отмену или замену — пометка (и уведомление в Telegram). */}
                    {lessons.some((l) => l.change) && (
                      <p className="mt-1 text-[12px] font-semibold leading-4 text-yellow">Есть изменения против расписания МИСИС{sched?.official?.updated ? ` от ${shortDate(sched.official.updated)}` : ""} — по данным «Дневача».</p>
                    )}
                    {lessons.map((l, i) => (
                      <LessonRow key={i} lesson={l} subject={matchSubject(subjects, l.name)} past={day < today || (day === today && l.end <= nowHM)}
                        onOpen={() => { haptic.tap(); push({ name: "course", title: l.name, subjectId: matchSubject(subjects, l.name)?.id, lesson: l }); }} />
                    ))}
                  </div>
                )}
                {active.length === 0 && sched && day >= today && (day <= (sched.lessons.at(-1)?.date ?? "")) && (
                  <p className="px-4 pt-2 text-s text-hint">Пар нет</p>
                )}

                {dayDeadlines.map((d) => {
                  const s = subjectOf(subjects, d.subjectId), kind = kindOf(d.kind);
                  return (
                    <button key={d.id} onClick={() => push({ name: "deadline", id: d.id })}
                      className="mt-1 flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${s?.color ?? "var(--c-hint)"} 22%, transparent)`, color: s?.color }}>
                        <Flag size={13} strokeWidth={2.5} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-m font-semibold">{d.title}</span>
                        <span className="flex items-center gap-1.5 text-s text-hint"><SubjectDot color={s?.color} /><span className="truncate">{s?.short ?? "Без предмета"} · {kind.label} · {formatDue(d.due)}</span></span>
                      </span>
                      <UrgencyBadge deadline={d} now={now} />
                    </button>
                  );
                })}

                <div className="px-4">
                  <AnimatePresence initial={false}>
                    {dayTasks.map((t) => (
                      <m.div key={t.id} layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={spring(420, 34)} className="overflow-hidden">
                        <TaskRow task={t} onToggle={() => toggleTask(t.id)} onOpen={() => push({ name: "task-form", id: t.id })} />
                      </m.div>
                    ))}
                  </AnimatePresence>
                </div>

                {/* Добавления задач нет нигде (просьба владельца): «План» показывает пары, сроки и уже заведённые задачи. */}
                {dayTasks.length === 0 && dayDeadlines.length === 0 && lessons.length === 0 && (
                  <EmptyState icon={ListTodo} title="Свободный день" text="Пар и сроков нет." />
                )}
              </Tile>
            </m.div>
          </AnimatePresence>
        </div>
      )}
      <p className="px-1 text-center text-[12px] font-semibold text-hint">Нажатие — выполнено, двойное — изменить, свайп по панели — другой день</p>
    </div>
  );
}
