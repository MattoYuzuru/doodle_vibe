// Облегчённый режим для слабых телефонов: без размытия стекла, преломления и лишних анимаций (класс lite на <html>).
// Включается сам: мало ядер или памяти, системное «уменьшить движение», либо телефон заметно рвёт кадры во время
// прокрутки (замер копится на телефоне и применяется со следующего запуска). ?lite=1 / ?lite=0 — включить или выключить
// вручную (запоминается).
const KEY = "jarvis.lite";
const STATS = "jarvis.lite.frames";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

const forced = new URLSearchParams(location.search).get("lite");
if (forced === "1" || forced === "0") save(KEY, forced === "1" ? "on" : "off");
const stored = read(KEY);

const nav = navigator as Navigator & { deviceMemory?: number };
// На iPhone Safari занижает число ядер (защита от отпечатка) — там решает только замер кадров.
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const weakHardware = !ios && ((nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 3);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Сборка — имя файла с этим кодом: в выкладке в нём хэш содержимого, после обновления он другой.
const BUILD = import.meta.url.split("/").pop()?.split("?")[0] ?? "";
// «slow:<время>» — вердикт замера, держится неделю, потом меряем снова (телефон могли сменить, приложение — ускорить).
// Просто «slow» — от прежнего замера при запуске, его оставляем как есть.
const SLOW_TTL = 7 * 24 * 3600e3;
const slowAt = /^slow:(\d+)/.exec(stored ?? "");
const slowFresh = stored === "slow" || (!!slowAt && Date.now() - Number(slowAt[1]) < SLOW_TTL);

export const lite = stored === "on" || slowFresh || (stored !== "off" && (weakHardware || reducedMotion));
if (lite) document.documentElement.classList.add("lite");

/** Ручной выбор из меню совы. Режим читается при запуске во многих местах, поэтому после выбора — перезапуск страницы. */
export function setLite(on: boolean) {
  save(KEY, on ? "on" : "off");
  location.reload();
}

/*
 * Замер плавности (проверка 15 окт). Раньше кадры мерились 0,8–4,8 с после запуска, когда никто не листает и кадры
 * пустые, — почти всегда выходило «fast», и это записывалось навсегда. Теперь меряем только во время прокрутки (и 150 мс
 * после неё), пропуская первые 5 с после запуска и свёрнутое приложение; кадры копятся между запусками. Набралось
 * 300 кадров и больше 20 % из них дольше 25 мс — «slow»: облегчённый режим со следующего запуска. Посреди сеанса не
 * переключаем: свечение фона, рамки и прозрачность стекла поменялись бы прямо во время листания — выглядит как сбой.
 * «fast» хранится с датой и сборкой: через 3 дня или после обновления приложения меряем снова.
 * На iPhone прокрутку ведёт отдельный процесс и rAF рывки отражает плохо — это в основном страховка для Android.
 * Медленный кадр — относительно обычного кадра своей серии (не короче 25 мс): в энергосбережении iPhone rAF урезан до
 * 30 к/с, все кадры ~33 мс — это не рывки. Серию, где даже самый быстрый кадр дольше 25 мс (частота урезана), не считаем.
 */
const FAST_TTL = 3 * 24 * 3600e3;
const fast = /^fast:(\d+):(.*)$/.exec(stored ?? "");
const fastFresh = !!fast && fast[2] === BUILD && Date.now() - Number(fast[1]) < FAST_TTL;

if (!lite && stored !== "off" && !fastFresh) {
  const t0 = performance.now();
  let acc = { frames: 0, slow: 0 };
  try { acc = { ...acc, ...JSON.parse(read(STATS) ?? "{}") }; } catch { /* испорчено — начнём заново */ }
  let sampling = false, lastScroll = 0, last = 0, dts: number[] = [];
  const finish = () => {
    sampling = false;
    const series = dts;
    dts = [];
    if (!series.length) return;
    const minDt = Math.min(...series);
    if (minDt > 25) return; // частота кадров урезана системой — не рывки
    acc.frames += series.length;
    acc.slow += series.filter((dt) => dt > Math.max(25, 1.5 * minDt)).length;
    if (acc.frames < 300) { save(STATS, JSON.stringify(acc)); return; }
    save(KEY, acc.slow / acc.frames > 0.2 ? `slow:${Date.now()}` : `fast:${Date.now()}:${BUILD}`);
    try { localStorage.removeItem(STATS); } catch { /* приватный режим */ }
    window.removeEventListener("scroll", onScroll, true);
  };
  const tick = (t: number) => {
    if (document.hidden) return finish();
    if (last) dts.push(t - last);
    last = t;
    if (t - lastScroll < 150) requestAnimationFrame(tick); else finish();
  };
  const onScroll = () => {
    lastScroll = performance.now();
    if (sampling || document.hidden || lastScroll - t0 < 5000) return;
    sampling = true;
    last = 0;
    requestAnimationFrame(tick);
  };
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
}
