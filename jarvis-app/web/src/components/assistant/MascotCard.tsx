import { Flame, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatLeftShort } from "../../lib/dates";
import { type AssistantIntent, type AssistantPresentation, REACTION_WINDOW_MS } from "../../theme/assistant-state";
import { badgeClass } from "../../theme/urgency";
import { MascotSprite } from "./MascotSprite";
import { poseFor } from "./pose";
import type { Eyes } from "./sprites";

/*
 * Доступная оболочка маскота (DES-005, DES-006): спрайт + имя + бейдж срока + реплика + одно действие. Получает готовое
 * представление из resolveAssistantPresentation и сама ничего не загружает; действие отдаёт наверх как intent — что с
 * ним делать, решает frontend (DES-010). В спокойном режиме кадры не меняются: сразу итоговая поза с тем же смыслом.
 * Срочная работа — огонь за маскотом и красный бейдж «Горит · 5 ч»; просрочка подписана отдельно, без огня. Если
 * первична ошибка или операция, срок остаётся бейджем. Загрузка — бег на месте и полоска без процентов.
 */

export const CHARACTER_NAME: Record<string, string> = { dusya: "Дуся", varya: "Варя" };

const LOADING_LABEL: Partial<Record<AssistantPresentation["status"], string>> = {
  connecting: "Подключение", syncing: "Обновление", unknown: "Загрузка",
};

type Props = {
  presentation: AssistantPresentation;
  /** Те же часы, что ушли в resolveAssistantPresentation: из них считается «осталось 5 ч» в бейдже. */
  nowMs: number;
  dark: boolean;
  size?: number;
  nightcap?: boolean;
  onIntent?: (intent: AssistantIntent, deadlineId?: string) => void;
  /** Реакция на сдачу доиграна: frontend добавляет eventId в acknowledgedEventIds, и после reload она не повторится. */
  onReactionShown?: (eventId: string) => void;
  /** Спокойный маскот (DES-009): кнопка паузы анимаций на карточке; выбор хранит вызывающий. */
  calm?: boolean;
  onToggleCalm?: (on: boolean) => void;
};

function UrgencyBadge({ p, nowMs }: { p: AssistantPresentation; nowMs: number }) {
  const u = p.urgency;
  if (!u || u.dueMs === null || (u.level !== "urgent" && u.level !== "overdue" && u.level !== "soon")) return null;
  // Когда первична ошибка или операция, в бейдже и название работы — иначе срок потеряется за текстом ошибки.
  const secondary = p.status !== u.level && p.status !== "completed";
  const head = u.level === "urgent" ? "Горит" : u.level === "overdue" ? "Просрочено" : "Скоро";
  const left = u.level === "overdue" ? "" : ` · ${formatLeftShort(u.dueMs, nowMs)}`;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5" data-urgency={u.level}>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-s font-bold ${badgeClass[u.level]}`}>
        {u.level === "urgent" && <Flame size={14} strokeWidth={2.5} aria-hidden />}
        {head}{left}{secondary && u.title ? ` · «${u.title}»` : ""}
      </span>
      {u.stale && <span className="rounded-full bg-raised px-2 py-0.5 text-s font-bold text-hint">данные могли устареть</span>}
    </p>
  );
}

