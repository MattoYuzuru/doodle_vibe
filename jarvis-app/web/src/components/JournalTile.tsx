import { CalendarX2, ChevronRight, GraduationCap, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useNav } from "../hooks/useNav";
import { pct, plural, tone } from "../lib/journal";
import { useJournal } from "../store/journal";
import { haptic } from "../telegram/webapp";
import { Ring } from "./Ring";
import { Tile, TileLabel } from "./Tile";

/** Сколько живёт копия журнала на телефоне, прежде чем Главная попросит свежую (сервер сам держит ответ 10 минут). */
const STALE_MS = 30 * 60e3;

/**
 * Плитка «Журнал» на Главной: средние посещаемость и рейтинг за семестр и пропуски; нажатие — вкладка «Журнал».
 * Журнал не подключён — короткое приглашение подключить (пароль вводится во вкладке один раз).
 */
export function JournalTile({ index }: { index: number }) {
  const { st, status, load } = useJournal();
  const setTab = useNav((s) => s.setTab);
  useEffect(() => {
    const s = useJournal.getState();
    const at = s.st?.data?.at ? Date.parse(s.st.data.at) : 0;
    if (s.status === "idle" && (!s.st || (s.st.connected && Date.now() - at > STALE_MS))) void load();
  }, [load]);
  const open = () => { haptic.tap(); setTab("journal"); };

  if (st && !st.connected && status !== "loading") {
    return (
      <Tile span={2} index={index} onClick={open} className="!min-h-0 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><GraduationCap size={18} strokeWidth={2.5} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-m font-bold">Посещаемость и оценки</span>
            <span className="block text-s text-hint">{st.needPassword ? "Вход в журнал истёк — введите пароль ещё раз" : "Подключите электронный журнал — пароль от Moodle один раз"}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-hint" />
        </div>
      </Tile>
    );
  }
  const d = st?.connected ? st.data : null;
  if (!d) return null;
  const { attendance, rating, absences, missedHours } = d.summary;
  // Риск по посещаемости: предметы в жёлтой (ниже 75 %) и красной (ниже 50 %) зоне журнала, худший первым. О переходе
  // в эти зоны бот пишет сам (attendance.mjs на сервере); здесь — чтобы было видно, не открывая вкладку.
  const risky = d.subjects.filter((s) => s.attendance != null && s.attendance < 75).sort((a, b) => (a.attendance ?? 0) - (b.attendance ?? 0));
  const short = (n: string) => (n.length > 26 ? `${n.slice(0, 25).trimEnd()}…` : n);
  return (
    <Tile span={2} index={index} onClick={open} className="!min-h-0 py-3">
      <div className="flex items-center justify-between gap-2">
        <TileLabel className="flex min-w-0 items-center gap-1.5">
          <GraduationCap size={13} strokeWidth={2.5} /><span className="truncate">Журнал{d.semester ? ` · ${d.semester.replace(/ \d.*$/, "").toLowerCase()}` : ""}</span>
        </TileLabel>
        <ChevronRight size={16} className="shrink-0 text-hint" />
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-3">
        <Mini label="посещаемость" value={attendance} color={tone(attendance, "var(--c-yellow)")} delay={0.15} />
        <Mini label="рейтинг" value={rating} color="var(--c-accent)" delay={0.23} />
      </div>
      <p className={`mt-2.5 flex items-center gap-1.5 text-s font-semibold ${absences ? "text-red" : "text-hint"}`}>
        <CalendarX2 size={14} strokeWidth={2.25} />
        {absences ? `${absences} ${plural(absences, "пропуск", "пропуска", "пропусков")}${missedHours ? ` · ${missedHours} ак. ч.` : ""}` : "Пропусков нет"}
      </p>
      {risky.length > 0 && (
        <p className={`mt-1.5 flex items-start gap-1.5 text-s font-semibold ${(risky[0].attendance ?? 0) < 50 ? "text-red" : "text-yellow"}`}>
          <TriangleAlert size={14} strokeWidth={2.25} className="mt-0.5 shrink-0" />
          <span className="min-w-0">Мало посещений: {short(risky[0].name)} — {pct(risky[0].attendance)}{risky.length > 1 ? ` и ещё ${risky.length - 1}` : ""}</span>
        </p>
      )}
    </Tile>
  );
}

function Mini({ label, value, color, delay }: { label: string; value: number | null; color: string; delay: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Ring value={(value ?? 0) / 100} size={36} stroke={4} color={color} delay={delay} className="shrink-0" />
      <div className="min-w-0">
        <p className="font-display text-[20px] leading-none font-extrabold tracking-[-0.03em] tabular">{pct(value)}</p>
        <p className="mt-0.5 truncate text-[12px] font-semibold text-hint">{label}</p>
      </div>
    </div>
  );
}
