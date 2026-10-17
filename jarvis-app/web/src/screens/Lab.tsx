import { AnimatePresence, m, useDragControls } from "framer-motion";
import { ArrowDown, BookOpen, Bot, Check, ExternalLink, FileText, Paperclip, Pencil, RotateCcw, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TeacherRemarks } from "../components/Remarks";
import { RollingNumber } from "../components/RollingNumber";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { LabPulse } from "../components/LabPulse";
import { EmptyState, ProgressBar, Skeleton } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { usePolling } from "../hooks/usePolling";
import { useMainButton } from "../hooks/useTelegramButtons";
import { LABS_OFF_TEXT, labErrorText, labGate, onLabDenied } from "../lib/labGate";
import { assignIdOf, feedbackApi, labApi, type Feedback, type LabJob } from "../store/api";
import { shortName, useAuth } from "../store/auth";
import { subjectOf, useAppStore } from "../store/useAppStore";
import { spring } from "../theme/motion";
import { confirmDialog, haptic, tg } from "../telegram/webapp";
import { fieldClass } from "./TaskForm";

const STATUS: Record<LabJob["status"], { label: string; cls: string }> = {
  idle: { label: "Не начато", cls: "bg-raised text-hint" },
  running: { label: "Агент работает", cls: "bg-accent/15 text-accent" },
  waiting: { label: "Ждёт вас", cls: "bg-yellow/15 text-yellow" },
  report: { label: "Отчёт готов", cls: "bg-green/15 text-green" },
  attached: { label: "Черновик в Moodle", cls: "bg-green/15 text-green" },
  submitted: { label: "Отправлено", cls: "bg-green/15 text-green" },
  error: { label: "Ошибка", cls: "bg-red/15 text-red" },
};
/** На сколько пикселей утянуть поле ввода (или переписку) вниз, чтобы клавиатура спряталась. */
const DISMISS_Y = 64;
const time = (ms: number) => new Date(ms).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
const mb = (n: number) => `${(n / 1048576).toFixed(1)} МБ`;

/** Скроллер переписки — сам экран стека (StackScreen, overflow-y-auto); если класс когда-нибудь сменится — ближайший предок с прокруткой. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  const sc = el?.closest<HTMLElement>(".overflow-y-auto");
  if (sc) return sc;
  for (let p = el?.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}
/** Переписка прокручена до конца (с запасом): новое сообщение можно показать, не отрывая студента от чтения. */
const atEnd = (sc: HTMLElement | null) => !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;

/** Подзаголовки «Кратко о работе» (их порядок задаёт сервер, lab.mjs BRIEF_PROMPT) — в сообщении выделяются жирным. */
const BRIEF_HEADS = new Set(["суть работы", "что сделано", "главные результаты", "вывод", "что могут спросить на защите", "что нужно знать"]);
function BriefText({ text }: { text: string }) {
  return <>{text.split("\n").map((line, i) => (BRIEF_HEADS.has(line.trim().replace(/[:.]$/, "").toLowerCase())
    ? <span key={i} className="block pt-1 font-bold">{line.trim()}</span> : <span key={i} className="block min-h-[10px]">{line}</span>))}</>;
}

/**
 * Лабораторная с агентом: чат с ходом работы и вопросами, карточка готового отчёта,
 * затем два отдельных подтверждения — «Прикрепить черновик» и «Отправить на проверку».
 */
