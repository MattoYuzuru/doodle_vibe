import { motionValue } from "framer-motion";

/**
 * Положение линзы на панели вкладок в «вкладках» (0 — Главная … 3 — Журнал), непрерывное.
 * Панель пишет сюда позицию (со своей пружиной), лента экранов в App читает и едет синхронно.
 */
export const lensProgress = motionValue(0);

/**
 * Прямое управление линзой снаружи (свайп от края экрана в App: TabTrack): панель вкладок регистрирует здесь
 * функцию, которая ставит линзу в положение p (во «вкладках») без пружины — так лента и линза едут вместе.
 */
export const lensDrag: { jump: (p: number) => void } = { jump: () => {} };

// Для проверки вне Telegram: в консоли __lens.set(0.5) сдвигает ленту на полэкрана.
if (new URLSearchParams(location.search).has("demo")) (window as unknown as { __lens: typeof lensProgress }).__lens = lensProgress;