export function MascotCard({ presentation: p, nowMs, dark, size = 72, nightcap = false, onIntent, onReactionShown, calm, onToggleCalm }: Props) {
  const pose = poseFor(p);
  const live = p.motion === "full";
  const [frame, setFrame] = useState<{ eyes: Eyes; props: readonly string[]; anim: typeof pose.anim }>(
    live ? { eyes: pose.frames[0], props: pose.props, anim: pose.anim } : { eyes: pose.frames[1], props: pose.props2, anim: null });

  // Три кадра реакции на смену состояния, потом покой. Ключ — статус, персонаж и событие: перерисовка их не перезапускает.
  const key = `${p.character}:${p.status}:${p.urgency?.level ?? "-"}:${p.reaction?.eventId ?? "-"}:${p.motion}`;
  useEffect(() => {
    if (!live) { setFrame({ eyes: pose.frames[1], props: pose.props2, anim: null }); return; }
    setFrame({ eyes: pose.frames[0], props: pose.props, anim: pose.anim });
    const t = [
      window.setTimeout(() => setFrame((f) => ({ ...f, eyes: pose.frames[1], props: pose.props2 })), 600),
      window.setTimeout(() => setFrame((f) => ({ ...f, eyes: pose.frames[2] })), 2000),
      window.setTimeout(() => setFrame({ eyes: pose.rest, props: pose.props2, anim: null }), 3000),
    ];
    return () => t.forEach(clearTimeout);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Реакция показывается один раз: когда она доиграла, сообщаем наверх. Ref — чтобы не зависеть от новой функции на рендер.
  const shown = useRef(onReactionShown);
  shown.current = onReactionShown;
  const eventId = p.reaction?.eventId;
  useEffect(() => {
    if (!eventId) return;
    // В спокойном режиме подтверждение тоже держится это время, только без движения.
    const t = window.setTimeout(() => shown.current?.(eventId), REACTION_WINDOW_MS);
    return () => clearTimeout(t);
  }, [eventId]);

  const name = CHARACTER_NAME[p.character] ?? "Дуся";
  const action = p.action;
  const loading = pose.running ? LOADING_LABEL[p.status] ?? "Загрузка" : null;
  return (
    // flex-wrap: если рядом со спрайтом остаётся меньше 10rem (узкий экран, крупный текст), текст и кнопки уходят под него.
    <section className="space-ui flex flex-wrap items-start gap-3 rounded-[20px] bg-card p-3.5 text-text" aria-label={`${name}: подсказка`}
      data-status={p.status} data-accent={p.accent}>
      <MascotSprite character={p.character} eyes={frame.eyes} props={frame.props} anim={frame.anim} motion={p.motion}
        size={size} dark={dark} nightcap={nightcap} running={pose.running} accent={p.accent} />
      <div className="min-w-[10rem] flex-1 basis-40">
        <div className="flex items-start justify-between gap-2">
          <p className="text-m font-bold">{name}</p>
          {onToggleCalm && (
            // Декоративное движение можно остановить (WCAG 2.2.2): смысл, огонь-знак и действие остаются.
            <button type="button" aria-pressed={!!calm} onClick={() => onToggleCalm(!calm)}
              aria-label={calm ? "Включить анимацию маскота" : "Остановить анимацию маскота"}
              className="-mt-2 -mr-1 grid size-11 shrink-0 place-items-center rounded-full text-hint" data-calm-toggle>
              {calm ? <Play size={18} strokeWidth={2.5} aria-hidden /> : <Pause size={18} strokeWidth={2.5} aria-hidden />}
            </button>
          )}
        </div>
        <UrgencyBadge p={p} nowMs={nowMs} />
        <p className="mt-1 text-m font-medium break-words" aria-live="polite">{p.text}</p>
        {loading && <LoadingTrack label={loading} live={live} />}
        {action && (
          <button type="button" onClick={() => onIntent?.(action.intent, action.deadlineId)}
            className="mt-3 min-h-11 max-w-full rounded-2xl bg-accent px-4 text-m font-bold text-on-accent">
            {action.label}
          </button>
        )}
      </div>
    </section>
  );
}

/** Полоска загрузки без процентов: по ней едет отрезок, потому что настоящий прогресс неизвестен. */
export function LoadingTrack({ label, live }: { label: string; live: boolean }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuetext={`${label}…`}
      className={`owl-track mt-2.5 h-2 w-full max-w-60 overflow-hidden rounded-full bg-raised ${live ? "" : "owl-track-still"}`}>
      <span className="owl-track-run block h-full w-1/3 rounded-full bg-accent" />
    </div>
  );
}

/** Отдельная заставка загрузки: маскот бежит на месте, рядом едет полоска и подпись этапа. */
export function MascotLoader({ character, label, dark, motion, size = 72 }: {
  character: string; label: string; dark: boolean; motion: AssistantPresentation["motion"]; size?: number;
}) {
  const live = motion === "full";
  return (
    <div className="flex items-center gap-3" data-loader={character}>
      <MascotSprite character={character} eyes="open" motion={motion} size={size} dark={dark} running />
      <div className="min-w-0 flex-1">
        <p className="text-m font-bold">{label}…</p>
        <LoadingTrack label={label} live={live} />
      </div>
    </div>
  );
}
