import { useEffect, useState } from "react";
import type { AssistantIntent, AssistantPresentation } from "../../theme/assistant-state";
import { MascotSprite } from "./MascotSprite";
import { poseFor } from "./pose";
import type { Eyes } from "./sprites";

/*
 * Доступная оболочка маскота (DES-005): спрайт + имя + реплика + одно действие. Получает готовое представление из
 * resolveAssistantPresentation и сама ничего не загружает; действие отдаёт наверх как intent — что с ним делать,
 * решает frontend (DES-010). В спокойном режиме кадры не меняются: сразу итоговая поза с тем же смыслом.
 */

export const CHARACTER_NAME: Record<string, string> = { dusya: "Дуся", varya: "Варя" };

type Props = {
  presentation: AssistantPresentation;
  dark: boolean;
  size?: number;
  nightcap?: boolean;
  onIntent?: (intent: AssistantIntent, deadlineId?: string) => void;
};

export function MascotCard({ presentation: p, dark, size = 72, nightcap = false, onIntent }: Props) {
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

  const name = CHARACTER_NAME[p.character] ?? "Дуся";
  const action = p.action;
  return (
    <section className="flex items-start gap-3 rounded-[20px] bg-card p-3.5 text-text" aria-label={`${name}: подсказка`} data-status={p.status}>
      <MascotSprite character={p.character} eyes={frame.eyes} props={frame.props} anim={frame.anim} motion={p.motion}
        size={size} dark={dark} nightcap={nightcap} />
      <div className="min-w-0 flex-1">
        <p className="text-m font-bold">{name}</p>
        <p className="mt-1 text-m font-medium break-words" aria-live="polite">{p.text}</p>
        {action && (
          <button type="button" onClick={() => onIntent?.(action.intent, action.deadlineId)}
            className="mt-3 min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent">
            {action.label}
          </button>
        )}
      </div>
    </section>
  );
}
