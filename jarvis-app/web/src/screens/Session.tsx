import { CalendarClock, ExternalLink, EyeOff, FileText, GraduationCap, KeyRound, ListChecks, TriangleAlert, Undo2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { Skeleton } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { plural, sheetCaveat } from "../lib/journal";
import { dayText, rangeText } from "../lib/session";
import type { SessionChoice, SessionExtra, SessionInfo, SessionPeriod, SessionScore, SessionSubject, SessionView, SubjectNote } from "../store/api";
import { useAuth } from "../store/auth";
import { useJournal } from "../store/journal";
import { useSession } from "../store/session";
import { haptic } from "../telegram/webapp";

const stamp = (ms: number) => new Date(ms).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * «Сессия» — второй вид вкладки «Журнал» (переключатель наверху вкладки; шапка и кнопка «Обновить» там же): когда
 * сессия (по календарному графику учебного плана группы с misis.ru), какая форма контроля у каждой дисциплины
 * семестра, даты экзаменов (когда учебный отдел выложит расписание) и долги по журналу и Moodle.
 */
export function SessionPanel() {
  const { data, status, error, load } = useSession();
  const push = useNav((s) => s.push);
  // Перезагрузка и при смене группы (проверка 15 окт): вкладка смонтирована всегда, и после выбора группы в профиле
  // здесь висело «Укажите группу» до перезапуска.
  const group = useAuth((s) => s.profile?.group);
  useEffect(() => { void load(); }, [load, group]);
  const busy = status === "loading";

  return (
    <>
      {!data && (busy || status === "idle") && <><Skeleton className="h-40 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}
      {status === "error" && <p className="px-1 text-s font-semibold text-red">{data ? `Не удалось обновить: ${error}. Показаны данные на ${stamp(data.at)}.` : error}</p>}
      {data?.needGroup && (
        <Tile span={2} index={0} className="!min-h-0 py-4" onClick={() => { haptic.tap(); push({ name: "profile" }); }}>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><UsersRound size={18} strokeWidth={2.5} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-m font-bold">Укажите группу</span>
              <span className="block text-s text-hint">По группе находится учебный план: даты сессии и формы контроля</span>
            </span>
          </div>
        </Tile>
      )}
      {data && !data.needGroup && <Body data={data} />}
    </>
  );
}

function Body({ data }: { data: SessionView }) {
  const subjects = data.subjects ?? [];
  const up = data.upcoming ?? null;
  const groups: [string, SessionSubject[]][] = [
    ["Экзамены", subjects.filter((s) => s.exam)],
    ["Зачёты с оценкой", subjects.filter((s) => s.graded && !s.exam)],
    ["Зачёты", subjects.filter((s) => s.pass && !s.exam && !s.graded)],
    ["Курсовые работы", subjects.filter((s) => s.coursework)],
    ["Без аттестации в этом семестре", subjects.filter((s) => !s.controls.length)],
  ];
  const journalOk = !data.journal || data.journal.state === "ok";
  const moodleOk = !data.moodle || data.moodle.state === "ok";
  // Почему не ясно, какой вариант по выбору взят: не прочитаны источники или однозначно не определить.
  const openWhy = !journalOk && !moodleOk ? "Журнал и курсы Moodle ещё не прочитаны"
    : !journalOk ? "Журнал не загружен, а по курсам Moodle однозначно не определить"
    : !moodleOk ? "Курсы Moodle ещё не прочитаны, а по журналу не видно" : "Ни журнал, ни курсы Moodle однозначно этого не показывают";
  // Варианты одной дисциплины по выбору, из которых не ясно, какой взят, в заголовке считаются один раз — как на Главной и в боте.
  const shown = (list: SessionSubject[]) => list.filter((s) => !s.electiveOpen).length + new Set(list.filter((s) => s.electiveOpen).map((s) => s.elective)).size;
  const extra = data.extra ?? [], optional = data.optional ?? [], hidden = data.hidden ?? [];
  let i = 0;
  return (
    <>
      {data.planError && (
        <Tile span={2} index={i++} className="!min-h-0 py-3">
          <p className="flex items-start gap-2 text-s font-semibold text-yellow"><TriangleAlert size={16} className="mt-0.5 shrink-0" />Учебный план группы на misis.ru не найден: {data.planError}. Формы контроля — из журнала, дат сессии нет.</p>
        </Tile>
      )}
      <JournalBanner data={data} index={i++} />
      {up && <Countdown s={up} periods={data.periods ?? []} today={data.today ?? ""} index={i++} />}
      <ExamsTile data={data} index={i++} />
      {groups.map(([title, list]) => list.length > 0 && (
        <section key={title} className="flex flex-col gap-2">
          <TileLabel className="px-1 pt-1">{title} <span className="text-hint/70">{shown(list)}</span></TileLabel>
          {list.map((s) => <SubjectCard key={s.key ?? s.index ?? s.name} s={s} journalOk={journalOk} openWhy={openWhy} index={Math.min(i++, 8)} />)}
        </section>
      ))}
      {subjects.length === 0 && !data.planError && <Tile span={2} index={i++} className="!min-h-0 py-4"><p className="text-s text-hint">Дисциплин этого семестра в плане не нашлось.</p></Tile>}
      {extra.length > 0 && (
        <section className="flex flex-col gap-2">
          <TileLabel className="px-1 pt-1">Вне плана группы <span className="text-hint/70">{extra.length}</span></TileLabel>
          {extra.map((x) => <ExtraCard key={x.key} x={x} index={Math.min(i++, 8)} />)}
        </section>
      )}
      {optional.length > 0 && <OptionalTile list={optional} index={Math.min(i++, 8)} />}
      {hidden.length > 0 && <HiddenTile list={hidden} index={Math.min(i++, 8)} />}
      <p className="px-1 text-[12px] leading-[16px] text-hint">
        План группы описывает обычного студента. Перевелись, взяли другую дисциплину по выбору или что-то перезачли — уточните прямо в карточках: дисциплина по выбору — «Это моя» или «У меня другая», лишнее — «Не моё» (вернуть можно внизу). Ваши отметки главнее догадок по журналу и Moodle.
      </p>
      <p className="px-1 pb-2 text-[12px] leading-[16px] text-hint">
        {data.program ? <>По учебному плану {data.program.code} «{data.program.name}»{data.program.year ? ` на ${data.program.year}` : ""} с misis.ru. </> : null}
        Зачёты принимаются на последних занятиях по расписанию, курсовые — на последней учебной неделе, экзамены — по расписанию сессии.
        {data.program?.url && <> <a href={data.program.url} target="_blank" rel="noreferrer" className="font-semibold text-accent">Открыть план (PDF)</a></>}
      </p>
    </>
  );
}

const PERIOD_COLOR: Record<SessionPeriod["kind"], string> = { theory: "var(--c-accent)", exam: "var(--c-red)", holiday: "var(--c-green)", practice: "var(--c-yellow)", diploma: "var(--c-yellow)", research: "var(--c-yellow)", other: "var(--c-hint)" };

/** До сессии: число дней крупно, даты, полоса учебного года с отметкой «сейчас». */
function Countdown({ s, periods, today, index }: { s: SessionInfo; periods: SessionPeriod[]; today: string; index: number }) {
  const total = periods.reduce((n, p) => n + (p.weeks[1] - p.weeks[0] + 1), 0) || 52;
  const cur = periods.find((p) => p.from <= today && today <= p.to);
  const pos = cur ? (cur.weeks[0] - 1 + (Date.parse(today) - Date.parse(cur.from)) / 6048e5) / total : null;
  const year = s.from.slice(0, 4) !== today.slice(0, 4) ? ` ${s.from.slice(0, 4)}` : "";
  const label = `${s.label[0].toUpperCase()}${s.label.slice(1)} сессия`;
  return (
    <Tile span={2} index={index} className="!min-h-0 py-4">
      <TileLabel className="flex items-center gap-1.5"><GraduationCap size={13} strokeWidth={2.5} />{s.semester} семестр</TileLabel>
      <div className="mt-2 flex items-end gap-3">
        <p className="font-display text-[40px] leading-none font-extrabold tracking-[-0.04em] tabular">{s.state === "now" || s.state === "ahead" ? s.days : "—"}</p>
        <div className="min-w-0 pb-1">
          <p className="text-m font-bold leading-[20px]">{s.state === "now" ? `${plural(s.days, "день", "дня", "дней")} до конца сессии` : s.state === "ahead" ? `${plural(s.days, "день", "дня", "дней")} до сессии` : `${label} прошла`}</p>
          <p className="truncate text-s font-semibold text-hint">{label} · {rangeText(s.from, s.to)}{year}</p>
        </div>
      </div>
      <div className="mt-3 flex h-2 w-full gap-px overflow-hidden rounded-full">
        {periods.map((p, k) => <span key={k} className="h-full" style={{ width: `${((p.weeks[1] - p.weeks[0] + 1) / total) * 100}%`, background: PERIOD_COLOR[p.kind], opacity: p.kind === "theory" ? 0.35 : 0.75 }} title={`${p.label}: ${rangeText(p.from, p.to)}`} />)}
      </div>
      {pos != null && (
        <div className="relative h-3">
          <span className="absolute -top-0.5 size-3 -translate-x-1/2 rounded-full border-2 border-page bg-text" style={{ left: `${pos * 100}%` }} aria-label="сейчас" />
        </div>
      )}
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] font-semibold text-hint">
        {periods.filter((p) => p.to >= today).slice(0, 4).map((p, k) => <span key={k}>{p.label} {p.from <= today ? `до ${dayText(p.to)}` : rangeText(p.from, p.to)}</span>)}
      </p>
    </Tile>
  );
}

/** Расписание экзаменов с misis.ru: даты по дисциплинам или «ещё не опубликовано». */
function ExamsTile({ data, index }: { data: SessionView; index: number }) {
  const ex = data.exams;
  // open — вариант дисциплины по выбору, про который не ясно, взят ли он: в списке с пометкой, а не как свой экзамен.
  const rows = (data.subjects ?? []).flatMap((s) => s.examDates.filter((e) => e.kind !== "consult").map((e) => ({ ...e, name: s.name, open: !!s.electiveOpen }))).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "99").localeCompare(b.time ?? "99"));
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <TileLabel className="flex items-center gap-1.5"><CalendarClock size={13} strokeWidth={2.5} />Расписание экзаменов</TileLabel>
        {ex?.published && ex.url && <a href={ex.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[12px] font-bold text-accent" onClick={() => haptic.tap()}><FileText size={13} />файл</a>}
      </div>
      {ex?.published ? (
        rows.length ? (
          <ul className="mt-2 flex flex-col">
            {rows.map((e, k) => (
              <li key={k} className="flex min-h-10 items-center gap-3 border-t border-separator py-1.5 first:border-t-0">
                <span className="w-[72px] shrink-0 text-s font-bold tabular">{dayText(e.date)}{e.time ? <span className="block text-[12px] font-semibold text-hint">{e.time}</span> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-s font-semibold">{e.name}</span>
                  {(e.open || e.place || e.teacher) && <span className="block truncate text-[12px] text-hint">{[e.open ? "по выбору — если это ваш вариант" : null, e.place, e.teacher].filter(Boolean).join(" · ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-s text-hint">Расписание вышло{ex.title ? ` («${ex.title}»)` : ""}, но по дисциплинам вашей группы в нём ничего не нашлось — посмотрите файл.</p>
      ) : (
        <p className="mt-2 text-s leading-[19px] text-hint">
          Ещё не опубликовано. Учебный отдел выкладывает его на misis.ru не позже чем за неделю до сессии — бот пришлёт даты, как только они появятся.
          {ex?.page && <> <a href={ex.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-accent">Страница сессии<ExternalLink size={12} /></a></>}
        </p>
      )}
    </Tile>
  );
}

const JOURNAL_TEXT: Record<string, string> = {
  need_password: "Вход в электронный журнал истёк — баллов из журнала нет, и не видно, какие дисциплины по выбору вы взяли. Введите пароль ещё раз.",
  rejected: "Сохранённый пароль от журнала не подошёл — возможно, вы его сменили. Баллов из журнала нет, и не видно, какие дисциплины по выбору вы взяли. Откройте Журнал и введите текущий пароль.",
  not_connected: "Электронный журнал не подключён — баллов из журнала нет, и не видно, какие дисциплины по выбору вы взяли.",
  error: "Электронный журнал сейчас не отвечает — баллы из журнала не показаны.",
  other_semester: "Электронный журнал пока показывает другой семестр — баллы и выбор дисциплин из него не учтены.",
};

/** Журнал не загружен: почему и переход во вкладку «Журнал», где вводится пароль. */
function JournalBanner({ data, index }: { data: SessionView; index: number }) {
  const setJournalView = useNav((s) => s.setJournalView);
  const jt = data.journal ? JOURNAL_TEXT[data.journal.state] : undefined;
  // Курсы Moodle не прочитаны (Moodle не отвечает) — отдельной строкой: из-за этого не видно пересдач и академической разницы.
  const mt = data.moodle?.state === "not_loaded" ? "Курсы Moodle сейчас не прочитаны — пересдачи, академическая разница и баллы из Moodle не показаны." : undefined;
  const text = [jt, mt].filter(Boolean).join(" ");
  if (!text) return null;
  const st = data.journal?.state;
  const action = !jt || st === "error" || st === "other_semester" ? null : st === "need_password" || st === "rejected" ? "Ввести пароль" : "Подключить журнал";
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3" onClick={action ? () => { haptic.tap(); setJournalView("journal"); } : undefined}>
      <p className="flex items-start gap-2 text-s font-semibold text-yellow"><KeyRound size={16} className="mt-0.5 shrink-0" /><span className="min-w-0">{text}</span></p>
      {action && <p className="mt-1.5 pl-6 text-s font-bold text-accent">{action} →</p>}
    </Tile>
  );
}

/** Отправить уточнение: пока идёт — кнопки неактивны; ошибка — коротким уведомлением. */
function useChoose() {
  const choose = useSession((s) => s.choose);
  const [busy, setBusy] = useState(false);
  const run = async (c: SessionChoice, done?: string) => {
    if (busy) return;
    haptic.tap();
    setBusy(true);
    try {
      await choose(c);
      if (done) toast(done);
      // «Не моё» здесь и «не моя» в боте — одно (16 окт 2026): вкладка «Журнал» показывает такие дисциплины отдельно.
      if (c.kind === "hidden" && useJournal.getState().st?.connected) void useJournal.getState().load();
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(false); }
  };
  return { busy, run };
}
const chip = "rounded-full bg-raised px-2 py-0.5 text-[12px] font-semibold text-hint";
const act = "rounded-full px-2.5 py-1 text-[12px] font-bold disabled:opacity-50";
const FROM: Record<string, string> = { user: "выбрано вами", journal: "по журналу", moodle: "по курсу в Moodle" };

/** Дисциплина: форма контроля, дата экзамена, баллы; уточнения студента — выбор варианта, «не хожу», «не моё». */
function SubjectCard({ s, index, journalOk, openWhy }: { s: SessionSubject; index: number; journalOk: boolean; openWhy: string }) {
  const exam = s.examDates.find((e) => e.kind !== "consult");
  const { busy, run } = useChoose();
  const [other, setOther] = useState(false);
  const alternatives = (s.variants ?? []).filter((v) => v.index !== s.index);
  return (
    <Tile span={2} index={index} enter="fade" className={`!min-h-0 py-3 ${s.level === "red" ? "ring-1 ring-red/40" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Длинное слово переносится в своей колонке, а не наезжает на дату экзамена (проверка 15 окт). */}
          <p className="text-m font-bold leading-[20px] wrap-break-word hyphens-auto">{s.name}</p>
          <p className="mt-1 flex flex-wrap gap-1">
            {s.labels.map((l) => <span key={l} className={chip}>{l}</span>)}
            {s.elective && <span className={chip}>{s.electiveOpen ? `по выбору · один из ${s.electiveOpen}` : `по выбору${s.electiveFrom ? ` · ${FROM[s.electiveFrom]}` : ""}`}</span>}
            {s.kind === "optional" && <span className={chip}>факультатив{s.attendingFrom ? ` · ${FROM[s.attendingFrom]}` : ""}</span>}
          </p>
        </div>
        {exam && (
          <span className="shrink-0 text-right">
            <span className="block text-s font-bold tabular">{dayText(exam.date)}</span>
            <span className="block text-[12px] font-semibold text-hint">{[exam.time, exam.place].filter(Boolean).join(" · ")}</span>
          </span>
        )}
      </div>
      {s.electiveOpen ? (
        <p className="mt-2 text-[12px] leading-[16px] text-hint">Какой вариант вы взяли, не ясно: {openWhy.charAt(0).toLowerCase() + openWhy.slice(1)}. Отметьте свой — остальные варианты пропадут.</p>
      ) : s.score ? <Score sc={s.score} /> : s.controls.length > 0 && !s.info && (
        <p className="mt-2 text-[12px] font-semibold text-hint">{!journalOk ? "Электронный журнал не загружен — баллов из него пока нет" : s.inJournal ? "Журнал не дал порогов оценок по этой дисциплине" : "Этой дисциплины нет в электронном журнале — баллы неизвестны"}. Условия получения оценки уточните у преподавателя.</p>
      )}
      {s.info && <Note info={s.info} />}
      {s.sheetNote && <p className="mt-1.5 text-[12px] leading-[16px] text-hint">{cap(s.sheetNote)}.</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {s.electiveOpen && <button disabled={busy} className={`${act} bg-accent text-on-accent`} onClick={() => run({ kind: "elective", key: s.elective!, value: s.index! }, "Отмечено: это ваш вариант")}>Это моя</button>}
        {!s.electiveOpen && alternatives.length > 0 && !other && <button disabled={busy} className={`${act} bg-raised text-text`} onClick={() => { haptic.tap(); setOther(true); }}>У меня другая</button>}
        {s.electiveFrom === "user" && <button disabled={busy} className={`${act} bg-raised text-hint`} onClick={() => run({ kind: "elective", key: s.elective!, value: null }, "Вариант снова определяется сам")}>Сбросить выбор</button>}
        {s.kind === "optional" && <button disabled={busy} className={`${act} bg-raised text-text`} onClick={() => run({ kind: "optional", key: s.index!, value: false }, "Факультатив убран из сессии")}>Не хожу</button>}
        {s.kind !== "optional" && !s.electiveOpen && <button disabled={busy} className={`${act} flex items-center gap-1 bg-raised text-hint`} onClick={() => run({ kind: "hidden", key: s.key, value: true }, "Скрыто — вернуть можно внизу")}><EyeOff size={12} />Не моё</button>}
      </div>
      {other && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[12px] font-semibold text-hint">Какую дисциплину вы взяли вместо этой?</p>
          {alternatives.map((v) => <button key={v.index} disabled={busy} className={`${act} bg-raised text-left text-text`} onClick={() => run({ kind: "elective", key: s.elective!, value: v.index }, "Отмечено")}>{v.name}</button>)}
        </div>
      )}
    </Tile>
  );
}

const MONTHS_N = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const WHY: Record<SessionExtra["why"], (x: SessionExtra) => string> = {
  retake: (x) => `Вы записаны на курс пересдачи в Moodle${x.month ? ` (${MONTHS_N[Number(x.month.slice(5, 7)) - 1]} ${x.month.slice(0, 4)})` : ""}. Если долг ещё не закрыт — сроки пересдачи уточните у преподавателя или в дирекции.`,
  earlier: (x) => `В плане вашей группы эта дисциплина в ${x.planSemesters?.join(", ")} семестре, а у вас она сейчас. Похоже на академическую разницу после перевода — форму и сроки аттестации уточните в дирекции.`,
  journal: () => "Есть в вашем электронном журнале, но в плане группы на этот семестр её нет — возможно, индивидуальный план или разница после перевода. Форму и сроки аттестации уточните в дирекции.",
};
const WHY_CHIP: Record<SessionExtra["why"], string> = { retake: "пересдача", earlier: "академическая разница?", journal: "только в журнале" };

/** Вне плана группы: пересдача, академическая разница или дисциплина только из журнала. */
function ExtraCard({ x, index }: { x: SessionExtra; index: number }) {
  const { busy, run } = useChoose();
  return (
    <Tile span={2} index={index} enter="fade" className={`!min-h-0 py-3 ${x.level === "red" ? "ring-1 ring-red/40" : ""}`}>
      <p className="text-m font-bold leading-[20px] wrap-break-word hyphens-auto">{x.name}</p>
      <p className="mt-1 flex flex-wrap gap-1">
        {x.label && <span className={chip}>{x.label}</span>}
        <span className="rounded-full bg-yellow/15 px-2 py-0.5 text-[12px] font-semibold text-yellow">{WHY_CHIP[x.why]}</span>
      </p>
      <p className="mt-2 text-[12px] leading-[16px] text-hint">{WHY[x.why](x)}</p>
      {x.score && <Score sc={x.score} />}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {x.course && <a href={x.course.url} target="_blank" rel="noreferrer" className={`${act} flex items-center gap-1 bg-raised text-accent`} onClick={() => haptic.tap()}>Курс в Moodle<ExternalLink size={12} /></a>}
        <button disabled={busy} className={`${act} flex items-center gap-1 bg-raised text-hint`} onClick={() => run({ kind: "hidden", key: x.key, value: true }, "Скрыто — вернуть можно внизу")}><EyeOff size={12} />Не моё</button>
      </div>
    </Tile>
  );
}

/** Факультативы, на которые студент (насколько известно) не записан: одна плитка, «Хожу» переносит в сессию. */
function OptionalTile({ list, index }: { list: NonNullable<SessionView["optional"]>; index: number }) {
  const { busy, run } = useChoose();
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5">
      <TileLabel className="flex items-center gap-1.5"><ListChecks size={13} strokeWidth={2.5} />Факультативы</TileLabel>
      <p className="mt-1.5 text-[12px] leading-[16px] text-hint">Необязательные дисциплины: аттестация по ним нужна, только если вы на них записались. Ходите — отметьте, и они появятся в сессии.</p>
      <ul className="mt-1.5 flex flex-col">
        {list.map((o) => (
          <li key={o.key} className="flex min-h-10 items-center gap-2 border-t border-separator py-1.5 first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block text-s font-semibold">{o.name}</span>
              {o.labels.length > 0 && <span className="block text-[12px] text-hint">{o.labels.join(", ")}</span>}
            </span>
            {o.index && <button disabled={busy} className={`${act} shrink-0 bg-raised text-accent`} onClick={() => run({ kind: "optional", key: o.index!, value: true }, "Факультатив добавлен в сессию")}>Хожу</button>}
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Скрытое самим студентом — свёрнуто; «Вернуть» снимает отметку. */
function HiddenTile({ list, index }: { list: NonNullable<SessionView["hidden"]>; index: number }) {
  const { busy, run } = useChoose();
  const [open, setOpen] = useState(false);
  // Раскрытие — своей кнопкой внутри плитки: с onClick у самой плитки она после нажатия пересоздавалась (кнопка → блок)
  // и заново проигрывала появление, а кнопки «Вернуть» внутри кнопки были бы недопустимой вложенностью.
  const label = <TileLabel className="flex items-center gap-1.5"><EyeOff size={13} strokeWidth={2.5} />Скрыто вами · {list.length}</TileLabel>;
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3">
      {!open ? (
        <button type="button" aria-expanded={false} className="block w-full text-left" onClick={() => { haptic.tap(); setOpen(true); }}>
          {label}
          <span className="mt-1 block text-[12px] text-hint">Показать и вернуть</span>
        </button>
      ) : <>{label}
        <ul className="mt-1.5 flex flex-col">
          {list.map((h) => (
            <li key={h.key} className="flex min-h-10 items-center gap-2 border-t border-separator py-1.5 first:border-t-0">
              <span className="min-w-0 flex-1">
                <span className="block text-s font-semibold text-hint">{h.name}</span>
                {h.from === "bot" && <span className="block text-[12px] text-hint">ответ боту: «не моя»</span>}
              </span>
              <button disabled={busy} className={`${act} flex shrink-0 items-center gap-1 bg-raised text-text`} onClick={() => run({ kind: "hidden", key: h.key, value: null }, "Возвращено")}><Undo2 size={12} />Вернуть</button>
            </li>
          ))}
        </ul>
      </>}
    </Tile>
  );
}

/**
 * Справка по дисциплине, у которой баллов и пропусков нет ни в журнале, ни в Moodle (английский: их ведёт
 * преподаватель): из чего складываются баллы и пороги по рабочей программе, что с пропусками, ссылка на программу.
 */
function Note({ info }: { info: SubjectNote }) {
  return (
    <div className="mt-2.5">
      <p className="text-[12px] font-semibold text-hint">Баллы по рабочей программе (из {info.scale}):</p>
      <p className="mt-1.5 flex flex-wrap gap-1.5">
        {info.parts.map((p) => <span key={p.name} className="rounded-full bg-raised px-2 py-0.5 text-[12px] font-semibold text-text tabular">{p.name} · {p.max}</span>)}
      </p>
      <p className="mt-1.5 text-[12px] font-bold text-text">{info.bands}</p>
      <ul className="mt-1.5 flex flex-col gap-1 text-[12px] leading-[16px] text-hint">
        {info.notes.map((n) => <li key={n} className="flex gap-1.5"><span aria-hidden>•</span><span className="min-w-0">{n}</span></li>)}
      </ul>
      <p className="mt-1.5 text-[11px] leading-[14px] text-hint">
        Сколько у вас баллов и пропусков — уточните у преподавателя. <a href={info.url} target="_blank" rel="noreferrer" className="font-semibold text-accent" onClick={() => haptic.tap()}>Рабочая программа</a>
      </p>
    </div>
  );
}

const num = (v: number) => String(Math.round(v * 10) / 10).replace(".", ",");
/** Сколько не хватает — вверх до десятых: 0,04 → «0,1», чтобы при невзятом пороге не было «ещё 0». */
const up = (v: number) => String(Math.ceil(Math.round(v * 100) / 10) / 10).replace(".", ",");
const from = (t: { strict?: boolean; at: number }) => `${t.strict ? "более" : "от"} ${num(t.at)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Дата изменения файла (мс) → «14 окт» по Москве. */
const fileDay = (ms: number) => dayText(new Date(ms + 3 * 3600e3).toISOString().slice(0, 10));
const TH_FROM: Record<string, string> = { journal: "электронного журнала", moodle: "рейтинг-плана курса", sheet: "рейтинг-плана в таблице курса" };
/** «По таблице преподавателя «Журнал» (лист БИСТ-24_ПО_2, 14 окт), пороги — из электронного журнала, расчёт ориентировочный». */
const sheetFooter = (sc: SessionScore) => {
  const s = sc.sheet;
  const meta = [s?.sheet && s.sheet !== "Sheet1" && s.sheet !== "Лист1" ? `лист ${s.sheet}` : null, s?.modified ? fileDay(s.modified) : null].filter(Boolean).join(", ");
  return `По таблице преподавателя «${s?.title || s?.file || "в курсе"}»${meta ? ` (${meta})` : ""}${sc.thresholdsFrom ? `, пороги — из ${TH_FROM[sc.thresholdsFrom]}` : ""}, расчёт ориентировочный`;
};

/**
 * Баллы дисциплины: из электронного журнала (из 100) или из журнала оценок Moodle (из максимума рейтинг-плана, если он
 * известен). Полоса — набрано (заливка) и сколько ещё можно набрать (светлее), риски — пороги 3/4/5 (у зачёта — один).
 * Ниже — сколько не хватает до каждого порога; «не набрать» — даже со всеми оставшимися работами. Если план с журналом
 * оценок не сходится или порогов нет — пороги текстом и пометка «уточните у преподавателя».
 */
function Score({ sc }: { sc: SessionScore }) {
  const scale = sc.scale;
  const pct = (v: number) => (scale ? Math.min(100, (v / scale) * 100) : 0);
  const moodle = sc.source === "moodle", sheet = sc.source === "sheet";
  return (
    <div className="mt-2.5">
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[12px] font-semibold text-hint">
        <span className="whitespace-nowrap">Баллы{moodle ? " (Moodle)" : sheet ? " (таблица)" : ""}: <b className="text-m text-text tabular">{num(sc.have)}</b>{scale ? ` из ${num(scale)}` : ""}</span>
        {moodle
          ? <span className="whitespace-nowrap tabular">оценено {sc.graded ?? 0}{sc.pending ? ` · без оценки ${sc.pending}` : ""}</span>
          : sc.left != null && <span className="whitespace-nowrap tabular">можно ещё {num(sc.left)}{sc.pending ? ` · без оценки ${sc.pending}` : ""}</span>}
      </p>
      {scale != null && (
        <div className="relative mt-1.5 h-2 rounded-full bg-raised">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent/25" style={{ width: `${pct(sc.max ?? scale)}%` }} />
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct(sc.have)}%` }} />
          {sc.targets.map((t) => (
            <span key={t.key} className={`absolute -top-1 h-4 w-0.5 rounded-full ${t.done ? "bg-green" : t.reachable === false ? "bg-red" : "bg-text/60"}`} style={{ left: `calc(${pct(t.at)}% - 1px)` }} title={`${t.label}: ${from(t)}`} />
          ))}
        </div>
      )}
      {moodle && sc.confidence === "medium" && sc.sumMax != null && scale != null && (
        <p className="mt-1 text-[12px] leading-[16px] text-hint">Работ в Moodle пока заведено на {num(sc.sumMax)} из {num(scale)} — остальные, видимо, впереди.</p>
      )}
      {moodle && !sc.targets.length && (
        <p className="mt-1.5 text-[12px] leading-[16px] text-hint">
          {sc.planBands ? <>По рейтинг-плану: {sc.planBands}.{sc.note ? ` Но ${sc.note}.` : ""}</>
            : sc.planPass != null ? <>Проходной балл по рейтинг-плану: {num(sc.planPass)}.</>
            : <>{cap(sc.planNote || "сколько баллов нужно на оценку, в рейтинг-плане курса не написано")}.</>}
          {sc.pendingWorks && sc.pendingWorks.length > 0 && <> Пока без оценки (не сдано или не проверено): {sc.pendingWorks.slice(0, 3).map((w) => `«${w.name}» (до ${num(w.max)})`).join(", ")}{sc.pendingWorks.length > 3 ? " и др." : "."}</>}
        </p>
      )}
      {moodle && sc.finals && sc.finals.length > 0 && <p className="mt-1 text-[12px] font-semibold text-hint">Выставлено: {sc.finals.map((f) => `${f.name} — ${num(f.grade)}`).join(", ")}</p>}
      {sheet && sc.parts && sc.parts.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {sc.parts.map((p) => <span key={p.name} className="rounded-full bg-raised px-2 py-0.5 text-[12px] font-semibold text-text tabular">{p.name} · {num(p.have)} из {num(p.max)}</span>)}
        </p>
      )}
      {sheet && !sc.targets.length && (
        <p className="mt-1.5 text-[12px] leading-[16px] text-hint">
          {sc.totalLabel && scale == null ? <>В таблице это «{sc.totalLabel}». </> : null}
          {sc.planPass != null ? <>Проходной балл по рейтинг-плану: {num(sc.planPass)}.</>
            : sc.planBands ? <>{cap(sc.planBands)}{sc.planNote ? `; ${sc.planNote}` : ""}.</>
            : <>{cap(sc.planNote || "сколько не хватает до оценки, по таблице не посчитать")}.</>}
        </p>
      )}
      {sheet && (sc.gradeText || sc.grade != null) && <p className="mt-1 text-[12px] font-semibold text-hint">В таблице: {sc.gradeText ?? `оценка ${sc.grade}`}</p>}
      {sheet && sheetCaveat(sc.sheet) && <p className="mt-1 text-[12px] leading-[16px] text-yellow">{sheetCaveat(sc.sheet)}</p>}
      <p className="mt-2 flex flex-wrap gap-1.5">
        {sc.targets.map((t) => (
          <span key={t.key} className={`rounded-full px-2 py-0.5 text-[12px] font-bold tabular ${t.done ? "bg-green/15 text-green" : t.reachable === false ? "bg-red/15 text-red" : "bg-raised text-text"}`}>
            {t.label}: {t.done ? "набрано ✓" : t.reachable === false ? `не набрать (${from(t)})` : `ещё ${up(t.need)}`}
          </span>
        ))}
      </p>
      {sc.failed.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] font-semibold text-yellow"><TriangleAlert size={13} strokeWidth={2.25} className="mt-0.5 shrink-0" />
          <span className="min-w-0">Ниже порога: {sc.failed.slice(0, 2).map((n) => `«${n}»`).join(", ")}{sc.failed.length > 2 ? ` и ещё ${sc.failed.length - 2}` : ""} — по правилам журнала, пока не пересдано, выходит 2.</span></p>
      )}
      <p className="mt-1.5 text-[11px] leading-[14px] text-hint">
        {sheet ? sheetFooter(sc) : moodle ? `По оценкам${sc.planFound ? " и рейтинг-плану" : ""} в Moodle, расчёт ориентировочный` : "Расчёт по электронному журналу ориентировочный"} — уточните у преподавателя.
        {moodle && sc.planUrl && <> <a href={sc.planUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent">Рейтинг-план</a></>}
        {moodle && sc.gradesUrl && <> · <a href={sc.gradesUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent">Оценки в Moodle</a></>}
        {sheet && sc.sheet?.url && <> <a href={sc.sheet.url} target="_blank" rel="noreferrer" className="font-semibold text-accent" onClick={() => haptic.tap()}>Таблица в Moodle</a></>}
        {sheet && sc.planUrl && <> · <a href={sc.planUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent" onClick={() => haptic.tap()}>Рейтинг-план</a></>}
      </p>
    </div>
  );
}
