import { animate, motionValue } from "framer-motion";
import { useEffect } from "react";
import { haptic } from "../telegram/webapp";

const THRESHOLD = 72;

/** Смещение всей ленты экранов вниз при «потянуть вниз» (px). Читает App, чтобы двигать контент за пальцем. */
export const pullY = motionValue(0);

/**
 * Потянуть вниз от верха страницы → onRefresh. Никаких крутилок: контент тянется за пальцем с сопротивлением,
 * при отпускании быстро отпружинивает назад, обновление идёт в фоне, отмечается только коротким вибро.
 */
export function usePullToRefresh(onRefresh: () => Promise<void> | void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let start: number | null = null, startX = 0;
    let armed = false, vertical = false;
    const down = (e: TouchEvent) => {
      start = window.scrollY <= 0 ? e.touches[0].clientY : null;
      startX = e.touches[0].clientX;
      armed = false;
      vertical = false;
    };
    const move = (e: TouchEvent) => {
      if (start === null) return;
      const dy = e.touches[0].clientY - start;
      // Только явно вертикальный жест: горизонтальный (ряд фильтров, свайп вкладок) с лёгким уходом пальца вниз раньше
      // тянул всю страницу вниз вместе с прокручиваемым рядом — у верха страницы ряд «подвисал».
      if (!vertical) {
        const dx = e.touches[0].clientX - startX;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) >= Math.abs(dy)) { start = null; return; }
        vertical = true;
      }
      if (dy <= 0) { pullY.set(0); return; }
      const value = Math.min(dy * 0.5, 130);
      if (value >= THRESHOLD && !armed) { armed = true; haptic.select(); }
      if (value < THRESHOLD) armed = false;
      pullY.set(value);
    };
    const up = () => {
      if (start !== null && armed) { haptic.success(); void onRefresh(); }
      start = null;
      armed = false;
      // Возврат без проскока (критическое затухание): с damping 42 лента проскакивала на ~2 px вверх — текст «дрожал».
      animate(pullY, 0, { type: "spring", stiffness: 720, damping: 56 });
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [onRefresh, enabled]);
}
