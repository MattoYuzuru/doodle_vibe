import { AnimatePresence, m } from "framer-motion";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { spring } from "../theme/motion";

const useToastStore = create<{ msg: string | null; id: number; show(msg: string): void }>((set) => ({
  msg: null, id: 0, show: (msg) => set((s) => ({ msg, id: s.id + 1 })),
}));

/** Короткое стеклянное уведомление сверху: toast("Отмечено сданным"). */
export const toast = (msg: string) => useToastStore.getState().show(msg);

export function Toast() {
  const { msg, id } = useToastStore();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!msg) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1800);
    return () => clearTimeout(t);
  }, [id, msg]);
  return (
    <AnimatePresence>
      {visible && (
        <m.div
          key={id}
          role="status"
          className="glass fixed left-1/2 z-[60] rounded-full px-4 py-2.5 text-s font-bold whitespace-nowrap"
          style={{ top: "calc(12px + var(--safe-top))" }}
          initial={{ y: -48, x: "-50%", opacity: 0 }} animate={{ y: 0, x: "-50%", opacity: 1 }} exit={{ y: -48, x: "-50%", opacity: 0 }}
          transition={spring(420, 32)}
        >
          {msg}
        </m.div>
      )}
    </AnimatePresence>
  );
}
