// «Чёрный ящик» запуска: если приложение упало до первого кадра (ошибка в скрипте, старый WebView без нужных API,
// не загрузился модуль), показываем текст ошибки и версию сборки вместо пустого экрана — иначе с телефона не понять, что случилось.
const started = Date.now();
let painted = false;

export function markPainted() { painted = true; }
// requestAnimationFrame в фоновой или свёрнутой вкладке не срабатывает (WebView открыли и свернули Telegram) — тогда
// флаг painted так и не ставился, и через 8 с сторож сносил уже нарисованное приложение. Поэтому смотрим и на сам root.
const rendered = () => painted || (document.getElementById("root")?.childElementCount ?? 0) > 0;

function show(title: string, detail: string) {
  if (rendered()) return;
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText = "padding:24px 16px;font:15px/1.45 system-ui,sans-serif;color:#fff;background:#000;min-height:100vh;box-sizing:border-box";
  const h = document.createElement("h1"); h.style.cssText = "font-size:20px;margin:0 0 8px"; h.textContent = title;
  const p = document.createElement("pre"); p.style.cssText = "white-space:pre-wrap;word-break:break-word;font:13px/1.4 monospace;color:#ff8a80;background:#1c1c1e;padding:12px;border-radius:12px"; p.textContent = detail;
  const meta = document.createElement("p"); meta.style.cssText = "color:#8e8e93;font-size:13px"; meta.textContent = `UA: ${navigator.userAgent}\nсборка: ${document.querySelector('script[src*="assets/"]')?.getAttribute("src") ?? "?"}`;
  const btn = document.createElement("button"); btn.textContent = "Перезагрузить"; btn.style.cssText = "margin-top:16px;min-height:44px;padding:0 20px;border:0;border-radius:12px;background:#2f7bf6;color:#fff;font:600 16px system-ui";
  btn.onclick = () => location.reload();
  box.append(h, p, meta, btn);
  root.append(box);
}

window.addEventListener("error", (e) => show("Приложение не запустилось", `${e.message}\n${e.filename ?? ""}:${e.lineno ?? ""}`));
window.addEventListener("unhandledrejection", (e) => show("Ошибка при запуске", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
// Если через 8 секунд ничего не нарисовано и ошибок не было — тоже сообщаем (например, завис запрос к облаку).
setTimeout(() => { if (!rendered()) show("Приложение не отрисовалось", `За ${Math.round((Date.now() - started) / 1000)} с не появился первый экран. Ошибок в скрипте не было.`); }, 8000);
