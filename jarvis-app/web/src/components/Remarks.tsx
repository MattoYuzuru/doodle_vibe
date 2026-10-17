import { ChevronDown, MessageSquareText, Wand2 } from "lucide-react";
import { useState } from "react";
import type { Remark, SubmissionState } from "../store/types";
import { Tile, TileLabel } from "./Tile";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

const STATE: Record<NonNullable<Remark["state"]>, { label: string; cls: string }> = {
  new: { label: "Новое", cls: "bg-accent text-on-accent" },
  work: { label: "У агента", cls: "bg-yellow/15 text-yellow" },
  fixed: { label: "Учтено", cls: "bg-green/15 text-green" },
};

/** Что написать на кнопке исправления: зависит от того, были ли уже исправления и есть ли замечания после них. */
export const fixLabelOf = (remarks: Remark[]) =>
  remarks.some((r) => r.state === "new") ? "Исправить по новым замечаниям" : remarks.some((r) => r.state) ? "Исправить ещё раз" : "Исправить отчёт";

function RemarkBody({ r, open, dim }: { r: Remark; open: boolean; dim?: boolean }) {
  return (
    <div className={dim ? "opacity-60" : ""}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-semibold text-hint">
        {r.state && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STATE[r.state].cls}`}>{STATE[r.state].label}</span>}
        <span>{[r.author ?? "Отзыв к оценке", when(r.at)].filter(Boolean).join(" · ")}</span>
      </p>
      {/* wrap-anywhere: длинная ссылка в замечании переносится, а не уводит экран вбок (проверка 15 окт). */}
      <p className={`mt-1 whitespace-pre-line wrap-anywhere text-s leading-[19px] ${open ? "" : "line-clamp-6"}`}>{r.text}</p>
    </div>
  );
}

/**
 * Комментарий преподавателя по работе: отзыв к оценке и записи из «комментариев к ответу» (оба места Moodle).
 * С onFix показывает кнопку «Исправить отчёт»: замечания уходят агенту, он переделывает отчёт. В Moodle при этом ничего
 * не меняется — заменить файл приложение предложит отдельно, когда исправленный отчёт будет готов.
 *
 * После первого исправления у замечаний появляются пометки. Если преподаватель проверил исправленный отчёт и написал
 * ещё, новые замечания стоят сверху с пометкой «Новое», а уже учтённые уходят под «Прежние замечания»; кнопка тогда
 * отправляет агенту только новые.
 */
export function TeacherRemarks({ remarks, submission, onFix, onOpenLab, busy, index = 1 }: {
  remarks: Remark[]; submission?: SubmissionState | null; onFix?: () => void; onOpenLab?: () => void; busy?: boolean; index?: number;
}) {
  const [open, setOpen] = useState(false);
  const [showOld, setShowOld] = useState(false);
  if (!remarks.length) return null;
  // Сверху то, что требует внимания (новые и те, что сейчас у агента), свежие первыми; учтённые — ниже.
  const active = remarks.filter((r) => r.state !== "fixed").reverse();
  const fixed = remarks.filter((r) => r.state === "fixed").reverse();
  const fresh = remarks.filter((r) => r.state === "new").length;
  const atAgent = remarks.some((r) => r.state === "work");
  // Учтённые прячем под спойлер, только если над ними есть что показать; иначе они и есть содержимое блока.
  const collapseOld = active.length > 0 && fixed.length > 0;
  const shown = collapseOld ? (showOld ? fixed : []) : fixed;
  const long = [...active, ...shown].some((r) => r.text.length > 320 || r.text.split("\n").length > 6);
  return (
    <Tile index={index} className="!min-h-0 py-3">
      <TileLabel className="flex items-center gap-1.5">
        <MessageSquareText size={13} strokeWidth={2.5} />Комментарий преподавателя
        {fresh > 0 ? <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold normal-case tracking-normal text-on-accent">{fresh === 1 ? "новое" : `новых: ${fresh}`}</span>
          : remarks.length > 1 && <span className="text-hint/70">{remarks.length}</span>}
      </TileLabel>
      {active.map((r, i) => (
        <div key={r.key ?? i} className={i ? "mt-3 border-t border-separator pt-3" : "mt-2"}><RemarkBody r={r} open={open || !long} /></div>
      ))}
      {!active.length && <p className="mt-2 text-s leading-[18px] text-hint">Все замечания учтены в исправленном отчёте. Если после новой проверки появятся ещё — они будут здесь с пометкой «Новое», а бот напишет в Telegram.</p>}
      {collapseOld && (
        <button onClick={() => setShowOld((o) => !o)} aria-expanded={showOld} className="mt-3 flex min-h-9 w-full items-center justify-between border-t border-separator pt-2 text-s font-bold text-hint">
          Прежние замечания · {fixed.length}<ChevronDown size={16} strokeWidth={2.5} className={`transition-transform ${showOld ? "rotate-180" : ""}`} />
        </button>
      )}
      {shown.map((r, i) => (
        <div key={r.key ?? `f${i}`} className={collapseOld && !i ? "mt-1" : "mt-3 border-t border-separator pt-3"}><RemarkBody r={r} open={open || !long} dim /></div>
      ))}
      {long && <button onClick={() => setOpen((o) => !o)} className="mt-1 min-h-9 text-s font-bold text-accent">{open ? "Свернуть" : "Показать полностью"}</button>}
      {submission && !submission.canEdit && (
        <p className="mt-2 text-s leading-[18px] text-hint">Moodle сейчас не даёт менять ответ по этой работе. Исправленный отчёт можно подготовить, но заменить файл получится, когда преподаватель вернёт работу в черновик или откроет новую попытку.</p>
      )}
      {/* Замечания уже у агента — вести второй ход поверх первого незачем: открываем чат, где он отвечает или спрашивает. */}
      {atAgent && onOpenLab ? (
        <button onClick={onOpenLab} className="glass mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
          <Wand2 size={18} strokeWidth={2.5} /> Открыть исправление
        </button>
      ) : onFix && (
        // Все замечания уже учтены — повторное исправление не главное действие экрана (главное — заменить файл), кнопка спокойная.
        <button onClick={onFix} disabled={busy} className={`mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold disabled:opacity-40 ${
          remarks.some((r) => r.state) && !fresh ? "glass text-accent" : "bg-accent text-on-accent"}`}>
          <Wand2 size={18} strokeWidth={2.5} /> {fixLabelOf(remarks)}
        </button>
      )}
    </Tile>
  );
}
