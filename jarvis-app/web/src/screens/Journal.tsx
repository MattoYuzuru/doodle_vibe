import { AnimatePresence, m } from "framer-motion";
import { CalendarX2, ChevronDown, EyeOff, KeyRound, RefreshCw, Undo2 } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { Ring } from "../components/Ring";
import { Segmented } from "../components/Segmented";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { Skeleton, fmtGrade } from "../components/ui";
import { useNav, type JournalView } from "../hooks/useNav";
import { pct, plural, sameSource, sheetCaveat, sheetSourceText, tone, withSheets } from "../lib/journal";
import { sessionSubtitle } from "../lib/session";
import type { EjData, EjState, EjSubject, SheetSubject } from "../store/api";
import { useJournal } from "../store/journal";
import { useSession } from "../store/session";
import { haptic } from "../telegram/webapp";
import { fieldClass } from "./TaskForm";

// «Сессия» грузится отдельной частью сборки, только когда её выбрали: вкладка «Журнал» всегда смонтирована.
const SessionPanel = lazy(() => import("./Session").then((mod) => ({ default: mod.SessionPanel })));
const VIEWS: { value: JournalView; label: string }[] = [{ value: "journal", label: "Журнал" }, { value: "session", label: "Сессия" }];

const day = (d: string | null) => {
  const t = d ? new Date(d) : null;
  return !t || Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
};
const num = (v: number) => String(Math.round(v * 100) / 100).replace(".", ",");
const chip = "rounded-full bg-raised px-2 py-0.5 text-[12px] font-semibold text-hint";
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const stamp = (at: string) => new Date(at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Вкладка «Журнал» с переключателем «Журнал | Сессия» (просьба владельца, 15 окт 2026: не плодить вкладки).
 * Журнал: посещаемость и успеваемость из электронного журнала МИСИС (ej.misis.ru) за текущий семестр. Вход — тем же
 * логином и паролем, что в Moodle: при входе в бот журнал подключается сам; кто вошёл раньше, вводит пароль здесь один
 * раз. С 16 окт 2026 сервер хранит пароль зашифрованно и, когда вход MISIS ID истекает (48 ч), входит им сам; форма
 * появляется снова, только если MISIS ID пароль не принял (например, его сменили).
 * Сессия: даты сессии и формы контроля из учебного плана, расписание экзаменов, долги (screens/Session.tsx).
 */
export function JournalScreen() {
  const { st, status, error, load } = useJournal();
  const session = useSession();
  const view = useNav((s) => s.journalView), setView = useNav((s) => s.setJournalView);
  useEffect(() => { void load(); }, [load]);
  const data = st?.connected ? st.data : null;
  const busy = view === "journal" ? status === "loading" : session.status === "loading";
  const subtitle = view === "journal"
    ? (data ? [data.semester, data.group].filter(Boolean).join(" · ") : "") || "Посещаемость и успеваемость"
    : sessionSubtitle(session.data);
  // При ошибке «Обновить» есть и без подключения (проверка 15 окт): первая загрузка, сорвавшаяся по сети, иначе
  // оставалась тупиком до перезапуска.
  const canRefresh = view === "journal" ? !!st?.connected || status === "error" || !!st?.sheets?.length : true;
  const refresh = () => { haptic.select(); if (view === "journal") void load(true); else void session.load(); };

  return (
    <div className="flex flex-col gap-3">
      <m.header className="flex items-start justify-between gap-3 px-1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <div className="min-w-0">
          <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">{view === "journal" ? "Журнал" : "Сессия"}</h1>
          <p className="mt-0.5 truncate text-s font-semibold text-hint">{subtitle}</p>
        </div>
        {canRefresh && (
          <button onClick={refresh} disabled={busy} aria-label="Обновить" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent disabled:opacity-40">
            <RefreshCw size={18} strokeWidth={2.25} className={busy ? "animate-spin" : ""} />
          </button>
        )}
      </m.header>
      <Segmented<JournalView> id="journal-view" value={view} options={VIEWS} onChange={setView} />
      {view === "journal"
        ? <JournalBody st={st} status={status} error={error} data={data} busy={busy} onRetry={refresh} />
        : <Suspense fallback={<><Skeleton className="h-40 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}><SessionPanel /></Suspense>}
    </div>
  );
}

function JournalBody({ st, status, error, data, busy, onRetry }: { st: EjState | null; status: string; error?: string; data: EjData | null; busy: boolean; onRetry(): void }) {
  // Таблицы преподавателей в курсах Moodle (сервер, admission.journalSheets): к дисциплине журнала — внутри её карточки,
  // дисциплины, которых в журнале нет, — отдельными карточками ниже (и без подключённого журнала).
  const sheets = st?.sheets ?? [];
  const notMine = data?.notMine ?? [];
  const { of, loose, absences: sheetAbsences, missedHours: sheetHours } = withSheets(data?.subjects ?? [], sheets, notMine);
  return (
    <>
      {!st && (busy || status === "idle") && <><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}
      {status === "error" && (
        <p className="px-1 text-s font-semibold text-red">{data ? `Не удалось обновить: ${error}. Показаны данные на ${stamp(data.at)}.` : error}</p>
      )}
      {/* Показать нечего — повтор прямо под ошибкой (проверка 15 окт). */}
      {status === "error" && !data && (!st || st.connected) && (
        <button onClick={onRetry} className="glass flex min-h-11 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
          <RefreshCw size={16} strokeWidth={2.5} />Повторить
        </button>
      )}
      {st && !st.connected && <ConnectCard st={st} />}
      {st?.connected && !data && busy && <><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}
      {data && (
        <>
          <Summary data={data} extra={{ absences: sheetAbsences, missedHours: sheetHours }} />
          {data.subjects.length === 0 && (
            <Tile index={1} span={2} className="!min-h-0 py-4"><p className="text-s text-hint">{notMine.length ? "Других дисциплин в журнале нет." : "В журнале пока нет дисциплин этого семестра."}</p></Tile>
          )}
          {data.subjects.map((s, i) => <SubjectCard key={s.id} s={s} sheet={of.get(s.id)} index={Math.min(i + 1, 6)} />)}
          {notMine.length > 0 && <NotMineTile list={notMine} index={Math.min(data.subjects.length + 1, 6)} />}
          <p className="px-1 pb-2 text-[12px] leading-[16px] text-hint">
            Электронный журнал МИСИС, данные на {stamp(data.at)}. Проценты — как их считает журнал; рейтинг копится до конца семестра.
          </p>
        </>
      )}
      {loose.length > 0 && <TileLabel className="px-1 pt-1">Из таблиц преподавателей</TileLabel>}
      {loose.map((x, i) => <SheetCard key={x.id} x={x} index={Math.min(i + 1, 6)} />)}
      {sheets.length > 0 && <SheetLinks list={sheets} />}
    </>
  );
}

/**
 * Дисциплины, которые студент назвал не своими (ответ боту «Нет, не моя» или «Не моё» в «Сессии», 16 окт 2026): не
 * прячутся молча — отдельной плиткой, без них средние и пропуски. «Вернуть» снимает обе отметки (и в боте, и в «Сессии»).
 */
function NotMineTile({ list, index }: { list: NonNullable<EjData["notMine"]>; index: number }) {
  const restore = useJournal((s) => s.restore);
  const [busy, setBusy] = useState<number | null>(null);
  const back = async (id: number) => {
    if (busy != null) return;
    haptic.tap();
    setBusy(id);
    try {
      await restore(id);
      toast("Возвращено — дисциплина снова считается");
      if (useSession.getState().data) void useSession.getState().load(); // в «Сессии» она тоже снова видна
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5">
      <TileLabel className="flex items-center gap-1.5"><EyeOff size={13} strokeWidth={2.5} />Не ваши · {list.length}</TileLabel>
      <p className="mt-1.5 text-[12px] leading-[16px] text-hint">В средних, пропусках, уведомлениях журнала и в «Сессии» не считаются. Ошиблись — верните.</p>
      <ul className="mt-1.5 flex flex-col">
        {list.map((s) => (
          <li key={s.id} className="flex min-h-11 items-center gap-2 border-t border-separator py-1.5 first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block text-s font-semibold text-hint wrap-break-word hyphens-auto">{s.name}</span>
              <span className="block text-[12px] text-hint">вы отметили: не ваша{s.from === "session" ? " (в «Сессии»)" : " (ответ боту)"}</span>
            </span>
            <button disabled={busy != null} onClick={() => void back(s.id)} className="flex shrink-0 items-center gap-1 rounded-full bg-raised px-2.5 py-1 text-[12px] font-bold text-text disabled:opacity-50">
              <Undo2 size={12} />{busy === s.id ? "Возвращаю…" : "Вернуть"}
            </button>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Ссылки на сами таблицы (в карточке-кнопке ссылку не поставить): дисциплина и откуда таблица. */
function SheetLinks({ list }: { list: SheetSubject[] }) {
  return (
    <p className="px-1 pb-2 text-[12px] leading-[16px] text-hint">
      Из таблиц преподавателей в курсах Moodle (своя строка — по ФИО и группе; расчёт ориентировочный, уточните у преподавателя):{" "}
      {list.map((x, i) => {
        const src = x.sheet ?? x.attendanceSheet, att = x.attendanceSheet && !sameSource(x.sheet, x.attendanceSheet) ? x.attendanceSheet : null;
        const link = (s: typeof src, text: string) => (s?.url ? <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold text-accent" onClick={() => haptic.tap()}>{text}</a> : <b>{text}</b>);
        return (
          <span key={x.id}>
            {i > 0 && "; "}
            {link(src, x.name)} — {sheetSourceText(src)}
            {att && <>; посещения — {link(att, "другая таблица")}: {sheetSourceText(att)}</>}
          </span>
        );
      })}.
    </p>
  );
}

/** Дисциплина только из таблицы преподавателя (в журнале её нет): посещаемость и баллы; нажатие — подробности. */
function SheetCard({ x, index }: { x: SheetSubject; index: number }) {
  const [open, setOpen] = useState(false);
  const n = x.absences.length;
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5" onClick={() => { haptic.select(); setOpen((o) => !o); }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-m font-bold leading-[20px] wrap-break-word hyphens-auto">{x.name}</p>
          <p className="mt-1"><span className={chip}>таблица преподавателя</span></p>
        </div>
        {n > 0 && <span className="shrink-0 rounded-full bg-red/15 px-2 py-0.5 text-[12px] font-bold text-red tabular">{n} {plural(n, "пропуск", "пропуска", "пропусков")}</span>}
        <m.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="mt-0.5 shrink-0 text-hint"><ChevronDown size={18} /></m.span>
      </div>
      <div className="mt-3 flex gap-3">
        <Bar label="Посещ." value={x.attendance} color={tone(x.attendance, "var(--c-yellow)")} />
        {x.rating == null && x.points ? (
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline justify-between gap-1 text-[12px] font-semibold text-hint"><span className="truncate">Баллы</span><span className="shrink-0 font-bold text-text tabular">{num(x.points.have)}{x.points.scale ? ` из ${num(x.points.scale)}` : ""}</span></p>
            <p className="mt-0.5 truncate text-[11px] text-hint">{x.points.confidence === "low" ? "разобрано неуверенно" : x.points.scale ? "часть дисциплины" : "максимум не указан"}</p>
          </div>
        ) : <Bar label="Баллы" value={x.rating} color="var(--c-accent)" />}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <m.div key="details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="mt-3 border-t border-separator pt-3 text-left"><SheetDetails x={x} /></div>
          </m.div>
        )}
      </AnimatePresence>
    </Tile>
  );
}

/** Что взято из таблицы преподавателя: баллы (по частям), посещения и пропуски, откуда таблица. */
function SheetDetails({ x, attendance = true }: { x: SheetSubject; attendance?: boolean }) {
  const p = x.points, l = attendance ? x.lessons : null;
  const lessonsText = (q: NonNullable<SheetSubject["lessons"]>) => !q.past ? "Занятий ещё не было"
    : `Прошло занятий: ${q.past} — был на ${q.present}, пропустил ${q.absent}${q.excused ? `, по уважительной ${q.excused}` : ""}${q.missedHours ? ` (${q.missedHours} ак. ч.)` : ""}${q.unmarked ? `, не отмечено ${q.unmarked}` : ""}`;
  return (
    <section className="flex flex-col gap-1">
      <TileLabel>Таблица преподавателя</TileLabel>
      {p && (
        <p className="text-s">
          Баллы: <b className="tabular">{num(p.have)}</b>{p.scale ? ` из ${num(p.scale)}` : ""}{p.left != null ? <span className="text-hint"> · можно ещё {num(p.left)}</span> : null}
          {!p.scale && p.label ? <span className="text-hint"> («{p.label}»)</span> : null}
        </p>
      )}
      {p && p.parts.length > 0 && (
        <p className="flex flex-wrap gap-1.5">
          {p.parts.map((q) => <span key={q.name} className="rounded-full bg-raised px-2 py-0.5 text-[12px] font-semibold text-text tabular">{q.name} · {num(q.have)} из {num(q.max)}</span>)}
        </p>
      )}
      {p && p.confidence === "low" && p.note && <p className="text-[12px] leading-[16px] text-yellow">{cap(p.note)} — сверьте с таблицей.</p>}
      {sheetCaveat(x.sheet) && <p className="text-[12px] leading-[16px] text-yellow">{sheetCaveat(x.sheet)}</p>}
      {l && x.points && x.attendanceSheet && !sameSource(x.sheet, x.attendanceSheet) && <p className="text-[12px] leading-[16px] text-hint">Посещения — {sheetSourceText(x.attendanceSheet)}:</p>}
      {l && x.attendanceSheet && !sameSource(x.sheet, x.attendanceSheet) && sheetCaveat(x.attendanceSheet) && <p className="text-[12px] leading-[16px] text-yellow">{sheetCaveat(x.attendanceSheet)}</p>}
      {l && <p className="text-s">{lessonsText(l)}</p>}
      {l && x.absences.length > 0 && (
        <ul className="flex flex-col gap-1">
          {x.absences.map((a, i) => (
            <li key={i} className="flex items-center gap-2 text-s">
              <span className={`size-1.5 shrink-0 rounded-full ${a.excused ? "bg-yellow" : "bg-red"}`} />
              <span className="w-16 shrink-0 font-semibold tabular">{day(a.date)}</span>
              <span className="min-w-0 flex-1 truncate text-hint">{a.kind}{a.n ? ` ${a.n}` : ""}{a.excused ? " · уважительная" : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] leading-[16px] text-hint">{cap(sheetSourceText(x.sheet ?? x.attendanceSheet))}. Ссылка — внизу вкладки.</p>
    </section>
  );
}

/** Сводка семестра: средние посещаемость и рейтинг по дисциплинам, всего пропусков. */
function Summary({ data, extra }: { data: EjData; extra: { absences: number; missedHours: number } }) {
  const { attendance, rating } = data.summary;
  // Пропуски — журнала и таблиц преподавателей (по дисциплинам, где посещения взяты из таблицы).
  const absences = data.summary.absences + extra.absences, missedHours = data.summary.missedHours + extra.missedHours;
  const n = data.subjects.length;
  return (
    <Tile span={2} index={0} className="!min-h-0 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Big label="посещаемость" value={attendance} color={tone(attendance, "var(--c-yellow)")} delay={0.1} />
        <Big label="рейтинг" value={rating} color="var(--c-accent)" delay={0.18} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-separator pt-3 text-s font-semibold">
        <span className={`flex items-center gap-1.5 ${absences ? "text-red" : "text-green"}`}>
          <CalendarX2 size={15} strokeWidth={2.25} />
          {absences ? `${absences} ${plural(absences, "пропуск", "пропуска", "пропусков")}${missedHours ? ` · ${missedHours} ак. ч.` : ""}` : "Пропусков нет"}
        </span>
        {n > 0 && <span className="ml-auto text-[12px] text-hint">среднее по {n} {plural(n, "дисциплине", "дисциплинам", "дисциплинам")}</span>}
      </div>
    </Tile>
  );
}

function Big({ label, value, color, delay }: { label: string; value: number | null; color: string; delay: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Ring value={(value ?? 0) / 100} size={46} stroke={5} color={color} delay={delay} className="shrink-0" />
      <div className="min-w-0">
        <p className="font-display text-[24px] leading-none font-extrabold tracking-[-0.03em] tabular">{pct(value)}</p>
        <p className="mt-1 truncate text-[12px] font-semibold text-hint">{label}</p>
      </div>
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex items-baseline justify-between gap-1 text-[12px] font-semibold text-hint">
        <span className="truncate">{label}</span><span className="shrink-0 font-bold text-text tabular">{pct(value)}</span>
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
        <m.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }}
          animate={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} transition={{ type: "spring", stiffness: 200, damping: 26 }} />
      </div>
    </div>
  );
}

/**
 * Дисциплина: три полоски (посещаемость, рейтинг, темп освоения); нажатие раскрывает пропуски и оценки. sheet — таблица
 * преподавателя в курсе этой дисциплины: когда в журнале нет отметок о посещении, посещаемость — из неё; нет оценок —
 * вместо рейтинга баллы из неё («Баллы»); подробности — ниже журнальных.
 */
function SubjectCard({ s, sheet, index }: { s: EjSubject; sheet?: SheetSubject; index: number }) {
  const [open, setOpen] = useState(false);
  const sub = [s.control, s.teachers.join(", ")].filter(Boolean).join(" · ");
  const ejAtt = !!s.lessons && s.lessons.present + s.lessons.absent > 0;
  const att = sheet && !ejAtt && sheet.attendance != null ? sheet.attendance : s.attendance;
  const useMarks = !!sheet && sheet.rating != null && !s.works.some((w) => w.mark != null);
  const absences = sheet && !ejAtt && sheet.lessons ? sheet.absences.length : s.absences.length;
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5" onClick={() => { haptic.select(); setOpen((o) => !o); }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Длинное слово («Электроснабжение») переносится в своей колонке, а не наезжает на бейдж пропусков (проверка 15 окт). */}
          <p className="text-m font-bold leading-[20px] wrap-break-word hyphens-auto">{s.name}</p>
          {sub && <p className="mt-0.5 truncate text-[12px] font-semibold text-hint">{sub}</p>}
          {sheet && <p className="mt-1"><span className={chip}>+ таблица преподавателя</span></p>}
        </div>
        {absences > 0 && (
          <span className="shrink-0 rounded-full bg-red/15 px-2 py-0.5 text-[12px] font-bold text-red tabular">
            {absences} {plural(absences, "пропуск", "пропуска", "пропусков")}
          </span>
        )}
        <m.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="mt-0.5 shrink-0 text-hint"><ChevronDown size={18} /></m.span>
      </div>
      <div className="mt-3 flex gap-3">
        <Bar label="Посещ." value={att} color={tone(att, "var(--c-yellow)")} />
        <Bar label={useMarks ? "Баллы" : "Рейтинг"} value={useMarks ? sheet!.rating : s.rating} color="var(--c-accent)" />
        <Bar label="Темп" value={s.track} color={tone(s.trackInDate)} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <m.div key="details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <Details s={s} sheet={sheet} />
            {sheet && <div className="mt-3 border-t border-separator pt-3 text-left"><SheetDetails x={sheet} attendance={!ejAtt} /></div>}
          </m.div>
        )}
      </AnimatePresence>
    </Tile>
  );
}

function Details({ s, sheet }: { s: EjSubject; sheet?: SheetSubject }) {
  const l = s.lessons;
  const now = Date.now();
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-separator pt-3 text-left">
      {s.error && <p className="text-s font-semibold text-yellow">Подробности не загрузились: {s.error}</p>}
      {l && (
        <section>
          <TileLabel>Посещаемость</TileLabel>
          <p className="mt-1 text-s">
            {l.past
              ? `Прошло занятий: ${l.past} — был на ${l.present}, пропустил ${l.absent}${l.missedHours ? ` (${l.missedHours} ак. ч.)` : ""}${l.unmarked ? `, не отмечено ${l.unmarked}` : ""}`
              : "Занятий ещё не было"}
          </p>
          {s.absences.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {s.absences.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-s">
                  <span className="size-1.5 shrink-0 rounded-full bg-red" />
                  <span className="w-16 shrink-0 font-semibold tabular">{day(a.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-hint">{a.kind}{a.n ? ` ${a.n}` : ""}</span>
                  {a.hours > 0 && <span className="shrink-0 text-[12px] font-semibold text-hint tabular">{a.hours} ак. ч.</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {s.works.length > 0 && (
        <section>
          <TileLabel>Оценки</TileLabel>
          <ul className="mt-1 flex flex-col">
            {s.works.map((w, i) => {
              const ahead = w.mark == null && !!w.date && Date.parse(w.date) > now;
              return (
                <li key={i} className={`flex min-h-10 items-center gap-2 border-t border-separator py-1 first:border-t-0 ${ahead ? "opacity-55" : ""}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-s font-semibold">{w.name}</span>
                    <span className="block text-[12px] text-hint">{[w.kind && `${w.kind}${w.n ? ` ${w.n}` : ""}`, day(w.date)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={`shrink-0 text-s font-bold tabular ${w.failed ? "text-red" : w.mark == null ? "text-hint" : ""}`}>
                    {w.mark == null ? "—" : fmtGrade(w.mark)}
                    {w.max != null && <span className="font-semibold text-hint"> / {fmtGrade(w.max)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {(s.grade != null || s.thresholds) && (
        <p className="text-s">
          {s.grade != null && <>Рекомендуемая оценка по рейтингу: <b className={s.grade <= 2 ? "text-red" : ""}>{s.grade}</b>. </>}
          {s.thresholds && (
            <span className={s.grade != null ? "text-hint" : ""}>
              Нужно рейтинга: на 3 — от {pct(s.thresholds[3])}, на 4 — от {pct(s.thresholds[4])}, на 5 — от {pct(s.thresholds[5])}.
            </span>
          )}
          <span className="block text-[12px] text-hint">Рейтинг копится за семестр: работы, которые ещё впереди, пока считаются нулём.</span>
        </p>
      )}
      {!s.error && !s.works.length && !(l && l.past) && <p className="text-s text-hint">{sheet ? "В электронном журнале пока нет отметок и оценок — ниже данные из таблицы преподавателя." : "По дисциплине пока нет отметок и оценок."}</p>}
    </div>
  );
}

/** Подключение журнала: пароль от Moodle (MISIS ID), почта — из входа в Moodle. */
function ConnectCard({ st }: { st: EjState }) {
  const connect = useJournal((s) => s.connect);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!password) return;
    setBusy(true); setErr("");
    try { await connect(password); haptic.success(); }
    catch (e) { setErr((e as Error).message); haptic.warning(); }
    finally { setBusy(false); setPassword(""); }
  };
  return (
    <Tile index={0} span={2} className="!min-h-0 py-4">
      <TileLabel className="flex items-center gap-1.5"><KeyRound size={13} strokeWidth={2.5} />Подключить электронный журнал</TileLabel>
      <p className="mt-2 text-s leading-[19px] text-hint">
        {st.rejected ? "Сохранённый пароль не подошёл — возможно, вы его сменили. Введите текущий пароль МИСИС: Doodle запомнит его и снова будет входить в журнал сам."
          : st.needPassword ? "Журналу нужен пароль. Введите его ещё раз — Doodle запомнит пароль и спросит снова, только если пароль сменится."
          : "Журнал МИСИС открывается тем же логином и паролем, что и Moodle. Введите пароль один раз — дальше посещаемость и оценки будут подгружаться сами."}
      </p>
      {st.email && <p className="mt-3 text-s"><span className="text-hint">Логин: </span><span className="font-semibold">{st.email}</span></p>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 flex flex-col gap-2">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль от Moodle" className={`${fieldClass} min-h-12`} />
        <button type="submit" disabled={busy || !password} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">{busy ? "Подключаю…" : "Подключить"}</button>
      </form>
      {(err || st.error) && <p className="mt-2 text-s font-semibold text-red">{err || `Прошлая попытка входа: ${st.error}`}</p>}
      <p className="mt-2 text-[12px] leading-[16px] text-hint">Пароль хранится на сервере Doodle в зашифрованном виде и нужен только для входа в журнал. При выходе из Doodle он удаляется.</p>
    </Tile>
  );
}
