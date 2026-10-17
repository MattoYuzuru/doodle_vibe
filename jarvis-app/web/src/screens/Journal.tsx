import { AnimatePresence, m } from "framer-motion";
import { CalendarX2, ChevronDown, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Ring } from "../components/Ring";
import { Tile, TileLabel } from "../components/Tile";
import { Skeleton, fmtGrade } from "../components/ui";
import { pct, plural, tone } from "../lib/journal";
import type { EjData, EjState, EjSubject } from "../store/api";
import { useJournal } from "../store/journal";
import { haptic } from "../telegram/webapp";
import { fieldClass } from "./TaskForm";

const day = (d: string | null) => {
  const t = d ? new Date(d) : null;
  return !t || Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
};
const stamp = (at: string) => new Date(at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Вкладка «Журнал»: посещаемость и успеваемость из электронного журнала МИСИС (ej.misis.ru) за текущий семестр.
 * Вход — тем же логином и паролем, что в Moodle: при входе в бот журнал подключается сам; кто вошёл раньше, вводит
 * пароль здесь один раз. Пароль сервер не хранит — только вход в журнал, который обновляется сам.
 */
export function JournalScreen() {
  const { st, status, error, load } = useJournal();
  useEffect(() => { void load(); }, [load]);
  const data = st?.connected ? st.data : null;
  const busy = status === "loading";

  return (
    <div className="flex flex-col gap-3">
      <m.header className="flex items-start justify-between gap-3 px-1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <div className="min-w-0">
          <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Журнал</h1>
          <p className="mt-0.5 truncate text-s font-semibold text-hint">{data ? [data.semester, data.group].filter(Boolean).join(" · ") || "Посещаемость и успеваемость" : "Посещаемость и успеваемость"}</p>
        </div>
        {st?.connected && (
          <button onClick={() => { haptic.select(); void load(true); }} disabled={busy} aria-label="Обновить" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent disabled:opacity-40">
            <RefreshCw size={18} strokeWidth={2.25} className={busy ? "animate-spin" : ""} />
          </button>
        )}
      </m.header>

      {!st && (busy || status === "idle") && <><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}
      {status === "error" && (
        <p className="px-1 text-s font-semibold text-red">{data ? `Не удалось обновить: ${error}. Показаны данные на ${stamp(data.at)}.` : error}</p>
      )}
      {st && !st.connected && <ConnectCard st={st} />}
      {st?.connected && !data && busy && <><Skeleton className="h-36 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /><Skeleton className="h-28 rounded-[22px]" /></>}
      {data && (
        <>
          <Summary data={data} />
          {data.subjects.length === 0 && (
            <Tile index={1} span={2} className="!min-h-0 py-4"><p className="text-s text-hint">В журнале пока нет дисциплин этого семестра.</p></Tile>
          )}
          {data.subjects.map((s, i) => <SubjectCard key={s.id} s={s} index={Math.min(i + 1, 6)} />)}
          <p className="px-1 pb-2 text-[12px] leading-[16px] text-hint">
            Электронный журнал МИСИС, данные на {stamp(data.at)}. Проценты — как их считает журнал; рейтинг копится до конца семестра.
          </p>
        </>
      )}
    </div>
  );
}

/** Сводка семестра: средние посещаемость и рейтинг по дисциплинам, всего пропусков. */
function Summary({ data }: { data: EjData }) {
  const { attendance, rating, absences, missedHours } = data.summary;
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

/** Дисциплина: три полоски (посещаемость, рейтинг, темп освоения); нажатие раскрывает пропуски и оценки. */
function SubjectCard({ s, index }: { s: EjSubject; index: number }) {
  const [open, setOpen] = useState(false);
  const sub = [s.control, s.teachers.join(", ")].filter(Boolean).join(" · ");
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3.5" onClick={() => { haptic.select(); setOpen((o) => !o); }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-m font-bold leading-[20px]">{s.name}</p>
          {sub && <p className="mt-0.5 truncate text-[12px] font-semibold text-hint">{sub}</p>}
        </div>
        {s.absences.length > 0 && (
          <span className="shrink-0 rounded-full bg-red/15 px-2 py-0.5 text-[12px] font-bold text-red tabular">
            {s.absences.length} {plural(s.absences.length, "пропуск", "пропуска", "пропусков")}
          </span>
        )}
        <m.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="mt-0.5 shrink-0 text-hint"><ChevronDown size={18} /></m.span>
      </div>
      <div className="mt-3 flex gap-3">
        <Bar label="Посещ." value={s.attendance} color={tone(s.attendance, "var(--c-yellow)")} />
        <Bar label="Рейтинг" value={s.rating} color="var(--c-accent)" />
        <Bar label="Темп" value={s.track} color={tone(s.trackInDate)} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <m.div key="details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <Details s={s} />
          </m.div>
        )}
      </AnimatePresence>
    </Tile>
  );
}

function Details({ s }: { s: EjSubject }) {
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
      {!s.error && !s.works.length && !(l && l.past) && <p className="text-s text-hint">По дисциплине пока нет отметок и оценок.</p>}
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
        {st.needPassword ? "Вход в журнал истёк. Введите пароль ещё раз — дальше журнал снова будет обновляться сам." : "Журнал МИСИС открывается тем же логином и паролем, что и Moodle. Введите пароль один раз — дальше посещаемость и оценки будут подгружаться сами."}
      </p>
      {st.email && <p className="mt-3 text-s"><span className="text-hint">Логин: </span><span className="font-semibold">{st.email}</span></p>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 flex flex-col gap-2">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль от Moodle" className={`${fieldClass} min-h-12`} />
        <button type="submit" disabled={busy || !password} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">{busy ? "Подключаю…" : "Подключить"}</button>
      </form>
      {(err || st.error) && <p className="mt-2 text-s font-semibold text-red">{err || `Прошлая попытка входа: ${st.error}`}</p>}
      <p className="mt-2 text-[12px] leading-[16px] text-hint">Пароль не сохраняется: сервер запоминает только вход в журнал.</p>
    </Tile>
  );
}
