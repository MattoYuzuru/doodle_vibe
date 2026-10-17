import { ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { labApi, type LabJob } from "../store/api";
import { LabPulse } from "./LabPulse";
import { ProgressBar, Skeleton } from "./ui";
import { Tile, TileLabel } from "./Tile";

const LABEL: Record<LabJob["status"], string> = {
  idle: "", running: "Агент работает", waiting: "Ждёт ваш ответ", report: "Отчёт готов", attached: "Черновик в Moodle", submitted: "Отправлено на проверку", error: "Ошибка",
};

/** Карточка хода работы над отчётом в деталях дедлайна: процент, этап, статус. Пока лаба не начата — ничего не показывает. */
export function LabProgressCard({ assignId, onOpen }: { assignId: string; onOpen(): void }) {
  const [job, setJob] = useState<LabJob | null | undefined>(undefined);
  usePolling(() => { labApi.get(assignId).then(setJob).catch(() => setJob(null)); }, job?.status === "running" ? 5000 : 10000);

  if (job === undefined) return <Skeleton className="h-16 rounded-[22px]" />;
  if (!job || job.status === "idle") return null;
  const p = Math.round(job.progress ?? 0);
  return (
    <Tile index={1} onClick={onOpen} className="!min-h-0 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><Sparkles size={18} strokeWidth={2.5} /></span>
        <span className="min-w-0 flex-1">
          <TileLabel className="truncate normal-case tracking-normal text-text">Отчёт · {job.status === "running" && job.revising ? "Исправляется" : LABEL[job.status]}</TileLabel>
          <span className="block truncate text-s text-hint">{job.stage || "Готовлюсь"}</span>
        </span>
        <span className="font-display shrink-0 text-[20px] font-extrabold tabular">{p}<span className="text-s font-bold text-hint">%</span></span>
        <ChevronRight size={18} className="shrink-0 text-hint" />
      </div>
      <div className="mt-3"><ProgressBar value={p / 100} /></div>
      {job.status === "running" && <LabPulse a={job.activity} className="mt-2" />}
    </Tile>
  );
}
