import { m } from "framer-motion";
import { Check, ExternalLink, FileSearch, Flag, Pencil, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { apiBase, assignIdOf, labApi } from "../store/api";
import { useAuth } from "../store/auth";
import { LabProgressCard } from "../components/LabProgressCard";
import { TeacherRemarks } from "../components/Remarks";
import { SubmitOwnFile } from "../components/SubmitOwnFile";
import { TeacherPlaque } from "../components/Teachers";
import { RollingNumber } from "../components/RollingNumber";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState, SubjectDot, fmtGrade } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { useMainButton } from "../hooks/useTelegramButtons";
import { useUi } from "../hooks/useUi";
import { effectiveDue, elapsedParts, leftParts, mskParts } from "../lib/dates";
import { subjectOf, useAppStore } from "../store/useAppStore";
import { kindOf } from "../theme/kinds";
import { spring } from "../theme/motion";
import { heroGradient, urgencyOf } from "../theme/urgency";
import { confirmDialog, haptic, tg } from "../telegram/webapp";

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const REMINDER = { day: "Сутки", "3h": "3 часа", none: "Нет" } as const;

/** «Четверг, 2 октября, 23:59» (срок 00:00 показан как 23:59 накануне). */
function fmtFull(ms: number) {
  const p = mskParts(effectiveDue(ms));
  const w = WEEKDAYS[(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7];
  return `${w[0].toUpperCase()}${w.slice(1)}, ${p.d} ${MONTHS_GEN[p.m - 1]}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}
function fmtMoment(ms: number) {
  const p = mskParts(ms);
  return `${p.d} ${MONTHS_GEN[p.m - 1]}, ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** Детали дедлайна: отсчёт, срок, предмет, напоминание; «Отметить сданным», изменить, удалить. */
export function DeadlineDetailsScreen({ id }: { id: string }) {
  const { deadlines, subjects, updateDeadline, deleteDeadline } = useAppStore();
  const { push, pop } = useNav();
  const now = useNow();
  const d = deadlines.find((x) => x.id === id);
  const close = () => { useUi.setState({ exitDir: 1 }); pop(); };

  const toggleDone = () => {
    if (!d) return;
    const reopen = d.status === "done";
    updateDeadline(d.id, { status: reopen ? "open" : "done" });
    haptic.success();
    toast(reopen ? "Возвращено в активные" : "Отмечено сданным");
  };
  // Лабы с агентом — только по белому списку (тратят подписку владельца). Для несданных заданий Moodle системная кнопка ведёт к отчёту.
  const labsOk = useAuth((s) => s.profile?.labsAllowed ?? false);
  const profile = useAuth((s) => s.profile);
  const requestAccess = async () => {
    haptic.tap();
    try { await useAuth.getState().requestLabAccess(); toast("Запрос отправлен владельцу"); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
  };
  // «Исправить отчёт»: замечания преподавателя уходят агенту (сервер берёт их из Moodle сам), дальше — экран лабы.
  const [fixing, setFixing] = useState(false);
  const fixReport = async () => {
    const aid = d ? assignIdOf(d.id) : null;
    if (!d || !aid) return;
    haptic.warning();
    const onlyNew = (d.remarks ?? []).some((r) => r.state === "new");
    if (!(await confirmDialog(`Отправить ${onlyNew ? "новые замечания" : "замечания"} преподавателя агенту? Он исправит отчёт и пришлёт новый файл. В Moodle ничего не изменится, пока вы сами не подтвердите замену файла.`))) return;
    setFixing(true);
    try {
      await labApi.fix(aid, { title: d.title, course: subjectOf(subjects, d.subjectId)?.name ?? "", due: d.due });
      haptic.success();
      push({ name: "lab", id: d.id });
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setFixing(false); }
  };
  const labId = d && d.status !== "done" && labsOk ? assignIdOf(d.id) : null;
  const nativeButton = useMainButton(labId ? "Сделать отчёт" : d?.status === "done" ? "Вернуть в активные" : "Отметить сданным",
    () => (labId && d ? push({ name: "lab", id: d.id }) : toggleDone()), !!d);

  if (!d) return <EmptyState icon={Flag} title="Дедлайн не найден" text="Возможно, он уже удалён." action="Назад" onAction={close} />;
  const s = subjectOf(subjects, d.subjectId), kind = kindOf(d.kind), u = urgencyOf(d, now);
  const overdue = effectiveDue(d.due) <= now;
  const remove = async () => {
    haptic.warning();
    if (await confirmDialog(`Удалить «${d.title}»?`)) { deleteDeadline(d.id); toast("Удалено"); close(); }
  };
  // Через страницу-прокладку сервера (/go/moodle): открывает приложение Moodle, а если его нет — сайт.
  const openMoodle = () => {
    if (!d.url) return;
    const go = `${apiBase()}go/moodle?u=${encodeURIComponent(d.url)}`;
    if (tg?.openLink) tg.openLink(go); else window.open(go, "_blank");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-s font-semibold text-hint"><kind.Icon size={14} strokeWidth={2.5} />{kind.label}{d.source === "moodle" && " · Moodle"}</p>
          <h1 className="font-display mt-1 text-[24px] leading-[1.15] font-extrabold tracking-[-0.02em]">{d.title}</h1>
          <p className="mt-1.5 flex items-center gap-2 text-s font-semibold text-hint"><SubjectDot color={s?.color} />{s?.name ?? "Без предмета"}</p>
        </div>
        <button onClick={() => push({ name: "deadline-form", id: d.id })} aria-label="Изменить" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent">
          <Pencil size={18} strokeWidth={2.25} />
        </button>
      </div>
      {/* Преподаватели курса — плашкой сразу под названием работы. */}
      {/^course:\d+$/.test(d.subjectId) && <div className="px-1"><TeacherPlaque courseId={Number(d.subjectId.slice(7))} /></div>}

      <m.section
        initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring(380, 30)}
        className="relative overflow-hidden rounded-[22px] p-4 text-white" style={{ background: heroGradient[u] }}
      >
        <p className="text-s font-medium text-white/80">{d.status === "done" ? (d.grade != null ? "Сдано и оценено" : "Сдано") : overdue ? "Просрочено" : "Осталось"}</p>
        {d.status === "done" && d.grade != null && (
          <div className="font-display mt-2 text-l font-bold tabular">{fmtGrade(d.grade)}{d.gradeMax ? <span className="ml-1 text-m font-semibold text-white/70">из {fmtGrade(d.gradeMax)}</span> : null}</div>
        )}
        {d.status !== "done" && (
          <div className="font-display mt-2 text-l font-bold tabular">
            {(overdue ? elapsedParts(d.due, now) : leftParts(d.due, now)).map(([n, unit]) => (
              <span key={unit} className="mr-2"><RollingNumber value={n} /><span className="ml-0.5 text-m font-semibold text-white/70">{unit}</span></span>
            ))}
            {overdue && <span className="text-m font-semibold text-white/70">назад</span>}
          </div>
        )}
        <p className="mt-3 text-m font-semibold">{fmtFull(d.due)}</p>
      </m.section>

      {/* Комментарий преподавателя из Moodle; кнопка исправления — только тем, кому открыты отчёты с агентом. */}
      <TeacherRemarks remarks={d.remarks ?? []} submission={d.submission} busy={fixing}
        onFix={labsOk && assignIdOf(d.id) ? fixReport : undefined} onOpenLab={labsOk && assignIdOf(d.id) ? () => push({ name: "lab", id: d.id }) : undefined} />

      <Tile index={1} className="min-h-0 py-1">
        <div className="flex min-h-12 items-center justify-between border-b border-separator"><TileLabel>Предмет</TileLabel><span className="text-m font-semibold">{s?.short ?? "—"}</span></div>
        <div className={`flex min-h-12 items-center justify-between ${d.status !== "done" || d.grade != null || d.opensAt ? "border-b border-separator" : ""}`}><TileLabel>Тип</TileLabel><span className="text-m font-semibold">{kind.label}</span></div>
        {d.grade != null && (
          <div className={`flex min-h-12 items-center justify-between ${d.status !== "done" || d.opensAt ? "border-b border-separator" : ""}`}><TileLabel>Оценка</TileLabel>
            <span className="text-m font-bold text-green">{fmtGrade(d.grade)}{d.gradeMax ? <span className="font-semibold text-hint"> из {fmtGrade(d.gradeMax)}</span> : null}</span></div>
        )}
        {d.opensAt && <div className={`flex min-h-12 items-center justify-between ${d.status !== "done" ? "border-b border-separator" : ""}`}><TileLabel>Открыт с</TileLabel><span className="text-m font-semibold">{fmtMoment(d.opensAt)}</span></div>}
        {d.status !== "done" && (
          <div className="flex min-h-12 items-center justify-between gap-3"><TileLabel className="shrink-0">Напомнить за</TileLabel>
            <div className="flex gap-1">
              {(["day", "3h", "none"] as const).map((r) => (
                <button key={r} onClick={() => { haptic.select(); updateDeadline(d.id, { reminder: r }); }} aria-pressed={d.reminder === r}
                  className={`min-h-9 rounded-full px-3 text-s font-bold whitespace-nowrap transition-colors ${d.reminder === r ? "bg-accent text-on-accent" : "bg-raised text-hint"}`}>{REMINDER[r]}</button>
              ))}
            </div></div>
        )}
      </Tile>

      {/* Свой PDF с телефона — сразу в ответ Moodle (у всех вошедших, агент не нужен). */}
      <SubmitOwnFile deadline={d} index={2} />

      {labsOk && assignIdOf(d.id) && <LabProgressCard assignId={assignIdOf(d.id)!} onOpen={() => push({ name: "lab", id: d.id })} />}
      {/* Отчёты по белому списку: без доступа — кнопка запроса владельцу (один раз). */}
      {!labsOk && assignIdOf(d.id) && d.status !== "done" && d.source === "moodle" && (
        <button onClick={requestAccess} disabled={!!profile?.labRequest} className="glass flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-60">
          <Sparkles size={18} strokeWidth={2.5} /> {profile?.labRequest ? "Запрос на отчёты отправлен" : "Запросить доступ к отчётам"}
        </button>
      )}
      {/* Вне Telegram системной кнопки нет — рисуем свою; в Telegram «Сделать отчёт» — это главная кнопка внизу. */}
      {labsOk && assignIdOf(d.id) && !nativeButton && d.status !== "done" && (
        <button onClick={() => push({ name: "lab", id: d.id })} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent">
          <Sparkles size={18} strokeWidth={2.5} /> Сделать отчёт
        </button>
      )}
      {/* Свой отчёт — на проверку агенту до сдачи: оформление, требования задания, прежние замечания преподавателя. */}
      {labsOk && assignIdOf(d.id) && (
        <button onClick={() => { haptic.select(); push({ name: "check", id: d.id }); }} className="glass flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
          <FileSearch size={18} strokeWidth={2.5} /> Проверить свой отчёт
        </button>
      )}
      {d.url && (
        <button onClick={openMoodle} className="glass flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
          <ExternalLink size={18} strokeWidth={2.5} /> Открыть в Moodle
        </button>
      )}
      {!nativeButton && (
        <button onClick={toggleDone} className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold ${d.status === "done" ? "glass text-text" : "bg-accent text-on-accent"}`}>
          {d.status === "done" ? <><Undo2 size={18} strokeWidth={2.5} /> Вернуть в активные</> : <><Check size={18} strokeWidth={3} /> Отметить сданным</>}
        </button>
      )}
      <button onClick={remove} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red/15 text-m font-bold text-red">
        <Trash2 size={18} strokeWidth={2.5} /> Удалить дедлайн
      </button>
      <p className="px-1 text-center text-[12px] font-semibold text-hint">Отметка «сдано» действует только в приложении, в Moodle ничего не отправляется.</p>
    </div>
  );
}
