import { lite } from "./lib/perf";
import { AnimatePresence, MotionConfig, m, useDragControls, useIsPresent, useMotionValue, useTransform } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { Component, Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { OwlAssistant } from "./components/OwlAssistant";
import { RefreshIndicator } from "./components/RefreshIndicator";
import { TABBAR_H, TABS, TabBar } from "./components/TabBar";
import { Toast } from "./components/Toast";
import { Skeleton } from "./components/ui";
import { useNav, type Screen, type Tab } from "./hooks/useNav";
import { pullY, usePullToRefresh } from "./hooks/usePullToRefresh";
import { ScreenActiveContext, ScreenDepthContext } from "./hooks/useScreenActive";
import { lensDrag, lensProgress } from "./hooks/useTabLens";
import { useBackButton } from "./hooks/useTelegramButtons";
import { useCompactOnScroll, useKeyboardFlag, useUi } from "./hooks/useUi";
import { EDGE_PX, SWIPE_SLOP } from "./lib/edge";
import { DeadlinesScreen } from "./screens/Deadlines";
import { HomeScreen } from "./screens/Home";
import { JournalScreen } from "./screens/Journal";
import { LoginScreen } from "./screens/Login";
import { Onboarding, tourFromLink, tourUnseen } from "./components/Onboarding";
import { PlanScreen } from "./screens/Plan";
import { TaskFormScreen } from "./screens/TaskForm";
import { useAuth } from "./store/auth";
import { useAppStore } from "./store/useAppStore";
import { haptic, inTelegram } from "./telegram/webapp";
import { spring } from "./theme/motion";

// Нажатие плиток и кнопок — CSS :active (Tile, HeroDeadlineCard, Fab). В WebKit (iPhone) :active включается, только если
// у элемента или предка есть слушатель touchstart; единственный свой (usePullToRefresh) на window, поэтому — постоянный
// пустой пассивный слушатель на document (проверка 15 окт).
document.addEventListener("touchstart", () => {}, { passive: true });

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

/**
 * Страница вкладки в memo (проверка 15 окт): пропсов у экранов нет, так что перерисовки ленты (свайп, смена вкладки,
 * «потянуть вниз», открытие экрана поверх) до самих экранов больше не доходят — только их собственные подписки.
 */
const TabPage = memo(function TabPage({ id }: { id: Tab }) {
  return TAB_SCREENS[id]();
});

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
 * Не догрузилась часть сборки с экраном (метро, ноутбук-сервер уснул). React.lazy запоминает неудачу, а браузер кэширует
 * неудачный import() того же адреса — «попробуйте ещё раз» не помогало и после восстановления связи (проверка 15 окт).
 * Помогает только перезагрузка; initData Telegram лежит в hash и при ней сохраняется.
 */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically|Unable to preload CSS/i;

/**
 * Предохранитель вложенного экрана: ошибка рендера одного экрана показывает её текст и кнопку «Назад»,
 * а не гасит всё приложение (без него React размонтирует дерево целиком — пустое окно).
 */
class ScreenBoundary extends Component<{ children: React.ReactNode; onBack: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    const message = String(this.state.error.message || this.state.error);
    if (CHUNK_ERROR.test(message)) {
      return (
        <div className="flex flex-col gap-3 px-1 pt-6">
          <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Экран не загрузился</h1>
          <p className="text-m text-hint">Не удалось загрузить экран — нет связи с сервером. Когда интернет появится, нажмите «Обновить»: приложение перезапустится, данные не пострадают.</p>
          <button onClick={() => location.reload()} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent">Обновить</button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3 px-1 pt-6">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Экран не открылся</h1>
        <p className="text-m text-hint">Ошибка в приложении, данные не пострадали. Попробуйте ещё раз, а если повторится — сообщите, что было нажато.</p>
        <pre className="whitespace-pre-wrap rounded-2xl bg-raised p-3 font-mono text-[12px] leading-[16px] text-red">{message}</pre>
        <button onClick={this.props.onBack} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent">Назад</button>
      </div>
    );
  }
}

/** Пока догружается часть сборки с экраном — простой скелетон, а не пустой выехавший экран (проверка 15 окт). */
function ScreenSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 pt-2">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-36" />
      <Skeleton className="h-24" />
    </div>
  );
}

/** Скорость (px/с), с которой смахивание закрывает экран; медленнее — экран возвращается. */
const CLOSE_VELOCITY = 800;

