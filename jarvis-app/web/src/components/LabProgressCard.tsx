import { m } from "framer-motion";
import { ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { lite } from "../lib/perf";
import { labApi, type LabJob } from "../store/api";
import { onLabDenied } from "../lib/labGate";
import { haptic } from "../telegram/webapp";
import { spring } from "../theme/motion";
import { LabPulse } from "./LabPulse";
import { ProgressBar } from "./ui";
import { Tile, TileLabel } from "./Tile";

const LABEL: Record<LabJob["status"], string> = {
  idle: "", running: "Агент работает", waiting: "Ждёт ваш ответ", report: "Отчёт готов", attached: "Черновик в Moodle", submitted: "Отправлено на проверку", error: "Ошибка",
};

/**
 * Карточка хода работы над отчётом в деталях дедлайна: процент, этап, статус. Пока лаба не начата — ничего не показывает,
 * а с offer — предложение сделать отчёт (16 окт, владелец: новые пользователи не замечали «Сделать отчёт» — в Telegram это
 * системная кнопка внизу, и что будет после нажатия, нигде не сказано).
 */
export function LabProgressCard({ assignId, onOpen, offer = false, trial = false }: { assignId: string; onOpen(): void; offer?: boolean; trial?: boolean }) {
  const [job, setJob] = useState<LabJob | null | undefined>(undefined);
  // Сбой опроса (сеть, таймаут) не стирает уже показанную карточку: раньше она пропадала на 5–10 с и возвращалась (проверка 15 окт).
  // Отказ по доступу (пробный потрачен, закрыт) — карточку убираем и перечитываем профиль (onLabDenied), а не держим прежнюю.
  usePolling(() => { labApi.get(assignId).then(setJob).catch((e) => { const denied = onLabDenied((e as Error).message); setJob((j) => (denied || j === undefined ? null : j)); }); }, job?.status === "running" ? 5000 : 10000);

  // Пока ответа нет — без заглушки (проверка 15 окт): у большинства работ лабы нет, и серый скелетон через 0,2–1 с исчезал,
  // а кнопки под ним прыгали вверх — нажатие попадало в соседнюю («Отметить сданным» вместо «Открыть в Moodle»).
  // null — запрос не удался (лаба не начата — это ответ со status "idle"): предложение не показываем, доступ мог закрыться.
  if (!job) return null;
  if (job.status === "idle") return offer ? <LabOffer onOpen={onOpen} trial={trial} /> : null;
  const p = Math.round(job.progress ?? 0);
  return (
    // Карточка идущей лабы раскрывается по высоте, а не появляется сразу: кнопки ниже съезжают плавно, а не скачком.
    // overflow — только на время раскрытия, иначе обрезалась бы тень плитки. Отрицательный нижний отступ гасит промежуток
    // gap-3 списка, пока карточка закрыта: иначе кнопки сначала прыгали на 12 px.
    <m.div initial={lite ? false : { height: 0, marginBottom: -12, overflow: "hidden" }} animate={{ height: "auto", marginBottom: 0, transitionEnd: { overflow: "visible" } }} transition={spring(420, 40)}>
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
    </m.div>
  );
}

/**
 * Предложение сделать отчёт, пока лаба не начата: что сделает агент и что от студента ничего не уйдёт без спроса.
 * trial — у пользователя один пробный отчёт (lab-trial.mjs): сказать об этом до нажатия. Пометка о раннем доступе — всем.
 */
function LabOffer({ onOpen, trial = false }: { onOpen(): void; trial?: boolean }) {
  return (
    <m.div initial={lite ? false : { height: 0, marginBottom: -12, overflow: "hidden" }} animate={{ height: "auto", marginBottom: 0, transitionEnd: { overflow: "visible" } }} transition={spring(420, 40)}>
      <div className="rounded-[22px] bg-accent/10 p-4 ring-2 ring-accent/40">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent"><Sparkles size={20} strokeWidth={2.5} /></span>
          <p className="min-w-0 text-m font-bold">Doodle сделает отчёт за вас</p>
        </div>
        {trial && (
          <p className="mt-3 inline-flex rounded-full bg-accent px-3 py-1 text-s font-bold text-on-accent">Доступен 1 пробный отчёт</p>
        )}
        <p className="mt-2 text-s text-hint">Агент прочитает задание, задаст пару вопросов и соберёт готовый PDF. В Moodle ничего не уйдёт без вашего подтверждения.</p>
        {trial && <p className="mt-2 text-s text-hint">Пробный — один отчёт по одной работе. После него другие работы закрыты, пока владелец не откроет доступ.</p>}
        <p className="mt-2 text-s text-hint">⚠️ Ранний доступ: агент может ошибаться — проверьте отчёт перед сдачей.</p>
        <button onClick={() => { haptic.select(); onOpen(); }} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent">
          <Sparkles size={18} strokeWidth={2.5} /> Сделать отчёт
        </button>
      </div>
    </m.div>
  );
}
