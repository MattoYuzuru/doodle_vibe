import { useEffect } from "react";
import { create } from "zustand";

/**
 * Общее состояние интерфейса: компактная панель при прокрутке вниз (как в iOS 26), удержание ползунка вкладок,
 * направление ухода экрана стека и открытая клавиатура (панель вкладок и «+» на это время уезжают вниз).
 */
export const useUi = create<{ compact: boolean; dragging: boolean; exitDir: 1 | -1; keyboard: boolean }>(() => ({
  compact: false, dragging: false, exitDir: 1, keyboard: false,
}));

/**
 * Время последней прокрутки (performance.now()) — окна или любого вложенного скроллера (проверка 15 окт). По нему
 * касание, которым останавливают инерцию, не считается началом «потянуть вниз» или удержанием задачи (TaskRow).
 * Слушатель постоянный и в фазе захвата: событие scroll не всплывает, а так его видно от любого скроллера.
 */
export let lastScrollAt = -Infinity;
window.addEventListener("scroll", () => { lastScrollAt = performance.now(); }, { passive: true, capture: true });

export function useCompactOnScroll() {
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - last;
      last = y;
      const { compact } = useUi.getState();
      if (!compact && y > 80 && dy > 6) useUi.setState({ compact: true });
      else if (compact && (dy < -6 || y < 40)) useUi.setState({ compact: false });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

/** Поле, которое вызывает клавиатуру (флажки, файлы, кнопки — нет). */
const isTextField = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && !/^(checkbox|radio|file|range|button|submit|reset|color|image)$/.test((el as HTMLInputElement).type)));

/**
 * Флаг keyboard (проверка 15 окт): на Android клавиатура сжимает окно, и fixed-панель вкладок с «+» поднимались над
 * ней и закрывали поле (пароль Moodle в «Журнале», поиск группы в «Плане»). Клавиатура открыта, если в фокусе текстовое
 * поле и видимая область заметно ниже самой большой за сеанс (visualViewport: на iPhone окно не сжимается).
 */
export function useKeyboardFlag() {
  useEffect(() => {
    let maxH = 0;
    const upd = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      maxH = Math.max(maxH, h);
      const keyboard = isTextField(document.activeElement) && h < maxH - 120;
      if (keyboard !== useUi.getState().keyboard) useUi.setState({ keyboard });
    };
    // Уход фокуса — на следующем такте: при переходе между полями focusout приходит раньше focusin, и панель мигала бы.
    const later = () => setTimeout(upd, 0);
    // Поворот экрана меняет «полную» высоту — меряем заново.
    const rotate = () => { maxH = 0; later(); };
    const portrait = matchMedia("(orientation: portrait)");
    upd();
    window.visualViewport?.addEventListener("resize", upd);
    window.addEventListener("resize", upd);
    document.addEventListener("focusin", upd);
    document.addEventListener("focusout", later);
    portrait.addEventListener("change", rotate);
    return () => {
      window.visualViewport?.removeEventListener("resize", upd);
      window.removeEventListener("resize", upd);
      document.removeEventListener("focusin", upd);
      document.removeEventListener("focusout", later);
      portrait.removeEventListener("change", rotate);
    };
  }, []);
}
