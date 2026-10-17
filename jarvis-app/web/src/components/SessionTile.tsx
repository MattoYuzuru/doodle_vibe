import { CalendarClock, ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useNav } from "../hooks/useNav";
import { plural } from "../lib/journal";
import { rangeText, whenText } from "../lib/session";
import { useSession } from "../store/session";
import { haptic } from "../telegram/webapp";
import { Tile, TileTitle } from "./Tile";

/** Сколько живёт копия на телефоне, прежде чем Главная попросит свежую. */
const STALE_MS = 30 * 60e3;

/**
 * Плитка «Сессия» на Главной: через сколько дней сессия и её даты, сколько экзаменов и зачётов, долги; нажатие —
 * вкладка «Журнал» в виде «Сессия». Группа не выбрана или плана нет — плитки нет (о группе просит расписание).
 */
export function SessionTile({ index }: { index: number }) {
  // Подписки по полям (проверка 15 окт): весь useNav перерисовывал плитку на каждый push/pop и смену вкладки, а весь
  // useSession — на каждую смену status.
  const data = useSession((s) => s.data);
  const load = useSession((s) => s.load);
  const setTab = useNav((s) => s.setTab);
  const setJournalView = useNav((s) => s.setJournalView);
  useEffect(() => {
    const s = useSession.getState();
    if (s.status === "idle" && (!s.data || Date.now() - s.data.at > STALE_MS)) void load();
  }, [load]);
  if (!data || data.needGroup) return null;
  const up = data.upcoming;
  if (!up || up.state === "past") return null;
  const c = data.counts;
  const z = (c?.graded ?? 0) + (c?.pass ?? 0);
  const parts = [c?.exam ? `${c.exam} ${plural(c.exam, "экзамен", "экзамена", "экзаменов")}` : "", z ? `${z} ${plural(z, "зачёт", "зачёта", "зачётов")}` : "", c?.coursework ? `${c.coursework} ${plural(c.coursework, "курсовая", "курсовые", "курсовых")}` : ""].filter(Boolean);
  return (
    <Tile span={2} index={index} onClick={() => { haptic.tap(); setJournalView("session"); setTab("journal"); }} className="!min-h-0 py-3">
      <div className="flex items-center justify-between gap-2">
        <TileTitle className="min-w-0 truncate">Сессия · {whenText(up)}</TileTitle>
        <ChevronRight size={16} className="shrink-0 text-hint" />
      </div>
      <p className="mt-1.5 text-m font-bold">{up.label[0].toUpperCase()}{up.label.slice(1)}: {rangeText(up.from, up.to)}</p>
      {parts.length > 0 && <p className="mt-0.5 text-s font-semibold text-hint">{parts.join(", ")}</p>}
      {data.exams?.published && (
        <p className="mt-1.5 flex items-center gap-1.5 text-s font-semibold text-green"><CalendarClock size={14} strokeWidth={2.25} />Расписание экзаменов опубликовано</p>
      )}
      {(data.risks ?? 0) > 0 && (
        <p className="mt-1.5 flex items-center gap-1.5 text-s font-semibold text-red"><TriangleAlert size={14} strokeWidth={2.25} />Порог не набрать: {data.risks} {plural(data.risks ?? 0, "дисциплина", "дисциплины", "дисциплин")}</p>
      )}
    </Tile>
  );
}
