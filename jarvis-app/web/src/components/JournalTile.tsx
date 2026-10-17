import { ChevronRight, GraduationCap, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useNav } from "../hooks/useNav";
import { pct, plural, tone, withSheets } from "../lib/journal";
import { useJournal } from "../store/journal";
import { haptic } from "../telegram/webapp";
import { DAY, keyToUtc, todayKey } from "../lib/dates";
import { Tile, TileTitle } from "./Tile";

/** Сколько живёт копия журнала на телефоне, прежде чем Главная попросит свежую (сервер сам держит ответ 10 минут). */
const STALE_MS = 30 * 60e3;

/**
 * Плитка «Журнал» на Главной: средние посещаемость и рейтинг за семестр и пропуски; нажатие — вкладка «Журнал».
 * Журнал не подключён — короткое приглашение подключить (пароль вводится во вкладке один раз).
 */
export function JournalTile({ index }: { index: number }) {
  // Подписки по полям (проверка 15 окт): весь useNav перерисовывал плитку (и Главную) на каждый push/pop и смену вкладки.
  const st = useJournal((s) => s.st);
  const load = useJournal((s) => s.load);
  const setTab = useNav((s) => s.setTab);
  const setJournalView = useNav((s) => s.setJournalView);
  useEffect(() => {
    const s = useJournal.getState();
    const at = s.st?.data?.at ? Date.parse(s.st.data.at) : 0;
    if (s.status === "idle" && (!s.st || (s.st.connected && Date.now() - at > STALE_MS))) void load();
  }, [load]);
  // Во вкладке «Журнал» два вида (журнал и сессия): с этой плитки — именно журнал, даже если там остался вид «Сессия».
  const open = () => { haptic.tap(); setJournalView("journal"); setTab("journal"); };

  // Без оглядки на загрузку (проверка 15 окт): вкладка «Журнал» на старте всегда зовёт load(), и плитка исчезала на
  // время запроса и въезжала снова — всё ниже прыгало при каждом запуске. Пока нет ответа, остаётся прошлое состояние.
  if (st && !st.connected) {
    return (
      <Tile span={2} index={index} onClick={open} className="!min-h-0 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><GraduationCap size={18} strokeWidth={2.5} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-m font-bold">Посещаемость и оценки</span>
            <span className="block text-s text-hint">{st.rejected ? "Сохранённый пароль не подошёл — введите текущий" : st.needPassword ? "Журналу нужен пароль — введите его ещё раз" : "Подключите электронный журнал — пароль от Moodle один раз"}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-hint" />
        </div>
      </Tile>
    );
  }
  const d = st?.connected ? st.data : null;
  if (!d) return null;
  const { attendance } = d.summary;
  // Риск по посещаемости: предметы в жёлтой (ниже 75 %) и красной (ниже 50 %) зоне журнала, худший первым. О переходе
  // в эти зоны бот пишет сам (attendance.mjs на сервере); здесь — чтобы было видно, не открывая вкладку.
  // С 15 окт 2026 — и по таблицам преподавателей: у дисциплины журнала без отметок — посещаемость из таблицы её курса,
  // дисциплины, которых в журнале нет, — тоже (lib/journal withSheets).
  const ws = withSheets(d.subjects, st?.sheets ?? [], d.notMine ?? []);
  // Пропуски — и из таблиц преподавателей, где посещения взяты из них (иначе «Пропусков нет» рядом с «Мало посещений»).
  const absences = d.summary.absences + ws.absences, missedHours = d.summary.missedHours + ws.missedHours;
  const risky = [...d.subjects.map((s) => ({ name: s.name, attendance: ws.attendanceOf(s) })), ...ws.loose.map((x) => ({ name: x.name, attendance: x.attendance }))]
    .filter((s) => s.attendance != null && s.attendance < 75).sort((a, b) => (a.attendance ?? 0) - (b.attendance ?? 0));
  const short = (n: string) => (n.length > 34 ? `${n.slice(0, 33).trimEnd()}…` : n);
  // Дни без пропусков — с даты последнего пропуска в журнале и таблицах (18 окт 2026). Даты всех пар журнал не отдаёт,
  // поэтому серию считаем в днях, а не в парах. Пропусков нет совсем — null («весь семестр»).
  const dates = [...d.subjects.flatMap((s) => s.absences.map((x) => x.date)), ...(st?.sheets ?? []).flatMap((x) => (x.absences ?? []).map((a) => a.date))]
    .map(parseDay).filter((v) => Number.isFinite(v));
  const streak = dates.length ? Math.max(0, Math.floor((keyToUtc(todayKey()) - Math.max(...dates)) / DAY)) : null;
  const red = (risky[0]?.attendance ?? 100) < 50;
  return (
    <Tile span={2} index={index} onClick={open} className="!min-h-0 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <TileTitle className="min-w-0 truncate">Журнал{d.semester ? ` · ${d.semester.replace(/ \d.*$/, "").toLowerCase()}` : ""}</TileTitle>
        <ChevronRight size={16} className="shrink-0 text-hint" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-s text-hint">Посещаемость</p>
          <p className="font-display mt-1 text-l font-extrabold tracking-[-0.03em] tabular" style={{ color: tone(attendance, "var(--c-yellow)") }}>{pct(attendance)}</p>
          <div className="mt-2 h-1.5 rounded-full bg-raised"><div className="h-1.5 rounded-full" style={{ width: `${Math.min(attendance ?? 0, 100)}%`, background: tone(attendance, "var(--c-yellow)") }} /></div>
          <p className="mt-1.5 text-s text-hint">{attendance != null && attendance < 75 ? "ниже 75% — стоит подтянуть" : "за семестр"}</p>
        </div>
        <div className="min-w-0">
          <p className="text-s text-hint">Без пропусков</p>
          <p className="font-display mt-1 text-l font-extrabold tracking-[-0.03em] tabular">
            {streak ?? "весь"}<span className="ml-1.5 text-m font-semibold tracking-normal text-hint">{streak == null ? "семестр" : plural(streak, "день", "дня", "дней")}</span>
          </p>
          <div className="mt-2 flex h-1.5 gap-[3px]">
            {Array.from({ length: 7 }, (_, i) => <span key={i} className={`flex-1 rounded-[2px] ${i < Math.min(streak ?? 7, 7) ? "bg-accent" : "bg-raised"}`} />)}
          </div>
          <p className="mt-1.5 text-s text-hint">{streak == null ? "пропусков нет" : streak === 0 ? "пропуск сегодня — начнём заново" : "с последнего пропуска"}</p>
        </div>
      </div>
      {/* Предупреждение — жёлтое (красное только в красной зоне журнала, ниже 50%): постоянный красный быстро перестают замечать. */}
      {(absences > 0 || risky.length > 0) && (
        <p className={`mt-3 flex items-start gap-2 rounded-2xl px-3 py-2.5 text-s font-semibold ${red ? "bg-red/12 text-red" : "bg-yellow/12 text-yellow"}`}>
          <TriangleAlert size={15} strokeWidth={2.25} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            {absences > 0 && `${absences} ${plural(absences, "пропуск", "пропуска", "пропусков")}${missedHours ? `, это ${missedHours} ак. ч.` : ""}. `}
            {risky.length > 0 && `Хуже всего: ${short(risky[0].name)} — ${pct(risky[0].attendance)}${risky.length > 1 ? `, и ещё ${risky.length - 1}` : ""}`}
          </span>
        </p>
      )}
    </Tile>
  );
}

/** Дата пропуска из журнала: «2026-10-14» или «14.10.2026» → мс UTC; не разобрали — NaN. */
function parseDay(s: string | null | undefined) {
  if (!s) return NaN;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const ru = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return ru ? Date.UTC(+ru[3], +ru[2] - 1, +ru[1]) : NaN;
}
