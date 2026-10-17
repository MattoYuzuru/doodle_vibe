import { lite } from "./lib/perf";
import { AnimatePresence, MotionConfig, m, useDragControls, useMotionValue, useTransform } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { Component, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Fab } from "./components/Fab";
import { RefreshIndicator } from "./components/RefreshIndicator";
import { TABBAR_H, TABS, TabBar } from "./components/TabBar";
import { Toast } from "./components/Toast";
import { useNav, type Screen, type Tab } from "./hooks/useNav";
import { pullY, usePullToRefresh } from "./hooks/usePullToRefresh";
import { lensDrag, lensProgress } from "./hooks/useTabLens";
import { useBackButton } from "./hooks/useTelegramButtons";
import { useCompactOnScroll, useUi } from "./hooks/useUi";
import { DeadlinesScreen } from "./screens/Deadlines";
import { HomeScreen } from "./screens/Home";
import { JournalScreen } from "./screens/Journal";
import { LoginScreen } from "./screens/Login";
import { PlanScreen } from "./screens/Plan";
import { TaskFormScreen } from "./screens/TaskForm";
import { useAuth } from "./store/auth";
import { useAppStore } from "./store/useAppStore";
import { haptic, inTelegram } from "./telegram/webapp";
import { spring } from "./theme/motion";

// Экраны поверх вкладок — отдельными частями сборки: запуск легче, а после первой отрисовки они догружаются в фоне,
// так что открываются без задержки.
const loadDeadlineDetails = () => import("./screens/DeadlineDetails");
const loadDeadlineForm = () => import("./screens/DeadlineForm");
const loadLab = () => import("./screens/Lab");
const loadProfile = () => import("./screens/Profile");
const loadAccess = () => import("./screens/Access");
const loadEnv = () => import("./screens/EnvRequests");
const loadCalendar = () => import("./screens/Calendar");
const loadUsage = () => import("./screens/Usage");
const loadCheck = () => import("./screens/Check");
const loadCourse = () => import("./screens/Course");
const loadCourses = () => import("./screens/Courses");
const loadTeachers = () => import("./screens/Teachers");
const DeadlineDetailsScreen = lazy(() => loadDeadlineDetails().then((mod) => ({ default: mod.DeadlineDetailsScreen })));
const DeadlineFormScreen = lazy(() => loadDeadlineForm().then((mod) => ({ default: mod.DeadlineFormScreen })));
const LabScreen = lazy(() => loadLab().then((mod) => ({ default: mod.LabScreen })));
const ProfileScreen = lazy(() => loadProfile().then((mod) => ({ default: mod.ProfileScreen })));
const AccessScreen = lazy(() => loadAccess().then((mod) => ({ default: mod.AccessScreen })));
const EnvScreen = lazy(() => loadEnv().then((mod) => ({ default: mod.EnvRequestsScreen })));
const CalendarScreen = lazy(() => loadCalendar().then((mod) => ({ default: mod.CalendarScreen })));
const UsageScreen = lazy(() => loadUsage().then((mod) => ({ default: mod.UsageScreen })));
const CheckScreen = lazy(() => loadCheck().then((mod) => ({ default: mod.CheckScreen })));
const CourseScreen = lazy(() => loadCourse().then((mod) => ({ default: mod.CourseScreen })));
const CoursesScreen = lazy(() => loadCourses().then((mod) => ({ default: mod.CoursesScreen })));
const TeachersScreen = lazy(() => loadTeachers().then((mod) => ({ default: mod.TeachersScreen })));
export const preloadScreens = () => { for (const f of [loadDeadlineDetails, loadDeadlineForm, loadLab, loadProfile, loadAccess, loadEnv, loadCalendar, loadUsage, loadCheck, loadCourse, loadCourses, loadTeachers]) void f().catch(() => {}); };

const TAB_SCREENS: Record<Tab, () => React.ReactNode> = {
  home: () => <HomeScreen />,
  deadlines: () => <DeadlinesScreen />,
  plan: () => <PlanScreen />,
  journal: () => <JournalScreen />,
};

function renderScreen(screen: Screen) {
  switch (screen.name) {
    case "task-form": return <TaskFormScreen id={screen.id} date={screen.date} />;
    case "deadline": return <DeadlineDetailsScreen id={screen.id} />;
    case "lab": return <LabScreen id={screen.id} />;
    case "check": return <CheckScreen id={screen.id} />;
    case "profile": return <ProfileScreen />;
    case "teachers": return <TeachersScreen />;
    case "access": return <AccessScreen />;
    case "env": return <EnvScreen />;
    case "calendar": return <CalendarScreen />;
    case "usage": return <UsageScreen />;
    case "courses": return <CoursesScreen />;
    case "course": return <CourseScreen title={screen.title} subjectId={screen.subjectId} lesson={screen.lesson} />;
    case "deadline-form": return <DeadlineFormScreen id={screen.id} />;
  }
}

