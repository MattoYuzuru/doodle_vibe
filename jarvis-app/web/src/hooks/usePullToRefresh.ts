import { animate, motionValue } from "framer-motion";
import { useEffect, useRef } from "react";
import { haptic } from "../telegram/webapp";
import { lastScrollAt } from "./useUi";

const THRESHOLD = 72;
// Возврат без проскока (критическое затухание): с damping 42 лента проскакивала на ~2 px вверх — текст «дрожал».
const BACK = { type: "spring", stiffness: 720, damping: 56 } as const;

/** Смещение всей ленты экранов вниз при «потянуть вниз» (px). Читает App, чтобы двигать контент за пальцем. */
export const pullY = motionValue(0);
/** 1 — обновление запрошено и ждёт, пока лента доедет назад: значок обновления (RefreshIndicator) на это время не гаснет. */
export const pullPending = motionValue(0);

/**
 * Потянуть вниз от верха страницы → onRefresh. Никаких крутилок: контент тянется за пальцем с сопротивлением,
 * при отпускании быстро отпружинивает назад, обновление идёт в фоне, отмечается только коротким вибро.
 */
export function usePullToRefresh(onRefresh: () => Promise<void> | void, enabled = true) {
  // Обработчики ставятся один раз, а enabled и onRefresh читаются из ref (проверка 15 окт): раньше слушатели
  // пересоздавались на каждое открытие экрана и каждый свайп вкладок, и жест, начатый до этого, терял состояние.
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const on = useRef(enabled);
  on.current = enabled;
  // Жест выключили на ходу (открылся экран поверх, начался свайп вкладок) — лента не остаётся сдвинутой.
  useEffect(() => { if (!enabled && pullY.get()) animate(pullY, 0, BACK); }, [enabled]);

  useEffect(() => {
    let start: number | null = null, startX = 0;
    let armed = false, vertical = false, pending = false;
    // Обновление запускаем, когда лента доехала назад (проверка 15 окт): set'ы стора в refresh() перерисовывают вкладки,
    // и пружина возврата начиналась с рывка.
    const run = () => {
      if (!pending) return;
      pending = false;
      // Флаг снимаем, когда обновление закончилось: значок к этому времени держит само «идёт обновление» (refreshing),
      // и между ними он не мигает.
      void Promise.resolve(refresh.current()).finally(() => pullPending.set(0));
    };
    const release = () => animate(pullY, 0, { ...BACK, onComplete: run });
    const down = (e: TouchEvent) => {
      // Новый рывок во время возврата: пружину останавливаем (pullY.set её не останавливал, и она дралась с пальцем —
      // лента дрожала), отложенное обновление запускаем сразу, а ленту подхватываем с того места, где она сейчас.
      const p = pullY.get();
      pullY.stop();
      run();
      // Только от верха и не касанием, которым остановили инерцию (проверка 15 окт): после серии резких взмахов к началу
      // следующий взмах той же серии становился «потягиванием» и запускал обновление, которого не просили.
      const ok = on.current && window.scrollY <= 0 && (p > 0 || performance.now() - lastScrollAt > 250);
      start = ok ? e.touches[0].clientY - p * 2 : null;
      startX = e.touches[0].clientX;
      armed = false;
      vertical = ok && p > 0;
      if (!ok && p) release();
    };
    const move = (e: TouchEvent) => {
      if (start === null) return;
      if (!on.current) { start = null; armed = false; if (pullY.get()) release(); return; }
      const dy = e.touches[0].clientY - start;
      // Только явно вертикальный жест: горизонтальный (ряд фильтров, свайп вкладок) с лёгким уходом пальца вниз раньше
      // тянул всю страницу вниз вместе с прокручиваемым рядом — у верха страницы ряд «подвисал».
      if (!vertical) {
        const dx = e.touches[0].clientX - startX;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) >= Math.abs(dy)) { start = null; return; }
        vertical = true;
      }
      // jump, а не set: без анимаций и без лишней работы framer на каждом touchmove.
      if (dy <= 0) { pullY.jump(0); return; }
      const value = Math.min(dy * 0.5, 130);
      if (value >= THRESHOLD && !armed) { armed = true; haptic.select(); }
      if (value < THRESHOLD) armed = false;
      pullY.jump(value);
    };
    const up = () => {
      if (start !== null && armed && on.current) { haptic.success(); pending = true; pullPending.set(1); }
      start = null;
      armed = false;
      if (pullY.get() || pending) release();
    };
    // Касание отменила система — ленту возвращаем, но обновление не запускаем.
    const cancel = () => {
      start = null;
      armed = false;
      if (pullY.get()) release();
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", cancel);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", cancel);
      run();
      if (pullY.get()) animate(pullY, 0, BACK);
    };
  }, []);
}