const stackVariants = {
  enter: { x: "100%" },
  center: { x: 0 },
  // Экран, накрытый следующим, отъезжает влево (как в iOS) и остаётся смонтированным: при «Назад» он не въезжает
  // заново, а возвращается с той же прокруткой, раскрытыми блоками и загруженными данными (проверка 15 окт).
  under: { x: "-30%" },
  exit: (dir: number) => ({ x: `${dir * 100}%` }),
};

/** Системная «Назад» Telegram для экрана стека — внутри его контекстов (глубина, активность), см. useTelegramButtons. */
function StackBack({ onBack }: { onBack: () => void }) {
  useBackButton(onBack);
  return null;
}

/**
 * Вложенный экран поверх вкладки. Закрывается системной «Назад» в Telegram (вне его — своей стрелкой)
 * и смахиванием пальцем вправо или влево: экран едет за пальцем, фон под ним светлеет, при отпускании
 * уезжает в сторону смахивания.
 *
 * В DOM весь стек (проверка 15 окт): нижние экраны лежат под верхним (inert, без нажатий), фон-подложка — только
 * у первого. Активен (ScreenActiveContext) только верхний и только пока не уезжает: опросы на остальных стоят,
 * кнопки Telegram они не держат, а уезжающий экран не принимает нажатий.
 */
