import { useEffect, useRef } from "react";
import { tg } from "../telegram/webapp";

const visible = () => !document.hidden && tg?.isActive !== false;

/**
 * Опрос сервера раз в ms: сразу при подключении, затем по таймеру. Пока приложение скрыто (свёрнут Telegram, другая
 * вкладка) — пауза: не тратим батарею, трафик и ноутбук-сервер; при возвращении — сразу свежий запрос.
 */
export function usePolling(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let t = 0;
    const tick = () => ref.current();
    const stop = () => { clearInterval(t); t = 0; };
    const sync = () => {
      if (!visible()) return stop();
      if (!t) { tick(); t = window.setInterval(tick, ms); }
    };
    tick();
    if (visible()) t = window.setInterval(tick, ms);
    document.addEventListener("visibilitychange", sync);
    tg?.onEvent("activated", sync);
    tg?.onEvent("deactivated", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
      tg?.offEvent?.("activated", sync);
      tg?.offEvent?.("deactivated", sync);
    };
  }, [ms, enabled]);
}