/**
 * Предохранитель вложенного экрана: ошибка рендера одного экрана показывает её текст и кнопку «Назад»,
 * а не гасит всё приложение (без него React размонтирует дерево целиком — пустое окно).
 */
class ScreenBoundary extends Component<{ children: React.ReactNode; onBack: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col gap-3 px-1 pt-6">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Экран не открылся</h1>
        <p className="text-m text-hint">Ошибка в приложении, данные не пострадали. Попробуйте ещё раз, а если повторится — сообщите, что было нажато.</p>
        <pre className="whitespace-pre-wrap rounded-2xl bg-raised p-3 font-mono text-[12px] leading-[16px] text-red">{String(this.state.error.message || this.state.error)}</pre>
        <button onClick={this.props.onBack} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent">Назад</button>
      </div>
    );
  }
}

/** Зона у боковых краёв экрана (px), откуда начинаются горизонтальные жесты: закрыть экран, листнуть вкладку. */
const EDGE_PX = 36;
/** Скорость (px/с), с которой смахивание закрывает экран; медленнее — экран возвращается. */
const CLOSE_VELOCITY = 800;

const stackVariants = {
  enter: { x: "100%" },
  center: { x: 0 },
  exit: (dir: number) => ({ x: `${dir * 100}%` }),
};

/**
 * Вложенный экран поверх вкладки. Закрывается системной «Назад» в Telegram (вне его — своей стрелкой)
 * и смахиванием пальцем вправо или влево: экран едет за пальцем, фон под ним светлеет, при отпускании
 * уезжает в сторону смахивания.
 */
function StackScreen({ screen }: { screen: Screen }) {
  const pop = useNav((s) => s.pop);
  const x = useMotionValue(0);
  const scrim = useTransform(x, [-300, 0, 300], [0, 1, 0]);
  // Направление ухода экрана хранится в useUi: AnimatePresence читает его как custom при размонтировании.
  const close = (dir: 1 | -1) => { useUi.setState({ exitDir: dir }); haptic.tap(); pop(); };
  useBackButton(() => close(1));
  // Смахивание начинается только у бокового края экрана и закрывает экран только резким движением;
  // медленный свайп возвращает экран на место.
  const dragControls = useDragControls();

  return (
    <>
      <m.div className="fixed inset-0 z-40 bg-page" style={{ opacity: scrim }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <m.div
        className="fixed inset-0 z-40 overflow-y-auto bg-page px-4"
        style={{ x, paddingTop: "calc(8px + var(--safe-top))", paddingBottom: "calc(24px + var(--safe-bottom))" }}
        variants={stackVariants}
        initial="enter" animate="center" exit="exit"
        transition={spring(420, 40)}
        drag="x"
        dragListener={false}
        dragControls={dragControls}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.9}
        onPointerDown={(e) => { if (e.clientX <= EDGE_PX || e.clientX >= window.innerWidth - EDGE_PX) dragControls.start(e); }}
        onDragEnd={(_, info) => {
          if (Math.abs(info.velocity.x) > CLOSE_VELOCITY && Math.abs(info.offset.x) > 24) close(info.velocity.x >= 0 ? 1 : -1);
        }}
      >
        {!inTelegram && (
          <button onClick={() => close(1)} className="-ml-2 flex min-h-11 items-center gap-1 pr-3 text-m text-accent">
            <ChevronLeft size={22} /> Назад
          </button>
        )}
        <ScreenBoundary onBack={() => close(1)}><Suspense fallback={null}>{renderScreen(screen)}</Suspense></ScreenBoundary>
      </m.div>
    </>
  );
}

/**
 * Свой горизонтальный жест под пальцем: "scroll" — ряд с прокруткой вбок или поле ввода (уступаем всегда, даже у края
 * экрана: ряд фильтров тянется до краёв, и касание у края раньше перехватывалось листанием вкладок — ряд «подвисал»);
 * "own" — data-own-swipe (панель дня в «Плане»: от края листаем вкладки); null — своего жеста нет.
 */
function horizontalGestureOf(target: Element, root: Element): "scroll" | "own" | null {
  let own = false;
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLElement) {
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return "scroll";
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return "scroll";
      if (el.dataset.ownSwipe !== undefined) own = true;
    }
  }
  return own ? "own" : null;
}

/**
 * Лента вкладок: все четыре экрана лежат рядом по горизонтали и едут синхронно с линзой на панели
 * (lensProgress), поэтому при удержании ползунка страницы листаются под пальцем.
 * «Потянуть вниз» тянет всю ленту за пальцем и запускает обновление.
 */
