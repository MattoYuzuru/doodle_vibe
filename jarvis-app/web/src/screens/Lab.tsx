import { AnimatePresence, m, useDragControls } from "framer-motion";
import { BookOpen, Bot, Check, ExternalLink, FileText, Paperclip, Pencil, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TeacherRemarks } from "../components/Remarks";
import { RollingNumber } from "../components/RollingNumber";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { LabPulse } from "../components/LabPulse";
import { EmptyState, ProgressBar } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { usePolling } from "../hooks/usePolling";
import { useMainButton } from "../hooks/useTelegramButtons";
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
  const { deadlines, subjects } = useAppStore();
  const profile = useAuth((s) => s.profile);
  const pop = useNav((s) => s.pop);
  const d = deadlines.find((x) => x.id === id);
  const assignId = assignIdOf(id);
  const [job, setJob] = useState<LabJob | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null); // скрытый выбор файла для скрепки
  const touchY = useRef(0);
  // Перетаскивание запускается вручную: с «ручки» над полем и с любого места панели, кроме самого поля (там — курсор и выделение).
  const dragControls = useDragControls();
  const barRef = useRef<HTMLDivElement>(null);
  // Тап по чему угодно, кроме панели ввода, прячет клавиатуру (самый простой способ увидеть всю переписку).
  const tapOutside = (e: React.MouseEvent) => {
    if (document.activeElement === inputRef.current && !barRef.current?.contains(e.target as Node)) { inputRef.current?.blur(); haptic.select(); }
  };

  const load = useCallback(async () => {
    if (!assignId) return;
    try { setJob(await labApi.get(assignId)); setErr(""); } catch (e) { setErr((e as Error).message); }
  }, [assignId]);

  // Опрос: пока агент работает (делает лабу или готовит «Кратко о работе») — каждые 3 с, иначе каждые 15 с.
  usePolling(() => void load(), job?.status === "running" || job?.briefing ? 3000 : 15000);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [job?.messages?.length, job?.status, job?.briefing]);
  // Новое «Кратко о работе» — показываем с начала, а не с конца длинного сообщения (этот эффект идёт после прокрутки вниз).
  const briefAt = job?.brief?.at;
  const showBrief = useCallback(() => { if (briefAt) document.getElementById(`brief-${briefAt}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [briefAt]);
  useEffect(() => { showBrief(); }, [showBrief]);

  // Отзыв преподавателя и состояние ответа в Moodle — свежим запросом (при открытии и после каждой смены состояния лабы):
  // от него зависит, показывать ли «Исправить отчёт», и что именно произойдёт при замене файла.
  const [fb, setFb] = useState<Feedback | null>(null);
  const loadFb = useCallback(() => { if (assignId) void feedbackApi.get(assignId).then(setFb).catch(() => { /* останется то, что пришло с дедлайнами */ }); }, [assignId]);
  useEffect(() => { loadFb(); }, [loadFb, job?.status]);

  const act = async (fn: () => Promise<LabJob>, okMsg?: string) => {
    setBusy(true);
    try { setJob(await fn()); setErr(""); if (okMsg) toast(okMsg); haptic.success(); }
    catch (e) { setErr((e as Error).message); haptic.warning(); }
    finally { setBusy(false); loadFb(); }
  };
  // trial: работа уже сдана (оценена) — проверочный запуск, агент об этом узнает из инструкции.
  const start = () => d && assignId && act(() => labApi.start(assignId, { title: d.title, course: subjectOf(subjects, d.subjectId)?.name ?? "", due: d.due, trial: d.status === "done" }), "Агент взялся за работу");
  const send = () => {
    const t = text.trim();
    if (!t || !assignId) return;
    setText("");
    void act(() => labApi.message(assignId, t));
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
    if (await confirmDialog(question)) await act(() => labApi.attach(assignId), noDrafts ? "Работа сдана в Moodle" : replacing ? "Файл в Moodle заменён" : "Черновик прикреплён");
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
    if (await confirmDialog("Отправить работу на проверку преподавателю? После этого файл менять нельзя."))
      await act(() => labApi.submit(assignId), "Отправлено на проверку");
  };

  const status = job?.status ?? "idle";
  // После отправки на проверку диалог закрыт: лишние ходы агента ничего не дадут.
  // «Ошибка» — агент не запустился (или не скачалось условие): писать некому, нужна кнопка «Запустить заново».
  const canReply = status === "waiting" || status === "report" || status === "attached";
  // Проверочный запуск (работа уже оценена): отчёт есть, но в Moodle его не прикрепить и не отправить.
  const trial = !!job?.trial;
  const attachLabel = replacing && moodleSub?.status === "submitted" ? "Заменить файл в Moodle" : noDrafts ? "Сдать в Moodle" : replacing ? "Заменить файл в Moodle" : "Прикрепить черновик";
  // Если Moodle не даёт менять ответ, кнопки прикрепления нет вовсе — причина написана в карточке отчёта.
  // Прикрепление — только после того, как студент подтвердил отчёт («Всё хорошо»).
  const mainLabel = status === "idle" ? "Сделать отчёт" : status === "error" ? "Запустить заново" : trial ? "" : status === "report" ? (canEdit && approved ? attachLabel : "") : status === "attached" ? "Отправить на проверку" : "";
  // «Запустить заново» после неудачного исправления повторяет именно исправление, а не начинает лабу с нуля.
  const restart = job?.fix ? fix : start;
  const mainAction = status === "idle" ? start : status === "error" ? restart : trial ? () => {} : status === "report" ? attach : status === "attached" ? submit : () => {};
  const nativeButton = useMainButton(mainLabel, mainAction, !!mainLabel && !busy && !briefing);

  if (!d || !assignId) return <EmptyState icon={FileText} title="Это не задание Moodle" text="Отчёт можно делать только для лабораторных, пришедших из Moodle." action="Назад" onAction={pop} />;

  return (
    <div className="flex min-h-full flex-col gap-3" onClick={tapOutside} onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
      onTouchMove={(e) => { if (e.touches[0].clientY - touchY.current > DISMISS_Y && document.activeElement === inputRef.current) { inputRef.current?.blur(); haptic.select(); } }}>
      <div className="px-1">
        <p className="flex items-center gap-1.5 text-s font-semibold text-hint"><Sparkles size={14} strokeWidth={2.5} />Лаба с агентом</p>
        <h1 className="font-display mt-1 text-[22px] leading-[1.15] font-extrabold tracking-[-0.02em]">{d.title}</h1>
        <p className="mt-2 flex items-center gap-2 text-s">
          <span className={`rounded-full px-2.5 py-1 font-bold ${STATUS[status].cls}`}>{status === "running" && job?.revising ? "Исправляет отчёт" : STATUS[status].label}</span>
          {job?.updatedAt && <span className="text-hint">обновлено {time(job.updatedAt)}</span>}
        </p>
      </div>

      {/* Замечания преподавателя из Moodle. Пока агент работает, кнопки нет; после исправления кнопка отправит новые
          замечания (те, что появились после него), а если новых нет — прежние ещё раз. */}
      <TeacherRemarks remarks={remarks} submission={moodleSub} busy={busy} index={0} onFix={status === "running" ? undefined : fix} />

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

      {status === "idle" && (
        <Tile index={0} className="min-h-0">
          <TileLabel>Как это работает</TileLabel>
          <p className="mt-2 text-s leading-[19px] text-hint">Агент на сервере скачает методичку и шаблон, разберётся в задании и задаст вам пару вопросов. Потом сделает работу, соберёт отчёт по шаблону курса и покажет его здесь. В Moodle ничего не уйдёт без вашего подтверждения.</p>
          <p className="mt-3 text-s leading-[19px]">
            <span className="text-hint">Титульный лист: </span>
            <span className="font-semibold">{shortName(profile?.moodle?.fullName) || "ФИО из Moodle"}, {profile?.group ?? "группа не выбрана"}, вариант {profile?.variant ?? "не указан"}</span>
            {!profile?.variant && <span className="text-hint"> — агент спросит; можно заранее указать в профиле.</span>}
          </p>
          {!nativeButton && <button onClick={start} disabled={busy} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40"><Sparkles size={18} strokeWidth={2.5} /> Сделать отчёт</button>}
        </Tile>
      )}

      {job && (job.messages?.length ?? 0) > 0 && (
        // Смахивание вниз по переписке тоже убирает клавиатуру (жест из Telegram и iMessage).
        <div className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {job.messages.map((msg, i) => (
              <m.div key={`${msg.at}-${i}`} id={msg.kind === "brief" ? `brief-${msg.at}` : undefined} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring(420, 34)}
                className={`flex scroll-mt-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] rounded-[18px] px-3.5 py-2.5 text-m leading-[22px] whitespace-pre-wrap ${
                  msg.role === "user" ? "rounded-br-md bg-accent text-on-accent" : msg.role === "system" ? "glass text-hint text-s" : "glass-tile rounded-bl-md"}`}>
                  {msg.role === "assistant" && <span className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.06em] text-hint"><Bot size={12} strokeWidth={2.5} />Doodle · {time(msg.at)}</span>}
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
              <span className="mb-1.5 flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.06em] text-hint">
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
              <span className="mb-1.5 flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.06em] text-hint"><Bot size={12} strokeWidth={2.5} />Doodle · {job?.queued ? "в очереди" : "готовит объяснение"}</span>
              <span className="text-s font-semibold leading-[18px]">Пишу коротко, в чём суть работы и что спросят на защите. Обычно это минута-две.</span>
              <div className="mt-2.5 flex items-center gap-1.5" aria-label="Агент печатает">
                {[0, 1, 2].map((i) => <m.span key={i} className="size-1.5 rounded-full bg-hint" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.18 }} />)}
              </div>
            </div>
          )}
          <div ref={endRef} />
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
                  <button onClick={askFix} disabled={busy} className="glass flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-40"><Pencil size={17} strokeWidth={2.5} /> Есть замечания</button>
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
          {!reviewing && !briefing && (
            <button onClick={explain} disabled={busy} className="glass flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-40"><BookOpen size={18} strokeWidth={2.5} /> {briefFresh ? "Показать «Кратко о работе»" : "Кратко о работе"}</button>
          )}
        </div>
      )}

      {status === "error" && !nativeButton && (
        <button onClick={restart} disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40"><Sparkles size={18} strokeWidth={2.5} /> Запустить заново</button>
      )}
      {err && <p className="px-1 text-s font-semibold text-red">{err}</p>}

      {canReply && (
        <m.div ref={barRef}
          className="sticky bottom-0 -mx-4 flex gap-2 relative bg-page px-4 pt-4 pb-2 after:absolute after:inset-x-0 after:top-full after:h-[calc(24px+var(--safe-bottom))] after:bg-page after:content-['']" style={{ touchAction: "none" }}
          dragListener={false} dragControls={dragControls}
          onPointerDown={(e) => { if (!(e.target instanceof HTMLInputElement)) dragControls.start(e); }}
          // Поле ввода тянется вниз за пальцем (как клавиатура в Telegram): пока держишь — едет, отпустил раньше — вернулось,
          // утянул в нижнюю зону — клавиатура прячется. Саму клавиатуру веб двигать не умеет, поэтому за палец идёт поле.
          drag="y" dragDirectionLock dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.7 }} dragMomentum={false}
          onDrag={(_, info) => { if (info.offset.y > DISMISS_Y && document.activeElement === inputRef.current) { inputRef.current?.blur(); haptic.select(); } }}
        >
          <div aria-hidden className="absolute top-1 left-0 right-0 flex h-3 items-center justify-center"><span className="h-1 w-9 rounded-full bg-hint/40" /></div>
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value.slice(0, 1500))} onKeyDown={(e) => { if (e.key === "Enter") send(); }} maxLength={1500}
            placeholder={reviewing ? (wantFix ? "Что исправить в отчёте?" : "Правки к отчёту или «всё хорошо»") : job?.agent?.status === "question" ? "Ваш ответ агенту" : "Только по лабораторной (или «продолжай»)"} className={`${fieldClass} min-h-12 py-2`} />
          {/* Скрепка: снимок экрана или файл студента — в папку лабы, агент узнает о нём со следующим сообщением. */}
          <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.csv,.log,.json,.xlsx,.xls,.docx,.doc,.zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && assignId) void act(() => labApi.upload(assignId, f), `Файл принят: ${f.name}`); }} />
          <button onClick={() => { haptic.select(); fileRef.current?.click(); }} disabled={busy} aria-label="Прикрепить снимок или файл" className="glass grid size-12 shrink-0 place-items-center rounded-2xl text-accent disabled:opacity-40"><Paperclip size={20} strokeWidth={2.25} /></button>
          <button onClick={send} disabled={busy || !text.trim()} aria-label="Отправить" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent text-on-accent disabled:opacity-40"><Send size={20} strokeWidth={2.25} /></button>
        </m.div>
      )}
      {canReply && job?.agent?.status === "working" && (
        <button onClick={() => { setText(""); void act(() => labApi.message(assignId, "Продолжай")); }} disabled={busy} className="glass min-h-11 rounded-2xl text-m font-bold text-accent">Продолжай</button>
      )}
    </div>
  );
}