function StackScreen({ screen, index, top }: { screen: Screen; index: number; top: boolean }) {
  const pop = useNav((s) => s.pop);
  const present = useIsPresent();
  const active = top && present;
  const x = useMotionValue(0);
  // Пока экран въезжает, уезжает или лежит под другим, x — строка в процентах. Под краем (±100 %, последний кадр ухода)
  // подложка прозрачна: иначе на кадр-два до размонтирования вкладка мигала пустым фоном; внутри экрана — непрозрачна.
  const scrim = useTransform(x, (v) => (typeof v === "number" ? 1 - Math.min(Math.abs(v) / 300, 1) : Math.abs(parseFloat(v)) >= 100 ? 0 : 1));
  // Направление ухода экрана хранится в useUi: AnimatePresence читает его как custom при размонтировании.
  // Неактивный экран не закрывается: второй «Назад» во время ухода закрыл бы ещё и экран под ним.
  const close = (dir: 1 | -1) => { if (!active) return; useUi.setState({ exitDir: dir }); haptic.tap(); pop(); };
  // Смахивание начинается только у бокового края экрана и закрывает экран только резким движением;
  // медленный свайп возвращает экран на место.
  const dragControls = useDragControls();

  // Прокрутка остаётся внутри экрана (проверка 15 окт): overscroll-contain, а содержимое всегда хоть на 1 px выше
  // экрана — иначе короткий экран вообще не скроллер, и Chrome отдаёт жест окну. touch-action: pan-y — свой: внутри
  // скроллера Chromium заново разрешает панорамирование, и смахивание от края обрывалось на ~10 px (pointercancel).
  // overflow-x-hidden — длинная ссылка или имя файла не дают сдвигать экран вбок.
  return (
    <>
      {index === 0 && <m.div className="fixed inset-0 z-40 bg-page" style={{ opacity: scrim }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
      <m.div
        className="stack-screen fixed inset-0 z-40 overflow-x-hidden overflow-y-auto overscroll-contain bg-page px-4"
        style={{
          x, touchAction: "pan-y", pointerEvents: present ? undefined : "none",
          paddingTop: "calc(8px + var(--safe-top))", paddingBottom: "calc(24px + var(--safe-bottom))",
        }}
        variants={stackVariants}
        initial="enter" animate={top ? "center" : "under"} exit="exit"
        transition={spring(420, 40)}
        drag="x"
        dragListener={false}
        dragControls={dragControls}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.9}
        dragMomentum={false}
        onPointerDown={(e) => { if (active && (e.clientX <= EDGE_PX || e.clientX >= window.innerWidth - EDGE_PX)) dragControls.start(e); }}
        onDragEnd={(e, info) => {
          // pointercancel — браузер забрал жест под прокрутку: это не смахивание, экран просто возвращается на место.
          if (e.type === "pointercancel") return;
          if (Math.abs(info.velocity.x) > CLOSE_VELOCITY && Math.abs(info.offset.x) > 24) close(info.velocity.x >= 0 ? 1 : -1);
        }}
      >
        {/* inert и без нажатий — на внутренней обёртке: m.div может отфильтровать атрибут inert. */}
        <div inert={!top} className={`flex min-h-[calc(100%+1px)] flex-col ${top ? "" : "pointer-events-none"}`}>
          <ScreenActiveContext.Provider value={active}>
            <ScreenDepthContext.Provider value={index + 1}>
              <StackBack onBack={() => close(1)} />
              {!inTelegram && (
                <button onClick={() => close(1)} className="-ml-2 flex min-h-11 items-center gap-1 pr-3 text-m text-accent">
                  <ChevronLeft size={22} /> Назад
                </button>
              )}
              <ScreenBoundary onBack={() => close(1)}><Suspense fallback={<ScreenSkeleton />}>{renderScreen(screen)}</Suspense></ScreenBoundary>
            </ScreenDepthContext.Provider>
          </ScreenActiveContext.Provider>
        </div>
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
 * Высота неактивной страницы ленты (проверка 15 окт): не больше экрана (плюс уехавшая вверх часть) и не ниже низа
 * активной. Лента больше не скроллер и по высоте не обрезает, и длинная соседняя вкладка иначе удлиняла бы документ —
 * короткую вкладку можно было бы листать в пустоту. Проценты — от высоты ленты, а она равна высоте активной страницы.
 */
const pageMaxHeight = (top: number) =>
  `min(calc(100vh + ${Math.max(-top, 0)}px), calc(100% ${top < 0 ? "+" : "-"} ${Math.abs(top)}px))`;

/**
 * Лента вкладок: все четыре экрана лежат рядом по горизонтали и едут синхронно с линзой на панели
 * (lensProgress), поэтому при удержании ползунка страницы листаются под пальцем.
 * «Потянуть вниз» тянет всю ленту за пальцем и запускает обновление.
 */
const TabTrack = memo(function TabTrack() {
  // Только нужные поля (проверка 15 окт): подписка на весь useNav перерисовывала ленту на каждый push/pop.
  const tab = useNav((s) => s.tab);
  const stackOpen = useNav((s) => s.stack.length > 0);
  const dragging = useUi((s) => s.dragging);
  const refresh = useAppStore((s) => s.refresh);
  usePullToRefresh(refresh, !stackOpen && !dragging);
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
  // лента идут за пальцем (через lensDrag), подсветка иконки на панели — за линзой, а вкладка меняется при отпускании.
  // На отпускании хватает протянуть на 10% ширины экрана или взмахнуть в ту же сторону — иначе вкладка возвращается.
  // Внутри экрана жест уступает элементам со своим горизонтальным свайпом (data-own-swipe: панель
  // дня в «Плане»), рядам с прокруткой вбок и полям ввода; от бокового края — листает всегда. Мышью (Telegram на ПК)
  // — только от края, чтобы не мешать выделению текста. Слушаем на всём окне: пустое место под коротким содержимым
  // вкладки (зона большого пальца) — тоже часть ленты.
  //
  // Проверка 15 окт. Первым решает браузер: после касания ничего не двигаем. Пришёл pointercancel — браузер забрал жест
  // под прокрутку, свайп сброшен без расчёта взмаха и смены вкладки. Палец ушёл на SWIPE_SLOP без отмены и больше вбок —
  // прокрутку браузер отклонил, жест наш. Раньше лента решала на первых 6 px по своему правилу: дугообразный взмах то
  // «умирал» (браузер подавил прокрутку, а лента жест отбросила), то листал вкладку посреди прокрутки. Взмах — только
  // явно горизонтальный: ≥16 px, ≥0,35 px/мс по точкам за последние ~80 мс и |dx| > 1,5·|dy| за весь жест.
  // Вкладка меняется один раз, при отпускании: смена посреди свайпа перерисовывала все вкладки на каждом пересечении
  // середины, а при возврате пальца исходная вкладка открывалась с самого верха.
  const setTab = useNav((s) => s.setTab);
  const swipe = useRef<{
    id: number; x0: number; y0: number; from: number; p: number; under: number; moved: boolean; pts: { x: number; t: number }[];
  } | null>(null);
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
      swipe.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from, p: from, under: from, moved: false, pts: [] };
    };
    const move = (e: PointerEvent) => {
      const s = swipe.current;
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.moved) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return;
        // Вертикальный (или косой) жест — это прокрутка.
        if (Math.abs(dy) >= Math.abs(dx)) { swipe.current = null; return; }
        s.moved = true;
        useUi.setState({ dragging: true });
        track.setPointerCapture(e.pointerId);
      }
      const now = performance.now();
      s.pts.push({ x: e.clientX, t: now });
      while (s.pts.length > 2 && now - s.pts[0].t > 120) s.pts.shift();
      s.p = Math.min(Math.max(s.from - dx / width, 0), TABS.length - 1);
      lensDrag.jump(s.p);
      // Вибро — один самый слабый щелчок на пересечение середины (толчок в начале свайпа убран по просьбе владельца).
      const under = Math.round(s.p);
      if (under !== s.under) { s.under = under; haptic.select(); }
    };
    const up = (e: PointerEvent) => {
      const s = swipe.current;
      if (!s || e.pointerId !== s.id) return;
      swipe.current = null;
      if (!s.moved) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      s.pts.push({ x: e.clientX, t: performance.now() });
      const last = s.pts[s.pts.length - 1];
      const first = s.pts.find((q) => last.t - q.t <= 80) ?? last;
      const vx = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px/мс
      const horizontal = Math.abs(dx) > 1.5 * Math.abs(dy);
      const delta = s.p - s.from, dir = Math.sign(delta);
      const flick = Math.abs(dx) >= 16 && Math.abs(vx) >= 0.35 && Math.sign(-vx) === dir;
      const target = horizontal && dir && (Math.abs(delta) > 0.1 || flick) ? s.from + dir * Math.max(1, Math.round(Math.abs(delta))) : s.from;
      const next = Math.min(Math.max(target, 0), TABS.length - 1);
      useUi.setState({ dragging: false });
      if (next !== s.under) haptic.select();
      if (next !== s.from) setTab(TABS[next].id);
    };
    // Отмена — браузер забрал жест или его прервала система: вкладка не меняется; линзу и ленту пружиной возвращает
    // TabBar, увидев dragging: false.
    const cancel = (e: PointerEvent) => {
      const s = swipe.current;
      if (!s || e.pointerId !== s.id) return;
      swipe.current = null;
      if (s.moved) useUi.setState({ dragging: false });
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
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
  // clip-x (index.css) — обрезка вбок без вертикального скроллера (проверка 15 окт). will-change — лента своим слоем:
  // плитки без размытия больше не держат свои слои, и свайп с «потянуть вниз» иначе перерисовывали бы её.
  return (
    <div ref={ref} className="clip-x relative -mx-4" style={{ touchAction: "pan-y" }}>
      <m.div className="relative" style={{ x, y: pullY, willChange: "transform" }}>
        {TABS.map(({ id }, i) => {
          const active = id === tab;
          const top = tops[id] ?? 0;
          return (
            <div
              key={id}
              data-tab-page=""
              aria-hidden={!active}
              className={`px-4 ${active ? "relative" : "absolute w-full overflow-hidden"}`}
              style={active ? { left: `${i * 100}%` } : { left: `${i * 100}%`, top, maxHeight: pageMaxHeight(top) }}
            >
              <TabPage id={id} />
            </div>
          );
        })}
      </m.div>
    </div>
  );
});

