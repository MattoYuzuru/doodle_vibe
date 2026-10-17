import { Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../store/auth";
import { api } from "../store/api";
import { useSchedule } from "../store/schedule";
import { haptic } from "../telegram/webapp";
import { fieldClass } from "../screens/TaskForm";
import { Tile, TileLabel } from "./Tile";

/**
 * Выбор группы для расписания. Обычно группа определяется автоматически по курсам Moodle; сюда попадаем,
 * если кандидатов несколько или автоопределение не сработало. Список групп — с «Дневача».
 */
export function GroupPicker() {
  const { profile, setGroup } = useAuth();
  const [candidates, setCandidates] = useState<string[]>(profile?.groupCandidates ?? []);
  const [all, setAll] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Автоопределение: сервер смотрит группы пользователя в курсах Moodle и сопоставляет с «Дневачом».
    api<{ group: string | null; candidates: string[] }>("api/group").then((r) => {
      if (r.group) { void useAuth.getState().load(); void useSchedule.getState().load(true); }
      setCandidates(r.candidates ?? []);
    }).catch(() => {});
    api<string[]>("api/groups").then(setAll).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toUpperCase().replace(/Ё/g, "Е");
    if (!s) return [];
    return all.filter((g) => g.toUpperCase().replace(/Ё/g, "Е").includes(s)).slice(0, 12);
  }, [q, all]);

  const choose = async (g: string) => {
    haptic.select(); setBusy(true);
    try { await setGroup(g); await useSchedule.getState().load(true); } finally { setBusy(false); }
  };

  return (
    <Tile index={0} className="!min-h-0">
      <TileLabel className="flex items-center gap-1.5"><Users size={13} strokeWidth={2.5} />Группа для расписания</TileLabel>
      {candidates.length > 1 && (
        <>
          <p className="mt-2 text-s text-hint">По курсам Moodle подходят несколько групп. Выберите свою:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {candidates.map((g) => (
              <button key={g} onClick={() => choose(g)} disabled={busy} className="glass min-h-10 rounded-full px-3.5 text-s font-bold text-accent disabled:opacity-50">{g}</button>
            ))}
          </div>
        </>
      )}
      {candidates.length <= 1 && <p className="mt-2 text-s text-hint">Не удалось определить группу по курсам Moodle. Найдите её в списке:</p>}
      <label className="mt-3 flex min-h-11 items-center gap-2 rounded-2xl bg-raised px-3 text-hint">
        <Search size={16} strokeWidth={2.25} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Например, БИСТ-24" className={`${fieldClass} !min-h-0 !bg-transparent !px-0 !py-2 !rounded-none !shadow-none`} />
      </label>
      {filtered.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {filtered.map((g) => (
            <button key={g} onClick={() => choose(g)} disabled={busy} className="glass min-h-10 rounded-full px-3.5 text-s font-bold disabled:opacity-50">{g}</button>
          ))}
        </div>
      )}
    </Tile>
  );
}
