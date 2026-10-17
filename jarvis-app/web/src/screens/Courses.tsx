import { BookOpen, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { formatDue } from "../lib/dates";
import { api } from "../store/api";
import { useAppStore } from "../store/useAppStore";
import { haptic } from "../telegram/webapp";

interface Course {
  id: number; name: string; fullname: string; auto: boolean; reason: string; override: boolean | null; active: boolean; hidden: boolean; lastaccess: number | null;
  /** Курс прошлого семестра с новой работой: сам не включается, ждёт ответа пользователя. */
  pending?: boolean; pendingWork?: { title: string; due: number; section: string | null } | null;
}

/**
 * Курсы Moodle: какие считать актуальными. Автоматика — по семестру в названии и датам; переключатель — ручной выбор,
 * «сбросить» возвращает автоматику. Влияет на дедлайны, преподавателей и уведомления.
 */
export function CoursesScreen() {
  const pop = useNav((s) => s.pop);
  const [data, setData] = useState<{ semester: string; courses: Course[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<{ semester: string; courses: Course[] }>("api/courses").then(setData).catch((e) => setErr((e as Error).message)); }, []);

  const set = async (c: Course, active: boolean | null) => {
    setBusy(c.id); haptic.select();
    try {
      setData(await api<{ semester: string; courses: Course[] }>("api/courses", { id: c.id, active }));
      toast(active === null ? "Снова автоматически" : active ? `Курс включён: ${c.name}` : `Курс скрыт: ${c.name}`);
      void useAppStore.getState().syncMoodle(true); // дедлайны и предметы пересчитать под новый список
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(null); }
  };

  if (err) return <EmptyState icon={BookOpen} title="Курсы не загрузились" text={err} action="Назад" onAction={pop} />;
  const pending = data?.courses.filter((c) => c.pending) ?? [];
  const active = data?.courses.filter((c) => c.active && !c.pending) ?? [], rest = data?.courses.filter((c) => !c.active && !c.pending) ?? [];

  const row = (c: Course, i: number) => (
    <Tile key={c.id} index={i} className="!min-h-0 py-3" enter="fade">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-m font-semibold leading-[20px]">{c.name}</p>
          {/* «Сбросить» — вне обрезаемого текста (проверка 15 окт): на 360–390 px строка обрезалась многоточием вместе с кнопкой,
              и вернуть автоматический выбор было нечем. Сокращается причина, кнопка видна всегда; -my-2 py-2 — палец
              попадает легче, а высота строки та же. */}
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-s text-hint">
            <span className="min-w-0 truncate">{c.reason}{c.override !== null ? " · выбрано вручную" : " · автоматически"}</span>
            {c.override !== null && <button onClick={() => set(c, null)} disabled={busy === c.id} className="-my-2 inline-flex shrink-0 items-center gap-1 py-2 font-bold text-accent disabled:opacity-50"><RotateCcw size={12} strokeWidth={2.5} />сбросить</button>}
          </p>
        </div>
        <button onClick={() => set(c, !c.active)} disabled={busy === c.id} role="switch" aria-checked={c.active} aria-label={c.name}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${c.active ? "bg-accent" : "bg-raised"}`}>
          <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition-[left] ${c.active ? "left-7" : "left-1"}`} />
        </button>
      </div>
    </Tile>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Курсы</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">{data ? `Сейчас ${data.semester} · актуальных ${active.length} из ${data.courses.length}` : "Загружаю…"}</p>
      </div>
      {/* Курс прошлого семестра, в котором появилась новая работа: не включаем сами (это может быть раздел «Должникам»), а спрашиваем. */}
      {pending.length > 0 && <p className="px-1 pt-1 text-[12px] font-bold uppercase tracking-[0.06em] text-yellow">Уточните · {pending.length}</p>}
      {pending.map((c, i) => (
        <Tile key={c.id} index={i} className="!min-h-0 py-3" enter="fade">
          <p className="text-m font-semibold leading-[20px]">{c.name} <span className="font-medium text-hint">· {c.reason}</span></p>
          <p className="mt-1 text-s leading-[18px] text-hint">
            Появилась работа «{c.pendingWork?.title}»{c.pendingWork?.section ? `, раздел «${c.pendingWork.section}»` : ""}{c.pendingWork ? `, ${formatDue(c.pendingWork.due)}` : ""}.
            Курс не из текущего семестра, поэтому в дедлайны он не добавлен. Это ваш курс сейчас?
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => set(c, true)} disabled={busy === c.id} className="min-h-11 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-50">Да, показывать</button>
            <button onClick={() => set(c, false)} disabled={busy === c.id} className="glass min-h-11 rounded-2xl text-m font-bold text-hint disabled:opacity-50">Нет, не мой</button>
          </div>
        </Tile>
      ))}
      {active.map((c, i) => row(c, pending.length + i))}
      {rest.length > 0 && <p className="px-1 pt-2 text-[12px] font-bold uppercase tracking-[0.06em] text-hint">Неактуальные · {rest.length}</p>}
      {rest.map((c, i) => row(c, pending.length + active.length + i))}
      <p className="px-2 text-s text-hint">Актуальность определяется по семестру в названии курса и датам в Moodle; если что-то не так — переключите вручную.</p>
    </div>
  );
}