export function LabScreen({ id }: { id: string }) {
  // Селекторы, а не весь стор: каждое обновление стора (синхронизация Moodle) иначе перерисовывало всю переписку.
  const d = useAppStore((s) => s.deadlines.find((x) => x.id === id));
  const subjects = useAppStore((s) => s.subjects);
  const profile = useAuth((s) => s.profile);
  const pop = useNav((s) => s.pop);
  const assignId = assignIdOf(id);
  const [job, setJob] = useState<LabJob | null>(null);
  // Первый ответ сервера уже был: до него статус неизвестен, и экран не должен показывать «Не начато» (проверка 15 окт).
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // То же, что busy, но сразу: кнопка Telegram и Enter вызывают обработчик раньше, чем React перерисует экран.
  const busyRef = useRef(false);
  const [err, setErr] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null); // скрытый выбор файла для скрепки
  const touchY = useRef(0);
  // Перетаскивание запускается вручную и только при открытой клавиатуре (поле в фокусе): с «ручки» над полем и с любого
  // места панели, кроме самого поля (там — курсор и выделение).
  const dragControls = useDragControls();
  const barRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  // Тап по чему угодно, кроме панели ввода, прячет клавиатуру (самый простой способ увидеть всю переписку).
  const tapOutside = (e: React.MouseEvent) => {
    if (document.activeElement === inputRef.current && !barRef.current?.contains(e.target as Node)) { inputRef.current?.blur(); haptic.select(); }
  };

  // Прокрутка переписки (проверка 15 окт): раньше каждое новое сообщение, смена статуса или briefing рывком бросали экран
  // в самый низ, даже когда студент читал историю выше. Теперь вниз — только если он и так был у низа, при первой загрузке
  // и после своего действия из панели ввода; иначе — значок «↓ Новые сообщения».
  // stick — прилипать ли к низу при следующем обновлении; решается до setJob (после рендера scrollHeight уже вырос).
  const stick = useRef(true);
  const seen = useRef(false); // состояние уже показывали: первая загрузка всегда к последнему сообщению
  const [fresh, setFresh] = useState(false); // пришло новое, пока читали выше
  // Прокручиваем сам экран (контейнер), а не scrollIntoView: тот мог сдвинуть и окно со вкладкой под экраном.
  const toEnd = (smooth = false) => { const sc = scrollerOf(rootRef.current); sc?.scrollTo({ top: sc.scrollHeight, behavior: smooth ? "smooth" : "auto" }); };
  // Клавиатура открылась (Android сжимает окно, а scrollTop остаётся прежним) — держим низ переписки, если студент был у низа:
  // иначе вопрос агента, на который он отвечает, уходит под клавиатуру. iPhone окно не сжимает — там это ничего не делает.
  const keepEnd = () => { if (document.activeElement === inputRef.current && stick.current) toEnd(); };
  // Высота поля по тексту: от одной строки до ~6, дальше поле прокручивается само.
  const fitHeight = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };

  // Счётчик запросов (проверка 15 окт): опрос, ушедший раньше отправки, мог вернуться позже ответа на неё и затереть свежее
  // состояние — пропадало только что отправленное сообщение, снова появлялось «Ждёт вас», и студент отправлял дубль.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!assignId) return;
    const my = ++seq.current;
    try {
      const j = await labApi.get(assignId);
      // Устарел (после него ушёл другой запрос или пришёл ответ на действие) или сейчас идёт действие — его ответ и будет свежим.
      if (my !== seq.current || busyRef.current) return;
      stick.current = !seen.current || atEnd(scrollerOf(rootRef.current));
      if (!seen.current) briefAtFirst.current = j.brief?.at;
      seen.current = true;
      setJob(j); setErr(""); setLoaded(true); setDenied(false);
    } catch (e) {
      if (onLabDenied((e as Error).message)) setDenied(true); // отказ по доступу — опрос встаёт до «Повторить» (иначе бил бы в 403 вечно)
      if (my === seq.current && !busyRef.current) setErr(labErrorText((e as Error).message));
    }
  }, [assignId]);
  const [denied, setDenied] = useState(false);
  const retry = () => { haptic.tap(); setErr(""); setDenied(false); void load(); };

  // Опрос: пока агент работает (делает лабу или готовит «Кратко о работе») — каждые 3 с, иначе каждые 15 с.
  usePolling(() => void load(), job?.status === "running" || job?.briefing ? 3000 : 15000, !denied);
  // До отрисовки кадра: при первой загрузке переписка сразу открывается на последнем сообщении, без кадра с её началом.
  // Пока переписки нет («Не начато», только замечания) — экран остаётся сверху.
  const chat = (job?.messages?.length ?? 0) > 0;
  useLayoutEffect(() => {
    if (!chat) return;
    if (stick.current) { toEnd(); setFresh(false); } else setFresh(true);
  }, [job?.messages?.length, job?.status, job?.briefing]);
  // Значок «Новые» висит, пока студент сам не долистал до низа; слушатель прокрутки — только на это время.
  useEffect(() => {
    const sc = fresh ? scrollerOf(rootRef.current) : null;
    if (!sc) return;
    const f = () => { if (atEnd(sc)) setFresh(false); };
    sc.addEventListener("scroll", f, { passive: true });
    return () => sc.removeEventListener("scroll", f);
  }, [fresh]);
  useEffect(() => {
    const vv = window.visualViewport;
    vv?.addEventListener("resize", keepEnd);
    window.addEventListener("resize", keepEnd);
    return () => { vv?.removeEventListener("resize", keepEnd); window.removeEventListener("resize", keepEnd); };
  }, []);
  // Новое «Кратко о работе» — показываем с начала, а не с конца длинного сообщения (этот эффект идёт после прокрутки вниз).
  // Само — только если студент был у низа (иначе он читает выше); по кнопке «Показать» — всегда.
  const briefAt = job?.brief?.at;
  // «Кратко о работе», которое уже было при открытии лабы, — не новое: первая загрузка открывается на последнем
  // сообщении, а не уводит к старому объяснению (проверка 15 окт).
  const briefAtFirst = useRef<number | undefined>(undefined);
  const showBrief = useCallback(() => {
    const el = briefAt ? document.getElementById(`brief-${briefAt}`) : null, sc = scrollerOf(rootRef.current);
    if (!el || !sc) return;
    // Начало сообщения — под верхним отступом экрана (safe-area Telegram), 12 px запаса.
    const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - parseFloat(getComputedStyle(sc).paddingTop) - 12;
    sc.scrollTo({ top, behavior: "smooth" });
  }, [briefAt]);
  useEffect(() => { if (briefAt && briefAt !== briefAtFirst.current && stick.current) showBrief(); }, [showBrief]);

  // Отзыв преподавателя и состояние ответа в Moodle — свежим запросом (при открытии и после каждой смены состояния лабы):
  // от него зависит, показывать ли «Исправить отчёт», и что именно произойдёт при замене файла.
  const [fb, setFb] = useState<Feedback | null>(null);
  const loadFb = useCallback(() => { if (assignId) void feedbackApi.get(assignId).then(setFb).catch(() => { /* останется то, что пришло с дедлайнами */ }); }, [assignId]);
  useEffect(() => { loadFb(); }, [loadFb, job?.status]);

  // own — своё действие студента (сообщение, «Продолжай», файл, запуск): переписку доводим до низа, где бы он ни читал.
  const act = async (fn: () => Promise<LabJob>, okMsg?: string, own = false) => {
    // Второй вызов, пока идёт первый (двойной тап по кнопке Telegram, Enter во время отправки), — не второй запрос агенту.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fn();
      ++seq.current; // опросы, ушедшие раньше этого ответа, устарели
      stick.current = own || atEnd(scrollerOf(rootRef.current));
      seen.current = true;
      setJob(r); setErr(""); if (okMsg) toast(okMsg); haptic.success();
    }
    catch (e) { onLabDenied((e as Error).message); setErr(labErrorText((e as Error).message)); haptic.warning(); }
    finally { busyRef.current = false; setBusy(false); loadFb(); }
  };
  // trial: работа уже сдана (оценена) — проверочный запуск, агент об этом узнает из инструкции.
  // Пробный отчёт (lib/labGate.ts): он один — перед запуском спросить; после запуска профиль обновить (пробный занят).
  const gate = labGate(profile, assignId);
  // Лабы выключены на сервере (переезд, агента нет): всё, что зовёт агента, скрыто; отчёт, «Всё хорошо» и Moodle — как обычно.
  const off = !!profile?.labsOff;
  const start = async () => {
    if (!d || !assignId || busyRef.current) return;
    if (gate === "trial-offer" && !(await confirmDialog(`Начать пробный отчёт по «${d.title}»? Он один: после запуска другие работы будут закрыты, пока владелец не откроет доступ.`))) return;
    await act(() => labApi.start(assignId, { title: d.title, course: subjectOf(subjects, d.subjectId)?.name ?? "", due: d.due, trial: d.status === "done" }), "Агент взялся за работу", true);
    if (gate === "trial-offer") void useAuth.getState().load().catch(() => {});
  };
  // Первый ответ на уточняющие вопросы (16 окт, просьба владельца): агент уже написал, а студент после этого ещё не отвечал.
  // Перед отправкой — «всё ли верно»: недостающий ответ агент переспросит отдельным ходом, это и время, и расход.
  const firstAnswer = () => {
    const ms = job?.messages ?? [];
    const a = ms.findIndex((m) => m.role === "assistant");
    return status === "waiting" && a >= 0 && !ms.slice(a).some((m) => m.role === "user");
  };
  const send = async () => {
    const t = text.trim();
    if (!t || !assignId || busyRef.current) return;
    if (firstAnswer() && !(await confirmDialog("Проверьте ответ: вы ответили на все вопросы агента и данные верны? Если чего-то не хватит, агент переспросит, и работа задержится. Отправить?"))) {
      inputRef.current?.focus();
      return;
    }
    setText("");
    if (inputRef.current) inputRef.current.style.height = "";
    void act(() => labApi.message(assignId, t), undefined, true);
  };
  // Что сейчас в Moodle: свежий ответ сервера, а пока его нет — то, что пришло вместе с дедлайнами.
  const remarks = fb?.remarks ?? d?.remarks ?? [];
  const moodleSub = fb ? { status: fb.status, canEdit: fb.canEdit, drafts: fb.drafts, files: fb.files.map((f) => f.name) } : d?.submission ?? null;
  // У задания нет черновика (так у лабораторных ОКП): прикрепить = сразу сдать преподавателю.
  const noDrafts = moodleSub?.drafts === false;
  const canEdit = moodleSub?.canEdit ?? true;
  // Файлы, которые новый отчёт заменит (прикрепление всегда оставляет в ответе только новый файл).
  const oldFiles = (moodleSub?.files ?? []).filter((n) => n !== job?.report?.name);
  const replacing = oldFiles.length > 0;
  const fix = async () => {
    if (!d || !assignId) return;
    haptic.warning();
    const onlyNew = remarks.some((r) => r.state === "new");
    if (await confirmDialog(`Отправить ${onlyNew ? "новые замечания" : "замечания"} преподавателя агенту? Он исправит отчёт и пришлёт новый файл. В Moodle ничего не изменится, пока вы сами не подтвердите замену файла.`))
      await act(() => labApi.fix(assignId, { title: d.title, course: subjectOf(subjects, d.subjectId)?.name ?? "", due: d.due }), "Замечания отправлены агенту");
  };
  const attach = async () => {
    if (!assignId || !job?.report) return;
    haptic.warning();
    // Окно подтверждения Telegram вмещает 256 знаков, поэтому длинные имена файлов сокращаются (полные — в карточке отчёта).
    const short = (n: string) => (n.length > 42 ? `${n.slice(0, 30)}…${n.slice(-10)}` : n);
    const file = `«${short(job.report.name)}»`, old = oldFiles.slice(0, 2).map((n) => `«${short(n)}»`).join(", ");
    // Три разных случая — и в каждом пользователь должен видеть, что именно произойдёт в Moodle.
    const question = replacing && moodleSub?.status === "submitted"
      ? `Работа уже на проверке. ${old} будет удалён, вместо него сразу встанет ${file} — отдельной отправки не будет. Заменить?`
      : noDrafts
        ? `В этом задании нет черновика: ${file} сразу уйдёт преподавателю на проверку${replacing ? ` вместо ${old}` : ""}. Сдать?`
      : replacing
        ? `Заменить файл в ответе: удалить ${old}, прикрепить ${file} как черновик? На проверку это не отправляет.`
        : `Прикрепить ${file} к заданию как черновик? На проверку это ещё не отправляет.`;
    if (await confirmDialog(question)) {
      await act(() => labApi.attach(assignId), noDrafts ? "Работа сдана в Moodle" : replacing ? "Файл в Moodle заменён" : "Черновик прикреплён");
      void useAppStore.getState().syncMoodle(true); // список работ — сразу с новым статусом
    }
  };
  // Круг проверки: «Всё хорошо» подтверждает отчёт (после этого появляется прикрепление), «Есть замечания» ставит курсор
  // в поле ввода — правки уйдут агенту, он переделает отчёт и спросит снова.
  const approved = job?.review === "approved";
  const reviewing = job?.status === "report" && !approved;
  const approve = () => assignId && act(() => labApi.approve(assignId));
  const [wantFix, setWantFix] = useState(false);
  const askFix = () => { haptic.tap(); setWantFix(true); inputRef.current?.focus(); };
  useEffect(() => { if (!reviewing) setWantFix(false); }, [reviewing]);
  // «Кратко о работе»: объяснение сути работы к текущей версии отчёта. Если оно уже есть — кнопка просто показывает его.
  const briefing = !!job?.briefing;
  const briefFresh = !!job?.brief && !!job.report && job.brief.report === job.report.mtime && job.messages.some((x) => x.kind === "brief" && x.at === job.brief?.at);
  const explain = () => { if (!assignId) return; if (briefFresh) { haptic.select(); showBrief(); } else void act(() => labApi.explain(assignId)); };
  // Последнее сообщение с отчётом — только у него кнопка «Открыть PDF» (ссылка всегда ведёт на текущий файл).
  let lastReport = -1;
  (job?.messages ?? []).forEach((m, i) => { if (m.kind === "report") lastReport = i; });
  const openPdf = () => { if (!job) return; const u = labApi.reportUrl(job); if (tg?.openLink) tg.openLink(u); else window.open(u, "_blank"); };
  const submit = async () => {
    if (!assignId) return;
    haptic.warning();
    // Синхронизация — только после настоящей отправки, а не после «Отмена» в окне подтверждения (проверка 15 окт).
    if (await confirmDialog("Отправить работу на проверку преподавателю? После этого файл менять нельзя.")) {
      await act(() => labApi.submit(assignId), "Отправлено на проверку");
      void useAppStore.getState().syncMoodle(true);
    }
  };

  // null — сервер ещё не ответил (или первый запрос упал): ни «Не начато», ни кнопки «Сделать отчёт», пока это не известно.
  const status = job?.status ?? (loaded ? "idle" : null);
  // После отправки на проверку диалог закрыт: лишние ходы агента ничего не дадут.
  // «Ошибка» — агент не запустился (или не скачалось условие): писать некому, нужна кнопка «Запустить заново».
  const canReply = !off && (status === "waiting" || status === "report" || status === "attached");
  // Поле убрали вместе с панелью, пока оно было в фокусе (ответил Enter — агент снова работает): React при удалении
  // узла onBlur не шлёт, и панель вернулась бы с touch-action: none — взмах снизу снова не листал бы переписку.
  useEffect(() => { if (!canReply) setFocused(false); }, [canReply]);
  // Проверочный запуск (работа уже оценена): отчёт есть, но в Moodle его не прикрепить и не отправить.
  const trial = !!job?.trial;
  const attachLabel = replacing && moodleSub?.status === "submitted" ? "Заменить файл в Moodle" : noDrafts ? "Сдать в Moodle" : replacing ? "Заменить файл в Moodle" : "Прикрепить черновик";
  // Если Moodle не даёт менять ответ, кнопки прикрепления нет вовсе — причина написана в карточке отчёта.
  // Прикрепление — только после того, как студент подтвердил отчёт («Всё хорошо»).
  const mainLabel = status === null || (off && (status === "idle" || status === "error")) ? "" : status === "idle" ? "Сделать отчёт" : status === "error" ? "Запустить заново" : trial ? "" : status === "report" ? (canEdit && approved ? attachLabel : "") : status === "attached" ? "Отправить на проверку" : "";
  // «Запустить заново» после неудачного исправления повторяет именно исправление, а не начинает лабу с нуля.
  const restart = job?.fix ? fix : start;
  const mainAction = status === "idle" ? start : status === "error" ? restart : trial ? () => {} : status === "report" ? attach : status === "attached" ? submit : () => {};
  const nativeButton = useMainButton(mainLabel, mainAction, !!mainLabel && !busy && !briefing);

  if (!d || !assignId) return <EmptyState icon={FileText} title="Это не задание Moodle" text="Отчёт можно делать только для лабораторных, пришедших из Moodle." action="Назад" onAction={pop} />;

  return (
    // grow, а не min-h-full: экран стека сам растягивает содержимое на всю высоту (flex-обёртка в StackScreen).
    <div ref={rootRef} className="flex grow flex-col gap-3" onClick={tapOutside} onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
      onTouchMove={(e) => { if (e.touches[0].clientY - touchY.current > DISMISS_Y && document.activeElement === inputRef.current) { inputRef.current?.blur(); haptic.select(); } }}>
      <div className="px-1">
        <p className="flex items-center gap-1.5 text-s font-semibold text-hint"><Sparkles size={14} strokeWidth={2.5} />Лаба с агентом
          {(job?.viaTrial || gate === "trial-offer" || gate === "trial-own") && <span className="rounded-full bg-accent/15 px-2 py-0.5 font-bold text-accent">пробный отчёт</span>}</p>
        <h1 className="font-display mt-1 text-[22px] leading-[1.15] font-extrabold tracking-[-0.02em]">{d.title}</h1>
        <p className="mt-2 flex items-center gap-2 text-s">
          {status ? <span className={`rounded-full px-2.5 py-1 font-bold ${STATUS[status].cls}`}>{status === "running" && job?.revising ? "Исправляет отчёт" : STATUS[status].label}</span>
            : !err && <span className="h-[26px] w-28 rounded-full bg-raised motion-safe:animate-pulse" />}
          {job?.updatedAt && <span className="text-hint">обновлено {time(job.updatedAt)}</span>}
        </p>
      </div>

      {off && <p className="glass rounded-2xl px-3.5 py-3 text-s leading-[19px]">⏸ {LABS_OFF_TEXT}</p>}

      {/* Замечания преподавателя из Moodle. Пока агент работает, кнопки нет; после исправления кнопка отправит новые
          замечания (те, что появились после него), а если новых нет — прежние ещё раз. */}
      {/* «Исправить» — только тем, кому сервер его разрешит: полный доступ или своя пробная лаба (не до начала пробного). */}
      <TeacherRemarks remarks={remarks} submission={moodleSub} busy={busy} index={0} onFix={off || status === "running" || status === null || !(gate === "full" || gate === "trial-own") ? undefined : fix} />

      {/* Наверху — итог хода (пока агент работает, прогресс показан карточкой в переписке). */}
      {job && status !== "idle" && status !== "running" && (
        <Tile index={0} className="!min-h-0 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <TileLabel className="truncate normal-case tracking-normal text-text">{job.stage || "Готовлюсь"}</TileLabel>
            <span className="font-display shrink-0 text-[22px] leading-none font-extrabold tabular"><RollingNumber value={Math.round(job.progress ?? 0)} /><span className="ml-0.5 text-s font-bold text-hint">%</span></span>
          </div>
          <div className="mt-3"><ProgressBar value={(job.progress ?? 0) / 100} /></div>
        </Tile>
      )}

      {/* До первого ответа сервера — нейтральная заглушка (проверка 15 окт): раньше 0,5–2 с горели «Не начато» и активная
          «Сделать отчёт», а потом всё резко сменялось перепиской. Первый запрос упал — ошибка и «Повторить». */}
      {status === null && (err ? (
        <div className="flex flex-col gap-2">
          <p className="px-1 text-s font-semibold text-red">{err}</p>
          <button onClick={retry} className="glass flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent"><RotateCcw size={18} strokeWidth={2.5} /> Повторить</button>
        </div>
      ) : <Skeleton className="h-36 rounded-[22px]" />)}

      {status === "idle" && (
        <Tile index={0} className="min-h-0">
          <TileLabel>Как это работает</TileLabel>
          <p className="mt-2 text-s leading-[19px] text-hint">Агент на сервере скачает методичку и шаблон, разберётся в задании и задаст вам пару вопросов. Потом сделает работу, соберёт отчёт по шаблону курса и покажет его здесь. В Moodle ничего не уйдёт без вашего подтверждения.</p>
          <p className="mt-3 text-s leading-[19px]">
            <span className="text-hint">Титульный лист: </span>
            <span className="font-semibold">{shortName(profile?.moodle?.fullName) || "ФИО из Moodle"}, {profile?.group ?? "группа не выбрана"}, вариант {profile?.variant ?? "не указан"}</span>
            {!profile?.variant && <span className="text-hint"> — агент спросит; можно заранее указать в профиле.</span>}
          </p>
          {gate === "trial-offer" && <p className="mt-3 text-s leading-[19px] text-hint">Это ваш пробный отчёт: один отчёт по одной работе. После запуска другие работы будут закрыты, пока владелец не откроет доступ.</p>}
          <p className="mt-3 text-s leading-[19px] text-hint">⚠️ Ранний доступ: агент может ошибаться — проверьте отчёт перед сдачей.</p>
          {!nativeButton && !off && <button onClick={start} disabled={busy} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40"><Sparkles size={18} strokeWidth={2.5} /> Сделать отчёт</button>}
        </Tile>
      )}

      {job && (job.messages?.length ?? 0) > 0 && (
        // Смахивание вниз по переписке тоже убирает клавиатуру (жест из Telegram и iMessage).
        <div className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {job.messages.map((msg, i) => (
              <m.div key={`${msg.at}-${i}`} id={msg.kind === "brief" ? `brief-${msg.at}` : undefined} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring(420, 34)}
                className={`flex scroll-mt-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {/* wrap-anywhere: длинная ссылка или имя файла без пробелов переносится в пузыре, а не уводит экран вбок (проверка 15 окт). */}
                <div className={`max-w-[88%] rounded-[18px] px-3.5 py-2.5 text-m leading-[22px] whitespace-pre-wrap wrap-anywhere ${
                  msg.role === "user" ? "rounded-br-md bg-accent text-on-accent" : msg.role === "system" ? "glass text-hint text-s" : "glass-tile rounded-bl-md"}`}>
                  {msg.role === "assistant" && <span className="mb-1 flex items-center gap-1 text-[12px] font-bold text-hint"><Bot size={12} strokeWidth={2.5} />Doodle · {time(msg.at)}</span>}
                  {msg.kind === "brief" && <span className="mb-1.5 flex items-center gap-1.5 text-s font-bold text-accent"><BookOpen size={15} strokeWidth={2.5} />Кратко о работе</span>}
                  {/* Готовый отчёт приходит прямо в переписку: файл открывается из сообщения. У прежних версий кнопки нет. */}
                  {msg.kind === "report" && msg.report && (
                    <span className="mb-2 block rounded-2xl bg-raised p-3 whitespace-normal">
                      <span className="flex items-start gap-2.5">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"><FileText size={20} strokeWidth={2.25} /></span>
                        <span className="min-w-0">
                          <span className="block text-s font-bold break-all leading-[18px]">{msg.report.name}</span>
                          <span className="block text-[12px] text-hint">{mb(msg.report.size)}{msg.report.pages ? ` · ${msg.report.pages} стр.` : ""}</span>
                        </span>
                      </span>
                      {i === lastReport
                        ? <button onClick={openPdf} className="mt-2.5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-s font-bold text-on-accent"><ExternalLink size={16} strokeWidth={2.5} /> Открыть PDF</button>
                        : <span className="mt-2 block text-[12px] text-hint">Эта версия заменена новой — она ниже.</span>}
                    </span>
                  )}
                  {msg.kind === "brief" ? <BriefText text={msg.text} /> : msg.text}
                </div>
              </m.div>
            ))}
          </AnimatePresence>
          {/* Пока агент работает — карточка хода прямо в переписке: что он делает (при исправлении — «исправляет отчёт»),
              этап и процент. Видна там, куда смотрит студент, а не только наверху экрана. */}
          {status === "running" && job && (
            <div className="glass-tile w-[88%] rounded-[18px] rounded-bl-md px-3.5 py-3" aria-live="polite">
              <span className="mb-1.5 flex items-center gap-1 text-[12px] font-bold text-hint">
                <Bot size={12} strokeWidth={2.5} />Doodle · {job.queued ? "в очереди" : job.revising ? "исправляет отчёт" : "работает"}
              </span>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-s font-semibold leading-[18px]">{job.stage || "Готовлюсь"}</span>
                <span className="font-display shrink-0 text-[18px] leading-none font-extrabold tabular"><RollingNumber value={Math.round(job.progress ?? 0)} /><span className="ml-0.5 text-s font-bold text-hint">%</span></span>
              </div>
              <div className="mt-2.5"><ProgressBar value={(job.progress ?? 0) / 100} /></div>
              {/* Что агент делает прямо сейчас (сервер видит сам); пока этого нет (очередь, начало хода) — точки «печатает». */}
              {job.activity ? <LabPulse a={job.activity} lines={2} className="mt-2.5" /> : (
                <div className="mt-2.5 flex items-center gap-1.5" aria-label="Агент печатает">
                  {[0, 1, 2].map((i) => <m.span key={i} className="size-1.5 rounded-full bg-hint" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.18 }} />)}
                </div>
              )}
            </div>
          )}
          {/* Агент готовит «Кратко о работе»: состояние лабы прежнее, поэтому своя небольшая карточка в переписке. */}
          {briefing && status !== "running" && (
            <div className="glass-tile w-[88%] rounded-[18px] rounded-bl-md px-3.5 py-3" aria-live="polite">
              <span className="mb-1.5 flex items-center gap-1 text-[12px] font-bold text-hint"><Bot size={12} strokeWidth={2.5} />Doodle · {job?.queued ? "в очереди" : "готовит объяснение"}</span>
              <span className="text-s font-semibold leading-[18px]">Пишу коротко, в чём суть работы и что спросят на защите. Обычно это минута-две.</span>
              <div className="mt-2.5 flex items-center gap-1.5" aria-label="Агент печатает">
                {[0, 1, 2].map((i) => <m.span key={i} className="size-1.5 rounded-full bg-hint" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.18 }} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Действия с готовым отчётом — сразу под перепиской. Сам файл с кнопкой «Открыть PDF» уже есть в сообщении
          бота выше, поэтому отдельной карточки отчёта нет (только у старых лаб, где файла в переписке нет). */}
      {job?.report && status !== "running" && (
        <div className="flex flex-col gap-2">
          {lastReport < 0 && (
            <button onClick={openPdf} className="glass flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent"><ExternalLink size={18} strokeWidth={2.5} /> Открыть отчёт «{job.report.name}»</button>
          )}
          {/* Круг проверки: пока студент не сказал «всё хорошо», прикрепления нет — только подтвердить или написать правки. */}
          {reviewing && (
            <>
              {/* После «Есть замечания» кнопки выбора убираются: студент спокойно пишет правки, ничего лишнего под рукой
                  (просьба владельца, 4 окт 2026). Вернуть выбор — «Отмена». */}
              {wantFix ? (
                // «Отмена» — отдельной заметной кнопкой: если «Есть замечания» нажали случайно, а отчёт устраивает, она
                // возвращает «Всё хорошо». На сервере при этом ничего не меняется: пока правки не отправлены, ход не начат.
                <div className="flex items-center gap-2 px-1">
                  <p className="flex-1 text-s leading-[18px] text-hint">Напишите в поле ниже всё, что нужно исправить, одним сообщением. Нажали случайно — «Отмена».</p>
                  <button onClick={() => { haptic.select(); setWantFix(false); inputRef.current?.blur(); }} className="glass min-h-10 shrink-0 rounded-full px-4 text-s font-bold text-accent">Отмена</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button onClick={approve} disabled={busy} className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-green text-m font-bold text-white disabled:opacity-40"><Check size={18} strokeWidth={3} /> Всё хорошо</button>
                  {!off && <button onClick={askFix} disabled={busy} className="glass flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-40"><Pencil size={17} strokeWidth={2.5} /> Есть замечания</button>}
                </div>
              )}
            </>
          )}
          {trial && status === "report" && <p className="px-1 text-s leading-[18px] text-hint">Проверочный запуск: работа уже оценена, поэтому отчёт в Moodle не прикрепляется и не отправляется.</p>}
          {/* Что будет заменено в Moodle — видно заранее, до нажатия. */}
          {!trial && status === "report" && approved && replacing && canEdit && (
            <p className="px-1 text-s leading-[18px] text-hint">Сейчас в Moodle прикреплён {oldFiles.map((n) => `«${n}»`).join(", ")}. {noDrafts ? "Новый файл встанет вместо него и сразу уйдёт на проверку." : "При замене он будет удалён из ответа, вместо него встанет этот файл."}</p>
          )}
          {!trial && status === "report" && approved && !canEdit && (
            <p className="px-1 text-s leading-[18px] text-hint">Moodle сейчас не разрешает менять ответ по этой работе, поэтому прикрепить файл нельзя. Попросите преподавателя вернуть работу в черновик или открыть новую попытку — кнопка появится сама.</p>
          )}
          {!nativeButton && !trial && status === "report" && approved && canEdit && (
            <button onClick={attach} disabled={busy || briefing} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40"><Paperclip size={18} strokeWidth={2.5} /> {attachLabel}</button>
          )}
          {!nativeButton && !trial && status === "attached" && (
            <button onClick={submit} disabled={busy || briefing} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-green text-m font-bold text-white disabled:opacity-40"><Check size={18} strokeWidth={3} /> Отправить на проверку</button>
          )}
          {status === "submitted" && <p className="flex items-center gap-2 px-1 text-m font-bold text-green"><Check size={18} strokeWidth={3} /> Работа отправлена на проверку</p>}
          {/* «Кратко о работе» — когда отчёт подтверждён, прикреплён или отправлен: суть работы, главные числа и вопросы к
              защите (просьба владельца, 4 окт 2026). Объяснение к этой версии отчёта уже есть — кнопка просто показывает его. */}
          {!reviewing && !briefing && (!off || briefFresh) && (
            <button onClick={explain} disabled={busy} className="glass flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-40"><BookOpen size={18} strokeWidth={2.5} /> {briefFresh ? "Показать «Кратко о работе»" : "Кратко о работе"}</button>
          )}
        </div>
      )}

      {status === "error" && !nativeButton && !off && (
        <button onClick={restart} disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40"><Sparkles size={18} strokeWidth={2.5} /> Запустить заново</button>
      )}
      {err && status !== null && <p className="px-1 text-s font-semibold text-red">{err}</p>}

      {/* «↓ Новые сообщения» — пока студент читает выше: прилипает к низу экрана (над панелью ввода, если она есть).
          Высота 0 и -mt-3 — чтобы значок не добавлял места в ленте экрана. */}
      {fresh && (
        <div className={`pointer-events-none sticky z-10 -mt-3 flex h-0 items-end justify-center ${canReply ? "bottom-[84px]" : "bottom-3"}`}>
          <button onClick={() => { haptic.select(); stick.current = true; setFresh(false); toEnd(true); }}
            className="pointer-events-auto flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-s font-bold text-on-accent shadow-lg">
            <ArrowDown size={15} strokeWidth={2.5} />Новые сообщения
          </button>
        </div>
      )}

      {canReply && (
        <m.div ref={barRef}
          // Пока клавиатура закрыта, панель — обычная часть переписки: взмах с неё прокручивает экран (проверка 15 окт: с
          // touch-action: none экран «залипал» под большим пальцем). Тянуть поле вниз, пряча клавиатуру, — только при фокусе.
          className="sticky bottom-0 -mx-4 flex flex-wrap items-end gap-2 relative bg-page px-4 pt-4 pb-2 after:absolute after:inset-x-0 after:top-full after:h-[calc(24px+var(--safe-bottom))] after:bg-page after:content-['']" style={{ touchAction: focused ? "none" : "pan-y" }}
          dragListener={false} dragControls={dragControls}
          onPointerDown={(e) => { if (focused && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) dragControls.start(e); }}
          // Поле ввода тянется вниз за пальцем (как клавиатура в Telegram): пока держишь — едет, отпустил раньше — вернулось,
          // утянул в нижнюю зону — клавиатура прячется. Саму клавиатуру веб двигать не умеет, поэтому за палец идёт поле.
          drag="y" dragDirectionLock dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.7 }} dragMomentum={false}
          onDrag={(_, info) => { if (info.offset.y > DISMISS_Y && document.activeElement === inputRef.current) { inputRef.current?.blur(); haptic.select(); } }}
        >
          <div aria-hidden className="absolute top-1 left-0 right-0 flex h-3 items-center justify-center"><span className="h-1 w-9 rounded-full bg-hint/40" /></div>
          {status === "waiting" && <p className="w-full px-1 text-s text-hint">Ответьте на все вопросы одним сообщением. Enter — новая строка.</p>}
          {/* У низа ли студент — замеряем в момент фокуса, пока клавиатура ещё не сжала окно; через 250 мс она уже открыта. */}
          {/* Многострочное поле (16 окт, жалоба владельца): студенты жали Enter, чтобы ответить на следующий вопрос с новой
              строки, и ответ уходил наполовину — агент тратил ход и переспрашивал остальное. Теперь Enter — новая строка,
              отправка — кнопкой (на компьютере ещё Ctrl+Enter). Поле растёт с текстом до ~6 строк, дальше прокручивается. */}
          <textarea ref={inputRef} value={text} rows={1} enterKeyHint="enter" maxLength={1500}
            onChange={(e) => { setText(e.target.value.slice(0, 1500)); fitHeight(e.target); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
            onFocus={() => { setFocused(true); stick.current = atEnd(scrollerOf(rootRef.current)); window.setTimeout(keepEnd, 250); }} onBlur={() => setFocused(false)}
            placeholder={reviewing ? (wantFix ? "Что исправить?" : "Правки или «всё хорошо»") : status === "waiting" ? "Ваш ответ" : "Сообщение по лабе"}
            className={`${fieldClass} min-h-12 resize-none py-3 leading-snug`} />
          {/* Скрепка: снимок экрана или файл студента — в папку лабы, агент узнает о нём со следующим сообщением. */}
          <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.csv,.log,.json,.xlsx,.xls,.docx,.doc,.zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && assignId) void act(() => labApi.upload(assignId, f), `Файл принят: ${f.name}`, true); }} />
          <button onClick={() => { haptic.select(); fileRef.current?.click(); }} disabled={busy} aria-label="Прикрепить снимок или файл" className="glass grid size-12 shrink-0 place-items-center rounded-2xl text-accent disabled:opacity-40"><Paperclip size={20} strokeWidth={2.25} /></button>
          <button onClick={send} disabled={busy || !text.trim()} aria-label="Отправить" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent text-on-accent disabled:opacity-40"><Send size={20} strokeWidth={2.25} /></button>
        </m.div>
      )}
      {canReply && job?.agent?.status === "working" && (
        <button onClick={() => { if (busyRef.current) return; setText(""); void act(() => labApi.message(assignId, "Продолжай"), undefined, true); }} disabled={busy} className="glass min-h-11 rounded-2xl text-m font-bold text-accent">Продолжай</button>
      )}
    </div>
  );
}
