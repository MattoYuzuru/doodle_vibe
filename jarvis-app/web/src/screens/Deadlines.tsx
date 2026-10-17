import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, Flag, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { DeadlineRow } from "../components/DeadlineRow";
import { MoodleFailed } from "../components/MoodleDown";
import { Segmented } from "../components/Segmented";
import { Tile, TileLabel } from "../components/Tile";
import { EmptyState, Skeleton } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { addDays, dueDayKey, effectiveDue, todayKey, weekStart } from "../lib/dates";
import { plural } from "../lib/journal";
import type { Deadline, DeadlineKind } from "../store/types";
import { subjectOf, useAppStore, useFirstLoad } from "../store/useAppStore";
import { KINDS } from "../theme/kinds";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";

type Mode = "active" | "done";
type KindFilter = DeadlineKind | "all";
/** Сколько работ группы «Позже» видно сразу; остальные — по кнопке «Показать все». */
const LATER_LIMIT = 4;
const MODES: { value: Mode; label: string }[] = [{ value: "active", label: "Активные" }, { value: "done", label: "Сданные" }];

/** Дедлайны: секции «Просрочено / Эта неделя / Следующая неделя / Позже», фильтр по типу работы.
 * «Сдано», «Вернуть» и «Удалить» — в карточке дедлайна (нажатие на строку), свайпы по строкам убраны: свайп листает вкладки. */