export function App() {
  const init = useAppStore((s) => s.init);
  const stack = useNav((s) => s.stack);
  const exitDir = useUi((s) => s.exitDir);
  // Только сам вывод «нужен вход» (проверка 15 окт): подписка на весь useAuth перерисовывала App на каждый его set.
  const needLogin = useAuth((s) => s.status === "ready" && s.profile !== null && !s.profile.loggedIn);
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { const t = setTimeout(preloadScreens, 2500); return () => clearTimeout(t); }, []);
  useCompactOnScroll();
  useKeyboardFlag();
  // Кнопка «В Джарвисе» под уведомлением бота открывает приложение с ?open=<id дедлайна>: как только этот дедлайн
  // появился в сторе (из кэша или после синхронизации с Moodle), показываем его карточку — один раз.
  // Ждём подпиской на стор, а не через useAppStore((s) => s.deadlines) (проверка 15 окт): иначе App, а с ним лента,
  // панель и все экраны стека, перерисовывался на каждое обновление данных.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    const id = new URLSearchParams(location.search).get("open");
    if (!id) return;
    if (id === "access") { openedRef.current = true; useNav.getState().push({ name: "access" }); return; } // из уведомления о запросе доступа
    if (id === "env") { openedRef.current = true; useNav.getState().push({ name: "env" }); return; } // из запроса агента окружения на установку
    if (id === "usage") { openedRef.current = true; useNav.getState().push({ name: "usage" }); return; } // из сообщения владельцу о лимите
    if (id === "courses") { openedRef.current = true; useNav.getState().push({ name: "courses" }); return; } // из вопроса бота «это ваш курс?»
    // Из сводки бота о сессии и напоминаний об экзаменах: вкладка «Журнал» в виде «Сессия» (стартовое состояние уже такое — см. useNav).
    if (id === "session") { openedRef.current = true; useNav.getState().setJournalView("session"); useNav.getState().setTab("journal"); return; }
    // Кнопка «Открыть лабу» под сообщением бота: сразу чат этой лабы (экрану нужна работа из дедлайнов — ждём её).
    // Кнопка «Открыть замечания» под сообщением бота о проверке своего отчёта. Иначе — карточка дедлайна.
    const did = id.startsWith("lab:") ? `moodle:assign:${id.slice(4)}` : id.startsWith("check:") ? `moodle:assign:${id.slice(6)}` : id;
    const screen: Screen = id.startsWith("lab:") ? { name: "lab", id: did } : id.startsWith("check:") ? { name: "check", id: did } : { name: "deadline", id: did };
    const tryOpen = (deadlines: { id: string }[]) => {
      if (openedRef.current || !deadlines.some((d) => d.id === did)) return false;
      openedRef.current = true;
      useNav.getState().push(screen);
      return true;
    };
    if (tryOpen(useAppStore.getState().deadlines)) return;
    const unsub = useAppStore.subscribe((s) => { if (tryOpen(s.deadlines)) unsub(); });
    return unsub;
  }, []);

  // Открыт экран поверх вкладок — окно под ним не прокручивается (index.css: html.stack-open). Экран входа поверх
  // открытого стека (вход отозван) окно не блокирует: иначе на маленьком телефоне до кнопки «Войти» не долистать.
  const lockWindow = stack.length > 0 && !needLogin;
  useEffect(() => { document.documentElement.classList.toggle("stack-open", lockWindow); }, [lockWindow]);
  // ~350 мс после открытия или закрытия экрана нажатия по экранам стека гасятся (двойной тап «Сохранить» попадал в
  // кнопку экрана под ним). Только щелчки, а не pointer-events: прокрутку сразу после открытия блокировать нельзя —
  // экран «не реагировал» бы на первый взмах (проверка 15 окт).
  const topUid = stack[stack.length - 1]?.uid ?? 0;
  const busyUntil = useRef(0);
  useEffect(() => { busyUntil.current = performance.now() + 350; }, [topUid]);
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (performance.now() < busyUntil.current && (e.target as Element | null)?.closest?.(".stack-screen")) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("click", swallow, true);
    return () => document.removeEventListener("click", swallow, true);
  }, []);

  // Знакомство с приложением: по кнопке «Что умеет Doodle» из чата бота — всегда; само — один раз, до входа в Moodle
  // (тем, кто уже вошёл, оно не нужно).
  const [tour, setTour] = useState<"link" | "auto" | null>(() => (tourFromLink() ? "link" : tourUnseen() ? "auto" : null));

  // Профиль ещё не получен — ничего не решаем (скелетоны нарисует Главная); нет входа в Moodle — экран входа вместо вкладок.
  if (needLogin) {
    return (
      <MotionConfig reducedMotion={lite ? "always" : "user"}>
        <main className="mx-auto max-w-[480px] px-4" style={{ paddingTop: "calc(8px + var(--safe-top))", paddingBottom: "calc(24px + var(--safe-bottom))" }}>
          <LoginScreen />
        </main>
        <Toast />
        <AnimatePresence>{tour && <Onboarding onDone={() => setTour(null)} />}</AnimatePresence>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={lite ? "always" : "user"}>
      <main
        className="clip-x mx-auto max-w-[480px] px-4"
        style={{ paddingTop: "calc(8px + var(--safe-top))", paddingBottom: `calc(${TABBAR_H + 96}px + var(--safe-bottom))` }}
      >
        <TabTrack />
      </main>
      <RefreshIndicator />
      <OwlAssistant />
      <TabBar />
      <Toast />
      <AnimatePresence custom={exitDir}>
        {stack.map((s, i) => <StackScreen key={s.uid} screen={s} index={i} top={i === stack.length - 1} />)}
      </AnimatePresence>
      <AnimatePresence>{tour === "link" && <Onboarding onDone={() => setTour(null)} />}</AnimatePresence>
    </MotionConfig>
  );
}
