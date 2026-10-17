import { AnimatePresence, m, useDragControls } from "framer-motion";
import { ChevronLeft, ChevronRight, Flag, ListTodo } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { GroupPicker } from "../components/GroupPicker";
import { LessonRow, matchSubject } from "../components/LessonRow";
import { TaskRow, sortTasks } from "../components/TaskRow";
import { Tile, TileLabel } from "../components/Tile";
import { EmptyState, ProgressBar, Skeleton, SubjectDot, UrgencyBadge } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { WEEKDAYS_SHORT, addDays, dueDayKey, effectiveDue, formatDue, keyToUtc, mskParts, todayKey, weekStart } from "../lib/dates";
import { EDGE_PX } from "../lib/edge";
import { useSchedule } from "../store/schedule";
import type { Deadline } from "../store/types";

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
 * свайп по ней влево/вправо листает дни. Тап по задаче — выполнено, удержание — редактировать (TaskRow).
 */
export function PlanScreen() {
  // Из сторов — только нужные поля (проверка 15 окт): refreshing и moodle «Плану» не нужны, а каждый их set в refresh()
  // перерисовывал вкладку целиком.
  const { status, subjects, deadlines, tasks, toggleTask } = useAppStore(useShallow((s) => ({
    status: s.status, subjects: s.subjects, deadlines: s.deadlines, tasks: s.tasks, toggleTask: s.toggleTask,
  })));
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

  // Расписание — по отдельным полям; forDay читает стор сам, перерисовку при новых данных и подгруппе дают data и subgroup.
  const sched = useSchedule((s) => s.data);
  const subgroup = useSchedule((s) => s.subgroup);
  const forDay = useSchedule((s) => s.forDay);
  const setSubgroup = useSchedule((s) => s.setSubgroup);
  // «Загружаю расписание…» — только пока его нет совсем: обновление поверх копии вкладку не перерисовывает.
  const schedLoading = useSchedule((s) => s.status === "loading" && !s.data);
  const needGroup = !!sched?.needGroup || (!!sched && !sched.group);
  // С отменёнными: «План» показывает их зачёркнутыми; считаются и решают «пар нет» только идущие пары.
  const lessons = forDay(day, true);
  const active = lessons.filter((l) => l.change !== "removed");
  const nowP = mskParts(now);
  const nowHM = `${String(nowP.hh).padStart(2, "0")}:${String(nowP.mm).padStart(2, "0")}`;
  // Открытые дедлайны по дням — один раз на новые данные (проверка 15 окт): точки недели и панель дня звали dueDayKey
  // (Intl) на каждый дедлайн по 8 раз за перерисовку.
  const dlByDay = useMemo(() => {
    const byDay = new Map<string, Deadline[]>();
    for (const d of deadlines) {
      if (d.status !== "open") continue;
      const k = dueDayKey(d.due), list = byDay.get(k);
      if (list) list.push(d); else byDay.set(k, [d]);
    }
    for (const list of byDay.values()) list.sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due));
    return byDay;
  }, [deadlines]);
  const taskDays = useMemo(() => new Set(tasks.filter((t) => !t.done).map((t) => t.date)), [tasks]);
  const dayTasks = useMemo(() => sortTasks(tasks.filter((t) => t.date === day)), [tasks, day]);
  const dayDeadlines = dlByDay.get(day) ?? [];
  const doneCount = dayTasks.filter((t) => t.done).length;
  // Порядок и отметки задач дня — layoutDependency обёрток задач (проверка 15 окт): без неё framer на каждой
  // перерисовке (тик часов, обновление стора посреди прокрутки) снимал и мерил layout, сбрасывая transform ленты;
  // замер нужен, только когда задачи переставляются.
  const taskOrder = dayTasks.map((t) => `${t.id}:${t.done}`).join();

  // Какие дни покрывает загруженное расписание — целыми неделями, от понедельника первой до воскресенья последней
  // (сервер отдаёт текущую и две следующие). «Пар нет» говорим только про них (проверка 15 окт): за пределами пары
  // просто не загружены, и «Свободный день» там был неправдой.
  const range = useMemo(() => {
    let lo = "", hi = "";
    for (const l of sched?.lessons ?? []) { if (!lo || l.date < lo) lo = l.date; if (l.date > hi) hi = l.date; }
    return lo ? { from: weekStart(lo), to: addDays(weekStart(hi), 6) } : null;
  }, [sched]);
  const covered = !!range && !needGroup && day >= range.from && day <= range.to;

  const go = (key: string) => { if (key !== day) { haptic.select(); setDir(key > day ? 1 : -1); setDay(key); } };

  // Свайп по панели дня листает дни (проверка 15 окт). Раньше framer засчитывал и вертикальный взмах: когда браузер
  // забирал прокрутку, pointercancel приходил как конец перетаскивания со скоростью взмаха, и день перескакивал.
  // Теперь день меняется только при захвате по горизонтали (lock), не по pointercancel и с заметным смещением.
  // Перетаскивание запускаем сами и не от края экрана: оттуда свайп листает вкладки, а раньше менялись и вкладка, и день.
  const dragControls = useDragControls();
  const lock = useRef<"x" | "y" | null>(null);

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
            const hasTasks = taskDays.has(k);
            const hasDl = dlByDay.has(k);
            const hasLessons = forDay(k).length > 0;
            return (
              <button key={k} onClick={() => go(k)} aria-label={k} aria-pressed={selected}
                className={`relative flex min-h-14 flex-col items-center justify-center rounded-2xl pt-1 pb-2 text-s font-semibold transition-colors ${selected ? "text-on-accent" : isToday ? "text-accent" : "text-hint"}`}>
                {/* layoutDependency: ползунок мерится только при смене дня, а не на каждой перерисовке (проверка 15 окт). */}
                {selected && <m.span layoutId="plan-day" layoutDependency={day} className="absolute inset-0 -z-10 rounded-2xl bg-accent" transition={spring(520, 40)} />}
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
        // Обёртка режет только по горизонтали (проверка 15 окт): с overflow-x: hidden она становилась скрытым вертикальным
        // скроллером (overflow-y вычислялся в auto) — частицы чекбокса у нижней задачи давали ей что прокрутить, и взмах
        // по панели прилипал к ней. clip скроллера не создаёт; старый WebKit (iOS < 16) clip отбросит — сработает класс.
        // Граница обрезки — у краёв экрана (-mx-4 px-4), а не у краёв плитки: иначе тень плитки снизу обрезалась по бокам
        // и выглядела серой полосой с резкими краями.
        <div className="-mx-4 overflow-x-hidden px-4" style={{ overflowX: "clip" }}>
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <m.div
              key={day}
              custom={dir}
              initial={{ opacity: 0, x: dir * 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -40 }} transition={spring(420, 40)}
              data-own-swipe
              drag="x"
              dragListener={false}
              dragControls={dragControls}
              dragDirectionLock
              dragMomentum={false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.45}
              // При dragListener={false} framer не ставит ни touch-action, ни запрет выделения текста и меню «Скопировать»
              // на долгом нажатии — ставим сами: вертикальную прокрутку отдаём браузеру явно.
              className="select-none"
              style={{ touchAction: "pan-y", WebkitTouchCallout: "none" }}
              // Направление сбрасываем на касании, а не в onDragStart: framer зовёт onDragStart отложенно, уже после
              // onDirectionLock того же кадра, и при резком взмахе стирал только что найденное «x» — день не менялся.
              onPointerDown={(e) => { lock.current = null; if (e.clientX > EDGE_PX && e.clientX < window.innerWidth - EDGE_PX) dragControls.start(e); }}
              onDirectionLock={(axis) => { lock.current = axis; }}
              onDragEnd={(e, info) => {
                // Свайп по панели дня: влево — следующий день, вправо — предыдущий. Быстрый взмах засчитываем, только
                // если панель уже заметно сдвинулась.
                if (e.type === "pointercancel" || lock.current !== "x") return;
                const dx = info.offset.x, vx = info.velocity.x;
                if (dx < -56 || (dx < -24 && vx < -450)) go(addDays(day, 1));
                else if (dx > 56 || (dx > 24 && vx > 450)) go(addDays(day, -1));
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
                      <span className="text-s font-bold text-hint">Пары · {active.length}</span>
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
                {/* «Пар нет» — только для дней, покрытых расписанием, и не вместе с «Свободным днём» ниже (проверка 15 окт). */}
                {covered && active.length === 0 && (dayTasks.length > 0 || dayDeadlines.length > 0 || lessons.length > 0) && (
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
                      <m.div key={t.id} layout="position" layoutDependency={taskOrder} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={spring(420, 34)} className="overflow-hidden">
                        <TaskRow task={t} onToggle={() => toggleTask(t.id)} onOpen={() => push({ name: "task-form", id: t.id })} />
                      </m.div>
                    ))}
                  </AnimatePresence>
                </div>

                {/* Добавления задач нет нигде (просьба владельца): «План» показывает пары, сроки и уже заведённые задачи. */}
                {/* «Свободный день» — только если расписание этот день покрывает; иначе честно: пар мы не знаем. */}
                {dayTasks.length === 0 && dayDeadlines.length === 0 && lessons.length === 0 && (
                  covered ? <EmptyState icon={ListTodo} title="Свободный день" text="Пар и сроков нет." />
                    : <EmptyState icon={ListTodo} title="Сроков нет"
                      text={schedLoading ? "Загружаю расписание…" : needGroup ? "Выберите группу — появятся пары." : "Расписания на этот день пока нет."} />
                )}
              </Tile>
            </m.div>
          </AnimatePresence>
        </div>
      )}
      {/* Про задачи — только когда они есть, и про настоящий жест: правку открывает удержание (TaskRow), двойного
          нажатия нет — оно отмечало и тут же снимало задачу (проверка 15 окт). */}
      <p className="px-1 text-center text-[12px] font-semibold text-hint">
        {dayTasks.length > 0 ? "Нажатие — выполнено, удержание — изменить, свайп по панели — другой день" : "Свайп по панели — другой день"}
      </p>
    </div>
  );
}
