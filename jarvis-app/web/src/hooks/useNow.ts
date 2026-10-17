import { useSyncExternalStore } from "react";

/*
 * Один общий тикер на каждый интервал (проверка 15 окт). Раньше у каждого экрана был свой setInterval со своей фазой:
 * три смонтированные вкладки перерисовывались в разные моменты, каждая — со своей сортировкой дедлайнов, и короткие
 * подлаги при прокрутке случались втрое чаще. Теперь все подписчики обновляются одним проходом на границе интервала
 * (12:00:00, 12:00:30…), а значение меняется, только когда интервал сменился.
 */
interface Ticker { now: number; timer: number; subs: Set<() => void>; subscribe(cb: () => void): () => void; get(): number }
const tickers = new Map<number, Ticker>();
const slot = (t: number, ms: number) => Math.floor(t / ms);

function tickerOf(ms: number): Ticker {
  const found = tickers.get(ms);
  if (found) return found;
  const k: Ticker = {
    now: Date.now(),
    timer: 0,
    subs: new Set(),
    subscribe(cb) {
      k.subs.add(cb);
      if (!k.timer) arm();
      return () => {
        k.subs.delete(cb);
        if (!k.subs.size) { clearTimeout(k.timer); k.timer = 0; }
      };
    },
    // Пока тикер стоит (подписчиков не было), значение могло устареть — освежаем, но только при смене интервала:
    // React зовёт get() несколько раз за отрисовку и ждёт одно и то же число.
    get() {
      if (!k.timer && slot(Date.now(), ms) !== slot(k.now, ms)) k.now = Date.now();
      return k.now;
    },
  };
  const fire = () => { k.now = Date.now(); k.subs.forEach((cb) => cb()); };
  // До ближайшей границы интервала (+20 мс, чтобы точно оказаться за ней).
  const arm = () => { k.timer = window.setTimeout(() => { fire(); arm(); }, ms - (Date.now() % ms) + 20); };
  tickers.set(ms, k);
  return k;
}

// Свёрнутый Telegram: таймеры в фоне спят — при возвращении время освежаем сразу, а не на следующем тике.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  for (const [ms, k] of tickers) {
    if (k.subs.size && slot(Date.now(), ms) !== slot(k.now, ms)) { k.now = Date.now(); k.subs.forEach((cb) => cb()); }
  }
});

/** Текущее время, обновляется раз в intervalMs (по умолчанию 30 секунд — для обратного отсчёта). */
export function useNow(intervalMs = 30_000) {
  const k = tickerOf(intervalMs);
  return useSyncExternalStore(k.subscribe, k.get);
}