function TabTrack() {
  const { tab, stack } = useNav();
  const dragging = useUi((s) => s.dragging);
  const refresh = useAppStore((s) => s.refresh);
  usePullToRefresh(refresh, stack.length === 0 && !dragging);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = useTransform(lensProgress, (p) => -p * width);

  // Свайп по экрану листает вкладки — в обе стороны из любого места, удобно большим пальцем одной рукой: линза и
  // лента идут за пальцем (через lensDrag), вкладка меняется при пересечении середины. На отпускании хватает
  // протянуть на 10% ширины экрана или совсем лёгкого взмаха в ту же сторону — иначе вкладка возвращается.
  // Внутри экрана жест уступает элементам со своим горизонтальным свайпом (data-own-swipe: панель
  // дня в «Плане»), рядам с прокруткой вбок и полям ввода; от бокового края — листает всегда. Мышью (Telegram на ПК)
  // — только от края, чтобы не мешать выделению текста. Слушаем на всём окне: пустое место под коротким содержимым
  // вкладки (зона большого пальца) — тоже часть ленты.
  const setTab = useNav((s) => s.setTab);
  const swipe = useRef<{ x0: number; y0: number; from: number; p: number; moved: boolean; edge: boolean; lastX: number; lastT: number; vx: number } | null>(null);
  useEffect(() => {
    const track = ref.current;
    if (!track || !width) return;
    const onTrack = (t: EventTarget | null) =>
      t instanceof Element && (track.contains(t) || t === document.body || t === document.documentElement || t.id === "root" || t.tagName === "MAIN");
    const down = (e: PointerEvent) => {
      if (useNav.getState().stack.length || !e.isPrimary || !onTrack(e.target)) return;
      const edge = e.clientX <= EDGE_PX || e.clientX >= window.innerWidth - EDGE_PX;
      const gesture = horizontalGestureOf(e.target as Element, track);
      if (gesture === "scroll" || (!edge && (e.pointerType === "mouse" || gesture))) return;
      const from = TABS.findIndex((t) => t.id === useNav.getState().tab);
      swipe.current = { x0: e.clientX, y0: e.clientY, from, p: from, moved: false, edge, lastX: e.clientX, lastT: performance.now(), vx: 0 };
    };
    const move = (e: PointerEvent) => {
      const s = swipe.current;
      if (!s) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.moved) {
        if (Math.abs(dx) < (s.edge ? 5 : 6)) { if (Math.abs(dy) > 10) swipe.current = null; return; }
        // Вертикальный (или косой) жест — это прокрутка; внутри экрана требуем явно горизонтальное движение.
        if (Math.abs(dy) * (s.edge ? 1 : 1.1) > Math.abs(dx)) { swipe.current = null; return; }
        s.moved = true;
        useUi.setState({ dragging: true });
        track.setPointerCapture(e.pointerId);
      }
      const now = performance.now();
      if (now > s.lastT) s.vx = (e.clientX - s.lastX) / (now - s.lastT); // px/мс
      s.lastX = e.clientX; s.lastT = now;
      s.p = Math.min(Math.max(s.from - dx / width, 0), TABS.length - 1);
      lensDrag.jump(s.p);
      const under = TABS[Math.round(s.p)].id;
      if (under !== useNav.getState().tab) { haptic.select(); setTab(under); }
    };
    const up = () => {
      const s = swipe.current;
      swipe.current = null;
      if (!s?.moved) return;
      const delta = s.p - s.from, dir = Math.sign(delta);
      const flick = Math.abs(s.vx) > 0.12 && Math.sign(-s.vx) === dir;
      const target = Math.abs(delta) > 0.1 || flick ? s.from + dir * Math.max(1, Math.round(Math.abs(delta))) : s.from;
      useUi.setState({ dragging: false });
      const next = TABS[Math.min(Math.max(target, 0), TABS.length - 1)].id;
      // Вибро — один самый слабый щелчок на смену вкладки (толчок в начале свайпа убран по просьбе владельца).
      if (next !== useNav.getState().tab) haptic.select();
      setTab(next);
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [width, setTab]);

  // Чтобы при переключении ничего не прыгало, соседние (неактивные) страницы выравниваем по видимой области:
  // при захвате ползунка они получают смещение на текущую прокрутку, а в момент смены вкладки (тапом или
  // перетаскиванием) прокрутка мгновенно сбрасывается в 0, уходящая страница остаётся на месте за счёт
  // отрицательного смещения. После завершения перехода смещения снимаются.
  const [tops, setTops] = useState<Partial<Record<Tab, number>>>({});
  const prevTab = useRef(tab);
  useLayoutEffect(() => {
    if (!dragging) return;
    const s = window.scrollY;
    setTops(Object.fromEntries(TABS.map((t) => [t.id, s])));
  }, [dragging]);
  useLayoutEffect(() => {
    const prev = prevTab.current;
    prevTab.current = tab;
    if (prev === tab) return;
    const s = window.scrollY;
    window.scrollTo(0, 0);
    setTops(Object.fromEntries(TABS.map((t) => [t.id, t.id === prev ? -s : 0])));
  }, [tab]);
  useEffect(() => {
    if (dragging) return;
    const t = setTimeout(() => setTops({}), 700);
    return () => clearTimeout(t);
  }, [dragging, tab]);

  // Лента занимает всю ширину (с полями main), чтобы соседние экраны обрезались по краю экрана, а не по контенту.
  return (
    <div ref={ref} className="relative -mx-4 overflow-x-hidden" style={{ touchAction: "pan-y" }}>
      <m.div className="relative" style={{ x, y: pullY }}>
        {TABS.map(({ id }, i) => {
          const active = id === tab;
          const top = tops[id] ?? 0;
          return (
            <div
              key={id}
              data-tab-page=""
              aria-hidden={!active}
              className={`px-4 ${active ? "relative" : "absolute w-full overflow-hidden"}`}
              style={active ? { left: `${i * 100}%` } : { left: `${i * 100}%`, top, maxHeight: `calc(100vh + ${Math.max(-top, 0)}px)` }}
            >
              {TAB_SCREENS[id]()}
            </div>
          );
        })}
      </m.div>
    </div>
  );
}

export function App() {
  const init = useAppStore((s) => s.init);
  const stack = useNav((s) => s.stack);
  const exitDir = useUi((s) => s.exitDir);
  const { profile, status: authStatus } = useAuth();
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { const t = setTimeout(preloadScreens, 2500); return () => clearTimeout(t); }, []);
  useCompactOnScroll();
  // Кнопка «В Джарвисе» под уведомлением бота открывает приложение с ?open=<id дедлайна>: как только этот дедлайн
  // появился в сторе (из кэша или после синхронизации с Moodle), показываем его карточку — один раз.
  const deadlines = useAppStore((s) => s.deadlines);
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    const id = new URLSearchParams(location.search).get("open");
    if (!id) return;
    if (id === "access") { openedRef.current = true; useNav.getState().push({ name: "access" }); return; } // из уведомления о запросе доступа
    if (id === "env") { openedRef.current = true; useNav.getState().push({ name: "env" }); return; } // из запроса агента окружения на установку
    if (id === "usage") { openedRef.current = true; useNav.getState().push({ name: "usage" }); return; } // из сообщения владельцу о лимите
    if (id === "courses") { openedRef.current = true; useNav.getState().push({ name: "courses" }); return; } // из вопроса бота «это ваш курс?»
    // Кнопка «Открыть лабу» под сообщением бота: сразу чат этой лабы (экрану нужна работа из дедлайнов — ждём её).
    if (id.startsWith("lab:")) {
      const did = `moodle:assign:${id.slice(4)}`;
      if (!deadlines.some((d) => d.id === did)) return;
      openedRef.current = true;
      useNav.getState().push({ name: "lab", id: did });
      return;
    }
    // Кнопка «Открыть замечания» под сообщением бота о проверке своего отчёта.
    if (id.startsWith("check:")) {
      const did = `moodle:assign:${id.slice(6)}`;
      if (!deadlines.some((d) => d.id === did)) return;
      openedRef.current = true;
      useNav.getState().push({ name: "check", id: did });
      return;
    }
    if (!deadlines.some((d) => d.id === id)) return;
    openedRef.current = true;
    useNav.getState().push({ name: "deadline", id });
  }, [deadlines]);
  const top = stack[stack.length - 1];

  // Профиль ещё не получен — ничего не решаем (скелетоны нарисует Главная); нет входа в Moodle — экран входа вместо вкладок.
  const needLogin = authStatus === "ready" && profile !== null && !profile.loggedIn;
  if (needLogin) {
    return (
      <MotionConfig reducedMotion={lite ? "always" : "user"}>
        <main className="mx-auto max-w-[480px] px-4" style={{ paddingTop: "calc(8px + var(--safe-top))", paddingBottom: "calc(24px + var(--safe-bottom))" }}>
          <LoginScreen />
        </main>
        <Toast />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={lite ? "always" : "user"}>
      <main
        className="mx-auto max-w-[480px] overflow-x-hidden px-4"
        style={{ paddingTop: "calc(8px + var(--safe-top))", paddingBottom: `calc(${TABBAR_H + 96}px + var(--safe-bottom))` }}
      >
        <TabTrack />
      </main>
      <RefreshIndicator />
      <Fab />
      <TabBar />
      <Toast />
      <AnimatePresence custom={exitDir}>{top && <StackScreen key={stack.length} screen={top} />}</AnimatePresence>
    </MotionConfig>
  );
}
