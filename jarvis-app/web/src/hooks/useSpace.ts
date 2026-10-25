import { useMemo, useSyncExternalStore } from "react";
import { assistantConfig, toAssistantContext, toDeadlines, toLessons, toSubjects } from "../lib/space-adapter";
import { lite } from "../lib/perf";
import { useAuth } from "../store/auth";
import { usePlatform } from "../store/platform";
import { resolveAssistantPresentation } from "../theme/assistant-state";
import { useNow } from "./useNow";

/** Новый backend (DES-010): /api/me сообщает platformApi, и вкладки показывают данные выбранного вуза. */
export const usePlatformMode = () => useAuth((s) => s.profile?.platformApi === "/api/v1");

const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const subscribeReduced = (cb: () => void) => { reducedQuery?.addEventListener("change", cb); return () => reducedQuery?.removeEventListener("change", cb); };
const subscribeVisible = (cb: () => void) => { document.addEventListener("visibilitychange", cb); return () => document.removeEventListener("visibilitychange", cb); };

/** Активный вуз и его данные в типах прежних экранов, плюс представление маскота. Всё — только этого вуза. */
export function useSpace() {
  const spaces = usePlatform((s) => s.spaces);
  const activeId = usePlatform((s) => s.activeId);
  const data = usePlatform((s) => s.data);
  const acknowledged = usePlatform((s) => s.acknowledged);
  const now = useNow(60_000);
  const reducedMotion = useSyncExternalStore(subscribeReduced, () => !!reducedQuery?.matches);
  const visible = useSyncExternalStore(subscribeVisible, () => document.visibilityState !== "hidden");
  const space = spaces.find((s) => s.id === activeId) ?? null;
  const own = data && space && data.spaceId === space.id ? data : null;

  const deadlines = useMemo(() => (space ? toDeadlines(space.id, own?.deadlines ?? null) : []), [space, own]);
  const lessons = useMemo(() => toLessons(own?.schedule ?? null), [own]);
  const subjects = useMemo(() => (space ? toSubjects(space.id, own?.courses ?? null) : []), [space, own]);
  const presentation = useMemo(() => space ? resolveAssistantPresentation(
    toAssistantContext(space, own, { nowMs: now, reducedMotion, lite, visible, acknowledged }), assistantConfig(spaces)) : null,
  [space, own, now, reducedMotion, visible, acknowledged, spaces]);
  return { spaces, space, data: own, deadlines, lessons, subjects, presentation, now };
}
