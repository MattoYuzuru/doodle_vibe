// Облегчённый режим для слабых телефонов: без размытия стекла, преломления и лишних анимаций (класс lite на <html>).
// Включается сам: мало ядер или памяти, системное «уменьшить движение», либо приложение заметно тормозит в первые
// секунды (замер кадров запоминается на телефоне). ?lite=1 / ?lite=0 — включить или выключить вручную (запоминается).
const KEY = "jarvis.lite";
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* приватный режим */ } };

const forced = new URLSearchParams(location.search).get("lite");
if (forced === "1" || forced === "0") save(forced === "1" ? "on" : "off");
const stored = read();

const nav = navigator as Navigator & { deviceMemory?: number };
// На iPhone Safari занижает число ядер (защита от отпечатка) — там решает только замер кадров.
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const weakHardware = !ios && ((nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 3);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const lite = stored === "on" || stored === "slow" || (stored !== "off" && (weakHardware || reducedMotion));
if (lite) document.documentElement.classList.add("lite");

// Замер плавности: 4 с после запуска; если средний кадр дольше 33 мс (меньше 30 к/с), со следующего запуска — lite.
if (!lite && stored !== "off" && stored !== "fast") {
  let frames = 0, slow = 0, last = 0;
  const start = performance.now();
  const tick = (t: number) => {
    if (last) { frames++; if (t - last > 34) slow++; }
    last = t;
    if (t - start < 4000) requestAnimationFrame(tick);
    else if (frames > 20 && !document.hidden) save(slow / frames > 0.35 ? "slow" : "fast");
  };
  setTimeout(() => requestAnimationFrame(tick), 800);
}
