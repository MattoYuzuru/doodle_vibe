import { useEffect } from "react";
import { create } from "zustand";

/** Общее состояние интерфейса: компактная панель при прокрутке вниз (как в iOS 26) и удержание ползунка вкладок. */
export const useUi = create<{ compact: boolean; dragging: boolean; exitDir: 1 | -1 }>(() => ({ compact: false, dragging: false, exitDir: 1 }));

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