export function DeadlinesScreen() {
  // Из стора — только нужные поля, а не весь (проверка 15 окт): иначе каждый set в refresh() перерисовывал вкладку.
  const { status, subjects, deadlines } = useAppStore(useShallow((s) => ({ status: s.status, subjects: s.subjects, deadlines: s.deadlines })));
  const { pending, failed } = useFirstLoad();
  const push = useNav((s) => s.push);
  const now = useNow();
  const [mode, setMode] = useState<Mode>("active");
  const [kind, setKind] = useState<KindFilter>("all");
  const [laterOpen, setLaterOpen] = useState(false);
  const today = todayKey();

  // Сортировка и группы пересчитываются только при новых данных, тике часов или смене фильтра (проверка 15 окт):
  // effectiveDue и dueDayKey зовут Intl, и на 80 дедлайнах это сотни вызовов на каждую перерисовку.
  const { openAll, doneAll, kindCounts } = useMemo(() => {
    const sorted = [...deadlines].sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due));
    return {
      openAll: sorted.filter((d) => d.status === "open"),
      doneAll: sorted.filter((d) => d.status === "done"),
      // Фильтр по типу показываем, когда типов больше одного; считаем по активным и сданным вместе.
      kindCounts: KINDS.map((k) => ({ ...k, count: sorted.filter((d) => d.kind === k.value).length })).filter((k) => k.count),
    };
  }, [deadlines]);
  // Выбранный тип пропал (удалили последний тест или он ушёл из Moodle) — фильтр сам возвращается на «Все» (проверка
  // 15 окт): ряд чипов при одном типе скрыт, и снять фильтр было бы нечем. Пока эффект не сбросил состояние, список уже
  // рисуется без фильтра; а состояние сбрасываем, чтобы тип, появившись снова, не отфильтровал список неожиданно.
  const kindOk = kind !== "all" && kindCounts.length > 1 && kindCounts.some((k) => k.value === kind);
  const kindOn: KindFilter = kindOk ? kind : "all";
  useEffect(() => { if (kind !== "all" && !kindOk) setKind("all"); }, [kind, kindOk]);

  const groups = useMemo(() => {
    const byKind = (d: Deadline) => kindOn === "all" || d.kind === kindOn;
    const open = openAll.filter(byKind), done = doneAll.filter(byKind);
    // «Сданные» — отдельная вкладка, последние сданные сверху.
    if (mode === "done") return done.length ? [{ key: "done", title: "Сдано", items: [...done].reverse() }] : [];
    // «Активные» — по срокам; раскладываем за один проход (dueDayKey — по разу на дедлайн).
    const ws = weekStart(today);
    const endThisWeek = addDays(ws, 6), endNextWeek = addDays(ws, 13);
    const overdue: Deadline[] = [], week: Deadline[] = [], next: Deadline[] = [], later: Deadline[] = [];
    for (const d of open) {
      const day = dueDayKey(d.due);
      (effectiveDue(d.due) <= now ? overdue : day <= endThisWeek ? week : day <= endNextWeek ? next : later).push(d);
    }
    return [
      { key: "overdue", title: "Просрочено", items: overdue },
      { key: "week", title: "Эта неделя", items: week },
      { key: "next", title: "Следующая неделя", items: next },
      { key: "later", title: "Позже", items: later },
    ].filter((g) => g.items.length);
  }, [openAll, doneAll, kindOn, mode, now, today]);

  return (
    <div className="flex flex-col gap-3">
      <m.header className="flex items-start justify-between gap-3 px-1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        {/* «Добавить» — здесь, вместо плавающего «+» (18 окт 2026): на его месте теперь сова Дуся. */}
        <div className="min-w-0">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Дедлайны</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">
          {openAll.length ? `${openAll.length} ${plural(openAll.length, "активный", "активных", "активных")} · ${doneAll.length} сдано`
            : pending ? "Загружаю из Moodle…" : failed ? "Дедлайны не загрузились" : "Все сроки закрыты"}
        </p>
        </div>
        <button onClick={() => push({ name: "deadline-form" })} className="mt-1 flex min-h-10 shrink-0 items-center gap-1 rounded-full bg-accent/15 px-3.5 text-s font-bold text-accent">
          <Plus size={16} strokeWidth={2.5} />Добавить
        </button>
      </m.header>

      <Segmented<Mode> id="deadlines" value={mode} options={MODES} onChange={setMode} />

      {kindCounts.length > 1 && (
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4" role="tablist" aria-label="Тип работы">
          {[{ value: "all" as const, plural: "Все", Icon: null, count: deadlines.length }, ...kindCounts].map((k) => {
            const active = kindOn === k.value;
            return (
              <button
                key={k.value}
                role="tab"
                aria-selected={active}
                onClick={() => { haptic.select(); setKind(k.value); }}
                className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-s font-bold transition-colors duration-200 ${
                  active ? "bg-accent text-on-accent" : "glass text-hint"}`}
              >
                {k.Icon && <k.Icon size={14} strokeWidth={2.5} />}
                {k.plural}
                <span className={active ? "text-on-accent/70" : "text-hint/60"}>{k.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Первая загрузка из Moodle идёт — скелетон, не удалась — причина и «Повторить» (проверка 15 окт). */}
      {status === "loading" || pending ? (
        <div className="flex flex-col gap-2.5"><Skeleton className="h-40 rounded-[22px]" /><Skeleton className="h-56 rounded-[22px]" /><Skeleton className="h-32 rounded-[22px]" /></div>
      ) : failed ? (
        <MoodleFailed index={0} />
      ) : groups.length === 0 ? (
        <Tile index={0} className="min-h-0">
          <EmptyState icon={Flag} title={mode === "active" ? "Активных дедлайнов нет" : "Сданных пока нет"}
            text={kindOn !== "all" ? "В этом типе пока пусто. Выберите «Все» или добавьте срок." : mode === "active" ? "Всё сдано. Новые сроки появятся здесь." : "Сданные и оценённые работы будут собираться здесь."}
            action="Добавить дедлайн" onAction={() => push({ name: "deadline-form" })} />
        </Tile>
      ) : (
        <div className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {groups.map((g, i) => {
              const limited = g.key === "later" && g.items.length > LATER_LIMIT;
              const items = limited && !laterOpen ? g.items.slice(0, LATER_LIMIT) : g.items;
              return (
              <Tile key={g.key} index={i} enter="fade" className="min-h-0 px-0 py-1">
                <TileLabel className="flex items-baseline gap-2 px-4 pt-2 pb-1">
                  {g.title}<span className="text-hint/70">{g.items.length}</span>
                </TileLabel>
                <AnimatePresence initial={false}>
                  {items.map((d, j) => (
                    <m.div key={d.id} initial={j < LATER_LIMIT || g.key !== "later" ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring(420, 34)} className="overflow-hidden border-t border-separator first:border-t-0">
                      <div className="px-4">
                        <DeadlineRow deadline={d} subject={subjectOf(subjects, d.subjectId)} now={now} onOpen={() => push({ name: "deadline", id: d.id })} />
                      </div>
                    </m.div>
                  ))}
                </AnimatePresence>
                {limited && (
                  <button onClick={() => { haptic.select(); setLaterOpen((v) => !v); }} aria-expanded={laterOpen}
                    className="flex min-h-11 w-full items-center justify-center gap-1.5 border-t border-separator text-s font-bold text-accent">
                    {laterOpen ? "Свернуть" : `Показать все · ещё ${g.items.length - LATER_LIMIT}`}
                    <ChevronDown size={16} strokeWidth={2.5} className={`transition-transform duration-200 ${laterOpen ? "rotate-180" : ""}`} />
                  </button>
                )}
              </Tile>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
