import { m } from "framer-motion";
import { ChevronRight, CircleHelp, Flag, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ActiveLabs } from "../components/ActiveLabs";
import { HeroDeadlineCard } from "../components/HeroDeadlineCard";
import { JournalTile } from "../components/JournalTile";
import { SessionTile } from "../components/SessionTile";
import { LessonRow, matchSubject } from "../components/LessonRow";
import { MoodleDown, MoodleFailed, when } from "../components/MoodleDown";
import { Tile, TileTitle } from "../components/Tile";
import { Avatar, EmptyState, Skeleton } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { useScheme } from "../hooks/useScheme";
import { DAY, dayKey, effectiveDue, formatLongDate, keyToUtc, mskParts, todayKey } from "../lib/dates";
import { useAuth } from "../store/auth";
import { useSchedule } from "../store/schedule";
import { subjectOf, useAppStore, useFirstLoad } from "../store/useAppStore";
import { urgencyOf } from "../theme/urgency";
import { addToHomeScreen, haptic, homeScreenStatus, telegramUser } from "../telegram/webapp";

/** Главная в стиле бенто: мозаика стеклянных плиток, отвечает на вопрос «что делать сейчас?» */
export function HomeScreen() {
  // Из сторов — только нужные поля (проверка 15 окт): без селектора Главная перерисовывалась целиком на каждый set
  // (refresh() делает их 6–7 подряд — как раз в начале «потянуть вниз»), на каждый push/pop и смену вкладки.
  const { status, subjects, deadlines, moodle, pendingCourses } = useAppStore(useShallow((s) => ({
    status: s.status, subjects: s.subjects, deadlines: s.deadlines, moodle: s.moodle, pendingCourses: s.pendingCourses,
  })));
  const { pending, failed } = useFirstLoad();
  const authErr = useAuth((s) => s.status === "error");
  const push = useNav((s) => s.push);
  const setTab = useNav((s) => s.setTab);
  const now = useNow();
  const user = telegramUser();
  const today = todayKey();
  // Плитка «Добавить на экран телефона» — только если Telegram сообщил, что ярлыка ещё нет.
  const [homeScreen, setHomeScreen] = useState<string | null>(null);
  useEffect(() => { void homeScreenStatus().then(setHomeScreen); }, []);

  // Просроченные старше недели на Главной не показываем — они остаются во вкладке «Дедлайны».
  // Сортировка зовёт effectiveDue (Intl) на каждое сравнение — пересчитываем только при новых данных или тике часов
  // (проверка 15 окт), а не на каждую перерисовку.
  const open = useMemo(() => deadlines
    .filter((d) => d.status === "open" && effectiveDue(d.due) > now - 7 * DAY)
    .sort((a, b) => effectiveDue(a.due) - effectiveDue(b.due)), [deadlines, now]);
  const [hero] = open;

  // Цвет свечения фона (вариант glow1) — по срочности ближайшего дедлайна.
  const heroUrgency = hero ? urgencyOf(hero, now) : "calm";
  const scheme = useScheme();
  useEffect(() => {
    const dark = scheme === "dark";
    const a = dark ? 0.3 : 0.16;
    const c = heroUrgency === "urgent" || heroUrgency === "overdue" ? `rgb(255 77 61 / ${a})` : heroUrgency === "soon" ? `rgb(245 165 36 / ${a})` : `rgb(47 123 246 / ${a})`;
    document.documentElement.style.setProperty("--bg-glow", c);
  }, [heroUrgency, scheme]);

  // Пары на сегодня из расписания группы (подгруппа — из профиля); прошедшие определяем по московскому времени.
  const schedStatus = useSchedule((s) => s.status);
  const sched = useSchedule((s) => s.data);
  const subgroup = useSchedule((s) => s.subgroup);
  const schedNeedGroup = !!sched?.needGroup || (!!sched && !sched.group);
  // forDay читает стор сам; зависимости — то, от чего зависит ответ (расписание, подгруппа, день).
  const lessons = useMemo(() => useSchedule.getState().forDay(today), [sched, subgroup, today]);
  // Сегодня пар нет — подсказываем ближайшую (до двух недель вперёд), а не пустую строку (18 окт 2026).
  const nextLesson = useMemo(() => {
    if (lessons.length) return null;
    for (let i = 1; i <= 14; i++) {
      const key = dayKey(Date.now() + i * DAY);
      const l = useSchedule.getState().forDay(key)[0];
      if (l) {
        const wd = new Date(keyToUtc(key)).toLocaleDateString("ru-RU", { weekday: "long", timeZone: "UTC" });
        const on: Record<string, string> = { "понедельник": "в понедельник", "вторник": "во вторник", "среда": "в среду", "четверг": "в четверг", "пятница": "в пятницу", "суббота": "в субботу", "воскресенье": "в воскресенье" };
        return `${i === 1 ? "завтра" : on[wd] ?? wd}, ${l.start}`;
      }
    }
    return null;
  }, [sched, subgroup, today, lessons.length]);
  const nowP = mskParts(now);
  const nowHM = `${String(nowP.hh).padStart(2, "0")}:${String(nowP.mm).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-3">
      <m.header
        className="flex min-h-12 items-center justify-between gap-3 px-1"
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      >
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold tracking-[-0.02em]">{formatLongDate(today)}</h1>
          {moodle.status !== "idle" && (
            <p className={`truncate text-[12px] font-semibold ${moodle.status === "error" || moodle.down ? "text-yellow" : "text-hint"}`}>
              {moodle.status === "loading" ? "Moodle · обновляю…"
                : moodle.down ? "Moodle · не отвечает" // подробности — в плашке ниже
                // Время чтения данных сервером; не сегодня — с датой (копия с диска после перезапуска бывает вчерашней).
                : moodle.status === "ok" && moodle.at ? `Moodle · обновлено ${when(moodle.at)}`
                : `Moodle: ${moodle.error}`}
            </p>
          )}
        </div>
        <button onClick={() => push({ name: "profile" })} className="flex shrink-0 items-center gap-2" aria-label="Профиль">
          <span className="text-s font-semibold text-hint">{user.firstName}</span>
          <Avatar name={user.firstName} photoUrl={user.photoUrl} size={32} />
        </button>
      </m.header>

      {status === "loading" ? (
        <HomeSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {/* Moodle не отвечает (сбой у МИСИС): плашка первой, под ней — прежние данные. */}
          <MoodleDown index={0} />
          {/* Первая загрузка из Moodle ещё идёт или не удалась — не «Все сроки закрыты» (проверка 15 окт). При сбое
              самого Moodle причину уже объясняет плашка выше. */}
          {hero ? (
            <HeroDeadlineCard deadline={hero} subject={subjectOf(subjects, hero.subjectId)} now={now}
              onOpen={() => push({ name: "deadline", id: hero.id })} />
          ) : pending ? (
            <Skeleton className="col-span-2 h-44 rounded-[22px]" />
          ) : failed ? (
            !moodle.down && <MoodleFailed index={0} />
          ) : (
            <Tile span={2} index={0}>
              <EmptyState icon={Flag} title="Дедлайнов нет" text="Все сроки закрыты. Добавьте новый, когда появится."
                action="Добавить дедлайн" onAction={() => push({ name: "deadline-form" })} />
            </Tile>
          )}

          {/* Отчёты с агентом: прогресс и что от студента нужно; нажатие — в чат лабы. */}
          <ActiveLabs index={1} />

          {/* Курс прошлого семестра с новой работой сам в дедлайны не попадает — просим уточнить (ответ — на экране «Курсы»). */}
          {pendingCourses.length > 0 && (
            <Tile span={2} index={1} onClick={() => { haptic.tap(); push({ name: "courses" }); }} className="!min-h-0 py-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-yellow/15 text-yellow"><CircleHelp size={18} strokeWidth={2.5} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-m font-bold">Это ваш курс сейчас?</span>
                  <span className="line-clamp-2 block text-s text-hint">
                    {pendingCourses[0].name} ({pendingCourses[0].reason}): появилась работа «{pendingCourses[0].title}»{pendingCourses[0].section ? `, раздел «${pendingCourses[0].section}»` : ""}
                    {pendingCourses.length > 1 ? ` и ещё ${pendingCourses.length - 1}` : ""}
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-hint" />
              </div>
            </Tile>
          )}

          {/* Пары на сегодня — сразу под ближайшим дедлайном; прошедшие приглушены. Нажатие ведёт в план. */}
          {/* Каждая пара — кнопка (экран курса), поэтому сама плитка не кнопка; в план ведёт ссылка в заголовке. */}
          <Tile span={2} index={1} className="min-h-0 pb-2">
            <div className="flex items-center justify-between gap-2">
              <TileTitle className="flex items-center gap-1.5">Расписание на сегодня{lessons.length > 0 && <span className="text-hint">{lessons.length}</span>}</TileTitle>
              <button onClick={() => { haptic.select(); setTab("plan"); }} className="-my-1 -mr-1 flex min-h-8 items-center gap-0.5 px-1 text-s font-bold text-accent">Весь план<ChevronRight size={14} strokeWidth={2.5} /></button>
            </div>
            {lessons.length > 0 ? (
              <div className="mt-1">
                {lessons.map((l, i) => (
                  <div key={i} className="border-t border-separator first:border-t-0">
                    <LessonRow lesson={l} subject={matchSubject(subjects, l.name)} past={l.end <= nowHM}
                      onOpen={() => { haptic.tap(); push({ name: "course", title: l.name, subjectId: matchSubject(subjects, l.name)?.id, lesson: l }); }} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 pb-1 text-s font-semibold text-hint">
                {/* Сервер не отдал профиль — расписание и не начнёт грузиться: «Загружаю…» висело бы вечно (проверка 15 окт). */}
                {schedNeedGroup ? "Выберите группу в профиле — и здесь появятся пары"
                  : schedStatus === "error" || (schedStatus === "idle" && authErr) ? "Расписание недоступно"
                  : schedStatus === "loading" || schedStatus === "idle" ? "Загружаю расписание…" : "Сегодня пар нет"}
                {schedStatus === "ok" && !schedNeedGroup && nextLesson && <span className="block font-medium">Ближайшая — {nextLesson}</span>}
              </p>
            )}
          </Tile>

          {/* Электронный журнал: средние посещаемость и рейтинг за семестр, пропуски (на месте прежних заметок). */}
          <JournalTile index={2} />

          {/* Сессия: через сколько дней и её даты по учебному плану, формы контроля семестра, долги; нажатие — экран «Сессия». */}
          <SessionTile index={3} />

          {homeScreen === "missed" && (
            <Tile span={2} index={5} onClick={() => { haptic.tap(); addToHomeScreen(); setHomeScreen("unknown"); }} className="!min-h-0 py-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><Smartphone size={18} strokeWidth={2.5} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-m font-bold">Добавить на экран телефона</span>
                  <span className="block text-s text-hint">Открывать Doodle одним нажатием, как приложение</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-hint" />
              </div>
            </Tile>
          )}

        </div>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5" aria-label="Загрузка">
      <Skeleton className="col-span-2 h-40 rounded-[22px]" />
      <Skeleton className="col-span-2 h-36 rounded-[22px]" />
      <Skeleton className="col-span-2 h-48 rounded-[22px]" />
    </div>
  );
}
