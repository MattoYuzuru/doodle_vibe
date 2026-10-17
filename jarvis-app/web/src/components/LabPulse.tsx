import { useNow } from "../hooks/useNow";
import type { LabActivity } from "../store/api";

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const DOT: Record<LabActivity["state"], string> = { active: "bg-green", long: "bg-yellow", slept: "bg-accent", stuck: "bg-red" };

/**
 * Признаки жизни агента под полосой прогресса: что он сейчас делает и когда было последнее действие. Сервер видит это
 * сам — по файлам в папке лабы, замку замеров и идущим командам (activity.mjs), модель не участвует. Процент меняется
 * только на крупных этапах, а эта строка — каждые несколько секунд: видно, что бот работает.
 */
export function LabPulse({ a, className = "", lines = 1 }: { a?: LabActivity | null; className?: string; lines?: 1 | 2 }) {
  // На слабых телефонах (облегчённый режим) — реже: секундный счётчик там ни к чему.
  const now = useNow(document.documentElement.classList.contains("lite") ? 5000 : 1000);
  if (!a) return null;
  const text = a.state === "active" ? `Сейчас: ${a.what} · ${ago(now - a.at)} назад`
    : a.state === "long" ? `${cap(a.what ?? "работает")} · последнее действие ${ago(now - a.at)} назад`
    : a.state === "slept" ? a.what ?? "Сервер уходил в сон — продолжаю"
    : `Нет новых действий ${ago(now - a.at)}${a.alerted ? " — владелец уведомлён, он проверит" : " — похоже, агент завис"}`;
  const stage = a.stageAt && a.state !== "slept" && now - a.stageAt > 60e3 ? ` · этап идёт ${ago(now - a.stageAt)}` : "";
  return (
    <span className={`flex items-start gap-1.5 text-[12px] leading-4 text-hint ${className}`} aria-live="polite">
      <span className="relative mt-1 inline-flex size-2 shrink-0">
        {a.state === "active" && <span className={`pulse-ping absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT[a.state]}`} />}
        <span className={`relative inline-flex size-2 rounded-full ${DOT[a.state]}`} />
      </span>
      <span className={`min-w-0 ${lines === 2 ? "line-clamp-2" : "truncate"}`}>{text}{stage}</span>
    </span>
  );
}
