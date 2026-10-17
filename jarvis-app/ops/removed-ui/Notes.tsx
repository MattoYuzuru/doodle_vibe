import { motion } from "framer-motion";
import { PenLine, Pin, Search, X } from "lucide-react";
import { useState } from "react";
import { Tile } from "../components/Tile";
import { EmptyState, Skeleton } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { addDays, dayKey, mskParts, todayKey } from "../lib/dates";
import { useAppStore } from "../store/useAppStore";

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «Сегодня, 14:05» / «Вчера, 9:30» / «25 сен» */
export function formatUpdated(ms: number) {
  const key = dayKey(ms), today = todayKey(), p = mskParts(ms);
  const time = `${p.hh}:${String(p.mm).padStart(2, "0")}`;
  if (key === today) return `Сегодня, ${time}`;
  if (key === addDays(today, -1)) return `Вчера, ${time}`;
  return `${p.d} ${MONTHS_SHORT[p.m - 1]}`;
}

/** Заметки: поиск, сетка в две колонки, закреплённые сверху. */
export function NotesScreen() {
  const { status, notes } = useAppStore();
  const push = useNav((s) => s.push);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = [...notes]
    .filter((n) => !query || `${n.title}\n${n.body}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);

  return (
    <div className="flex flex-col gap-3">
      <motion.header className="px-1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Заметки</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">{notes.length ? `${notes.length} · ${notes.filter((n) => n.pinned).length} закреплено` : "Пока пусто"}</p>
      </motion.header>

      <label className="glass flex min-h-11 items-center gap-2 rounded-full px-4 text-hint">
        <Search size={18} strokeWidth={2.25} className="shrink-0" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по заметкам" className="min-w-0 flex-1 bg-transparent py-2 text-m text-text outline-none placeholder:text-hint" />
        {q && <button onClick={() => setQ("")} aria-label="Очистить" className="-mr-2 grid size-9 place-items-center"><X size={16} /></button>}
      </label>

      {status === "loading" ? (
        <div className="grid grid-cols-2 gap-2.5"><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-36 rounded-[22px]" /></div>
      ) : list.length === 0 ? (
        <Tile index={0} className="min-h-0">
          <EmptyState icon={query ? Search : PenLine} title={query ? "Ничего не найдено" : "Заметок нет"}
            text={query ? "Попробуйте другое слово." : "Конспект к защите, идеи, список покупок — всё сюда."}
            action={query ? undefined : "Создать заметку"} onAction={() => push({ name: "note" })} />
        </Tile>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {list.map((n, i) => (
            <Tile key={n.id} index={i} onClick={() => push({ name: "note", id: n.id })} className="flex min-h-[136px] flex-col gap-1.5">
              <span className="flex items-start gap-1.5">
                {n.pinned && <Pin size={14} strokeWidth={2.5} className="mt-[3px] shrink-0 text-accent" />}
                <span className="line-clamp-2 text-m font-bold leading-[20px]">{n.title || "Без названия"}</span>
              </span>
              <span className="line-clamp-4 whitespace-pre-line text-s leading-[17px] text-hint">{n.body}</span>
              <span className="mt-auto pt-1 text-[11px] font-semibold text-hint/80">{formatUpdated(n.updatedAt)}</span>
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}
