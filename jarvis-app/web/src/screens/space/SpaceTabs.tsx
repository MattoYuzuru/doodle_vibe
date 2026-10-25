import { BookOpen, ExternalLink, Flag, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { MascotCard, MascotLoader } from "../../components/assistant/MascotCard";
import { characterFor, connectionsOf, freshness } from "../../lib/space-adapter";
import { sourceProblem, universitiesLink } from "../../lib/sources";
import { DeadlineRow } from "../../components/DeadlineRow";
import { HeroDeadlineCard } from "../../components/HeroDeadlineCard";
import { LessonRow } from "../../components/LessonRow";
import { Tile, TileTitle } from "../../components/Tile";
import { EmptyState } from "../../components/ui";
import { useNav } from "../../hooks/useNav";
import { useScheme } from "../../hooks/useScheme";
import { useMascotMotion, useSpace } from "../../hooks/useSpace";
import { DAY, addDays, dayKey, effectiveDue, formatLongDate, formatShortDate, mskParts } from "../../lib/dates";
import { lite } from "../../lib/perf";
import { type Connection, usePlatform } from "../../store/platform";
import type { Subject } from "../../store/types";
import type { AssistantIntent } from "../../theme/assistant-state";
import { haptic, tg } from "../../telegram/webapp";
import { SpaceSwitcher } from "./SpaceSwitcher";

/*
 * Вкладки в режиме нового API (DES-010): Главная, Дедлайны, План и Курсы выбранного вуза. Данные только этого вуза
 * (useSpace), работы и пары — теми же строками, что и прежние экраны. Сдают работы на сайте вуза: строка открывает
 * исходную ссылку. Ошибка обновления не прячет полученное раньше: плашка сверху, данные под ней с отметкой времени.
 */

/** Ссылку источника открываем снаружи: в Telegram — его браузером, иначе новой вкладкой. */
export const openSource = (url: string) => {
  if (!/^https:\/\//.test(url)) return;
  if (tg?.openLink) tg.openLink(url); else window.open(url, "_blank", "noopener,noreferrer");
};

const hm = (t: number) => { const p = mskParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
const subjectFor = (subjects: Subject[], id: string) => subjects.find((s) => s.id === id);
const STATUS_LABEL: Record<Connection["status"], [string, string]> = {
  ready: ["Готово", "bg-green/15 text-green"],
  pending: ["Подключается", "bg-accent/15 text-accent"],
  user_action_required: ["Нужен вход", "bg-yellow/15 text-yellow"],
  error: ["Ошибка", "bg-red/15 text-red"],
};

/** Обновить вуз: запустить синхронизацию готовых источников, дождаться и перечитать данные. */
async function refreshSpace(connections: Connection[]) {
  const st = usePlatform.getState();
  const jobs = await Promise.allSettled(connections.filter((c) => c.status === "ready" || c.status === "error").map((c) => st.sync(c.id)));
  await Promise.allSettled(jobs.flatMap((j) => (j.status === "fulfilled" ? [st.waitJob(j.value.id)] : [])));
  await usePlatform.getState().reload();
}

function useIntentHandler(deadlineUrl: (id: string) => string | undefined) {
  const universityId = usePlatform((s) => s.spaces.find((x) => x.id === s.activeId)?.universityId);
  return (intent: AssistantIntent, deadlineId?: string) => {
    haptic.tap();
    if (intent === "open-deadline" && deadlineId) { const u = deadlineUrl(deadlineId); if (u) openSource(u); }
    // Подключение и вход — на экране «Вузы» (удалённый браузер, пароль с MFA, токен, календарь).
    else if (intent === "reauth" || intent === "connect") location.hash = universitiesLink(universityId);
    else if (intent === "retry") void usePlatform.getState().reload();
  };
}

/** Плашка состояния данных: ошибка с повтором, устаревшие данные, время обновления. Данные под ней остаются. */
function SpaceStatus() {
  const { data } = useSpace();
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const f = freshness(data);
  const run = async () => { setBusy(true); try { await refreshSpace(connectionsOf(data)); } finally { setBusy(false); } };
  const tone = data.error ? "bg-red/10 text-red" : f.stale ? "bg-yellow/10 text-yellow" : "bg-card text-hint";
  const text = data.error
    ? `${data.error.kind === "offline" ? "Нет связи с сервером" : "Не получилось обновить"}${f.updatedAt ? `. Показываю данные от ${formatShortDate(dayKey(f.updatedAt))}, ${hm(f.updatedAt)}` : ""}`
    : f.updatedAt ? `Обновлено ${formatShortDate(dayKey(f.updatedAt))}, ${hm(f.updatedAt)}${f.stale ? " · данные могли устареть" : ""}` : null;
  if (!text) return null;
  return (
    <div className={`flex min-h-11 items-center gap-2 rounded-2xl px-3 py-1.5 text-s font-bold ${tone}`} role={data.error ? "alert" : undefined} data-space-status={data.error ? "error" : f.stale ? "stale" : "ok"}>
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={() => void run()} disabled={busy} aria-label="Обновить данные вуза"
        className="grid size-9 shrink-0 place-items-center rounded-full disabled:opacity-50">
        <RefreshCw size={16} strokeWidth={2.5} className={busy && !lite ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

function SourcesTile() {
  const { data, space } = useSpace();
  const connections = connectionsOf(data);
  if (!connections.length) return null;
  return (
    <Tile span={2} index={3} className="min-h-0 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <TileTitle>Источники</TileTitle>
        <a href={universitiesLink(space?.universityId)} className="-my-1 grid min-h-8 place-items-center px-1 text-s font-bold text-accent">Добавить</a>
      </div>
      <ul className="mt-1">
        {connections.map((c) => (
          <li key={c.id} className="flex min-h-11 items-center gap-2 border-t border-separator py-1.5 first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-m font-semibold">{c.label || new URL(c.sourceUrl).host}</span>
              <span className="block truncate text-s text-hint">{new URL(c.sourceUrl).host}</span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-s font-bold ${STATUS_LABEL[c.status][1]}`}>{sourceProblem(c.errorCode) ?? STATUS_LABEL[c.status][0]}</span>
            {/* Нужен вход (в том числе истёкший) — сразу к входу на экране «Вузы». */}
            {c.status === "user_action_required" && space && (
              <a href={universitiesLink(space.universityId)} className="grid min-h-9 shrink-0 place-items-center rounded-full bg-accent px-3 text-s font-bold text-on-accent" data-relogin={c.id}>Войти</a>
            )}
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Пустой экран без вузов: маскот зовёт подключить учёбу. */
function NoSpaces() {
  const motion = useMascotMotion();
  const dark = useScheme() === "dark";
  return (
    <div className="flex flex-col items-start gap-3 rounded-[22px] bg-card p-4" data-space-empty>
      <MascotLoader character="varya" label="Гнездо пока пустое" dark={dark} motion={motion} />
      <p className="text-m">Выбери свой вуз и скинь ссылки на учебные сайты: LMS, расписание, таблицы. Я соберу сроки и пары в одно место.</p>
      <a href={universitiesLink(null)} className="grid min-h-11 place-items-center rounded-2xl bg-accent px-4 text-m font-bold text-on-accent">Подключить учёбу</a>
    </div>
  );
}

export function SpaceHomeScreen() {
  const { space, data, deadlines, lessons, subjects, presentation, now, spaces, calm } = useSpace();
  const spacesStatus = usePlatform((s) => s.spacesStatus);
  const motion = useMascotMotion();
  const setCalm = usePlatform((s) => s.setCalm);
  const acknowledge = usePlatform((s) => s.acknowledge);
  const setTab = useNav((s) => s.setTab);
  const dark = useScheme() === "dark";
  const today = dayKey(now);
  const urlOf = (id: string) => deadlines.find((d) => d.id === id)?.url;
  const onIntent = useIntentHandler(urlOf);
  const open = useMemo(() => deadlines.filter((d) => effectiveDue(d.due) > now - 7 * DAY).sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due)), [deadlines, now]);
  const hero = open.find((d) => effectiveDue(d.due) > now) ?? open[0];
  const todays = lessons.filter((l) => l.date === today);

  return (
    <div className="space-ui flex flex-col gap-3 pt-1" data-space-home={space?.id ?? "none"}>
      <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em]">{formatLongDate(today)}</h1>
      {spaces.length > 0 && <SpaceSwitcher />}
      {spacesStatus === "loading" && !spaces.length ? (
        <MascotLoader character="dusya" label="Загружаю вузы" dark={dark} motion={motion} />
      ) : !space ? (
        <NoSpaces />
      ) : (
        <>
          <SpaceStatus />
          {presentation && (
            <MascotCard presentation={presentation} nowMs={now} dark={dark} size={72} onIntent={onIntent} onReactionShown={acknowledge}
              calm={calm} onToggleCalm={setCalm} />
          )}
          {data?.deadlines && (
            <div className="grid grid-cols-2 gap-2.5">
              {hero ? (
                <HeroDeadlineCard deadline={hero} subject={subjectFor(subjects, hero.subjectId)} now={now} onOpen={() => hero.url && openSource(hero.url)} />
              ) : (
                <Tile span={2} index={0}>
                  <EmptyState icon={Flag} title="Сроков нет" text={`В подключённых источниках ${space.name} нет работ со сроком.`} />
                </Tile>
              )}
              <Tile span={2} index={1} className="min-h-0 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <TileTitle>Расписание на сегодня{todays.length > 0 && <span className="ml-1.5 text-hint">{todays.length}</span>}</TileTitle>
                  <button type="button" onClick={() => setTab("plan")} className="-my-1 min-h-8 px-1 text-s font-bold text-accent">Весь план</button>
                </div>
                {todays.length ? todays.map((l, i) => (
                  <div key={i} className="border-t border-separator first:border-t-0"><LessonRow lesson={l} past={l.end <= hm(now)} /></div>
                )) : <p className="mt-2 pb-1 text-s font-semibold text-hint">{data.schedule?.items.length ? "Сегодня пар нет" : "Расписание не подключено"}</p>}
              </Tile>
              <SourcesTile />
            </div>
          )}
        </>
      )}
      {space && <p className="sr-only" aria-live="polite">Выбран вуз {space.name}. Маскот: {characterFor(space) === "varya" ? "Варя" : "Дуся"}.</p>}
    </div>
  );
}

function Loading() {
  const { space } = useSpace();
  const motion = useMascotMotion();
  const dark = useScheme() === "dark";
  return <MascotLoader character={space ? characterFor(space) : "dusya"} label={`Загружаю ${space?.name ?? ""}`.trim()} dark={dark} motion={motion} />;
}

export function SpaceDeadlinesScreen() {
  const { space, data, deadlines, subjects, now } = useSpace();
  const sorted = useMemo(() => {
    const future = deadlines.filter((d) => effectiveDue(d.due) > now).sort((a, b) => a.due - b.due);
    const past = deadlines.filter((d) => effectiveDue(d.due) <= now).sort((a, b) => b.due - a.due);
    return { future, past };
  }, [deadlines, now]);
  const undated = (data?.deadlines?.items.length ?? 0) - deadlines.length;
  return (
    <div className="space-ui flex flex-col gap-3 pt-1" data-space-deadlines={space?.id ?? "none"}>
      <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em]">Дедлайны{space ? ` · ${space.name}` : ""}</h1>
      <SpaceSwitcher />
      <SpaceStatus />
      {!data?.deadlines ? (data?.status === "loading" ? <Loading /> : null) : (
        <div className="rounded-[22px] bg-card px-3.5">
          {sorted.future.map((d) => (
            <div key={d.id} className="border-t border-separator first:border-t-0">
              <DeadlineRow deadline={d} subject={subjectFor(subjects, d.subjectId)} now={now} onOpen={() => d.url && openSource(d.url)} />
            </div>
          ))}
          {sorted.past.length > 0 && <p className="border-t border-separator pt-3 pb-1 text-s font-bold text-hint">Срок прошёл</p>}
          {sorted.past.map((d) => (
            <div key={d.id} className="border-t border-separator first:border-t-0">
              <DeadlineRow deadline={d} subject={subjectFor(subjects, d.subjectId)} now={now} onOpen={() => d.url && openSource(d.url)} />
            </div>
          ))}
          {!deadlines.length && <p className="py-4 text-m text-hint">Работ со сроком в источниках нет.</p>}
          {undated > 0 && <p className="border-t border-separator py-3 text-s text-hint">Ещё {undated} без указанного срока — их смотри на сайте вуза.</p>}
        </div>
      )}
    </div>
  );
}

export function SpacePlanScreen() {
  const { space, data, lessons, now } = useSpace();
  const today = dayKey(now);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((k) => ({ k, items: lessons.filter((l) => l.date === k) })).filter((d) => d.items.length), [lessons, today]);
  return (
    <div className="space-ui flex flex-col gap-3 pt-1" data-space-plan={space?.id ?? "none"}>
      <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em]">План{space ? ` · ${space.name}` : ""}</h1>
      <SpaceSwitcher />
      <SpaceStatus />
      {!data?.schedule ? (data?.status === "loading" ? <Loading /> : null) : days.length ? days.map((d) => (
        <section key={d.k} className="rounded-[22px] bg-card px-3.5 pt-2.5 pb-1.5" aria-label={formatLongDate(d.k)}>
          <p className="text-m font-bold">{formatLongDate(d.k)}</p>
          {d.items.map((l, i) => <div key={i} className="border-t border-separator first:border-t-0"><LessonRow lesson={l} past={d.k === today && l.end <= hm(now)} /></div>)}
        </section>
      )) : <p className="rounded-[22px] bg-card p-4 text-m text-hint">{data.schedule.items.length ? "На ближайшие две недели пар нет." : "Расписание этого вуза не подключено. Добавь ссылку на расписание через «+»."}</p>}
    </div>
  );
}

export function SpaceCoursesScreen() {
  const { space, data, subjects } = useSpace();
  const items = data?.courses?.items ?? [];
  return (
    <div className="space-ui flex flex-col gap-3 pt-1" data-space-courses={space?.id ?? "none"}>
      <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em]">Курсы{space ? ` · ${space.name}` : ""}</h1>
      <SpaceSwitcher />
      <SpaceStatus />
      {!data?.courses ? (data?.status === "loading" ? <Loading /> : null) : items.length ? (
        <ul className="rounded-[22px] bg-card px-3.5">
          {items.map((c, i) => (
            <li key={c.id} className="border-t border-separator first:border-t-0">
              <button type="button" onClick={() => openSource(c.url)} className="flex min-h-12 w-full items-center gap-3 py-2 text-left">
                <span className="grid size-8 shrink-0 place-items-center rounded-full text-s font-bold text-white" style={{ background: subjects[i]?.color }}>{subjects[i]?.short.slice(0, 2)}</span>
                <span className="min-w-0 flex-1 text-m font-semibold">{c.title}</span>
                <ExternalLink size={16} className="shrink-0 text-hint" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-[22px] bg-card p-4"><EmptyState icon={BookOpen} title="Курсов нет" text="В подключённых источниках нет списка курсов." /></div>
      )}
    </div>
  );
}
