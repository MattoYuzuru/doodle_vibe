import { useSyncExternalStore } from "react";

/** Текущая тема ("light" | "dark") с перерисовкой при смене через setScheme (telegram/webapp.ts). */
const get = () => (document.documentElement.dataset.scheme === "dark" ? "dark" : "light") as "light" | "dark";
const subscribe = (cb: () => void) => {
  window.addEventListener("schemechange", cb);
  return () => window.removeEventListener("schemechange", cb);
};
export const useScheme = () => useSyncExternalStore(subscribe, get);
