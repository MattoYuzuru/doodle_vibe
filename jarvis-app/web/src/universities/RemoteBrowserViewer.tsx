import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiV1Client, LoginSession, StreamClientMessage, StreamServerMessage } from "../api/v1";
import { loginStreamUrl } from "../api/v1";

/*
 * Просмотрщик удалённого браузера (docs/architecture/auth-sessions-contract.md §3). Сервер присылает JPEG-кадры (binary)
 * и JSON-события; мы отправляем мышь, клавиши и текст в пикселях кадра. Адресной строки нет: URL навигации клиент
 * передать не может. Ввод и кадры нигде не сохраняются и не логируются; тикет одноразовый (30 с), берётся на каждое подключение.
 */

const MOVE_INTERVAL_MS = 40; // ≤ 25 событий/с — запас до лимита сервера в 60/с
const PING_MS = 20_000;
const MAX_TEXT = 4000; // лимит сервера — 4 КБ
const TAP_SLOP = 8;
const CURSORS = new Set(["default", "pointer", "text", "move", "wait", "progress", "not-allowed", "grab", "grabbing", "crosshair", "help", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "col-resize", "row-resize", "zoom-in", "zoom-out", "context-menu", "vertical-text", "cell", "alias", "copy", "no-drop", "all-scroll"]);
const BUTTONS = ["left", "middle", "right"] as const;

type Link = "connecting" | "live" | "reconnecting" | "lost" | "closed";
interface Props {
  client: ApiV1Client;
  loginId: string;
  /** Состояние входа из потока: родитель обновляет экран без ожидания опроса. */
  onStatus: (login: LoginSession) => void;
  /** Сервер закрыл поток (вход завершён или сессия забыта). */
  onClosed?: (reason: string) => void;
}

export function RemoteBrowserViewer({ client, loginId, onStatus, onClosed }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLInputElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const callbacks = useRef({ onStatus, onClosed });
  callbacks.current = { onStatus, onClosed };
  const [link, setLink] = useState<Link>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [cursor, setCursor] = useState("default");
  const [freeText, setFreeText] = useState("");
  const [hideText, setHideText] = useState(true);

  const send = useCallback((message: StreamClientMessage) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let decoding = false;
    let pending: Blob | null = null;
    let finished = false;

    const paint = async (blob: Blob) => {
      if (decoding) { pending = blob; return; }
      decoding = true;
      try {
        const bitmap = await createImageBitmap(blob);
        const el = canvas.current;
        if (el && !disposed) {
          if (el.width !== bitmap.width || el.height !== bitmap.height) { el.width = bitmap.width; el.height = bitmap.height; }
          el.getContext("2d")?.drawImage(bitmap, 0, 0);
          setHasFrame(true);
        }
        bitmap.close();
      } catch { /* битый кадр пропускаем */ }
      decoding = false;
      if (pending) { const next = pending; pending = null; void paint(next); }
    };

    const connect = async (n: number) => {
      try {
        const ticket = await client.loginTicket(loginId);
        if (disposed) return;
        ws = new WebSocket(loginStreamUrl(ticket, location));
        ws.binaryType = "blob";
        socket.current = ws;
        ws.onopen = () => { setLink("live"); ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, PING_MS); };
        ws.onmessage = (event) => {
          if (typeof event.data !== "string") { void paint(event.data as Blob); return; }
          let message: StreamServerMessage;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "hello") {
            const el = canvas.current;
            if (el && message.width > 0 && message.height > 0 && message.width <= 4096 && message.height <= 4096) { el.width = message.width; el.height = message.height; }
          } else if (message.type === "status") callbacks.current.onStatus(message.login);
          else if (message.type === "cursor") setCursor(CURSORS.has(message.cursor) ? message.cursor : "default");
          else if (message.type === "closed") { finished = true; setLink("closed"); callbacks.current.onClosed?.(message.reason); }
        };
        ws.onclose = () => {
          clearInterval(ping);
          if (disposed || finished) return;
          if (n < 3) { setLink("reconnecting"); retry = setTimeout(() => void connect(n + 1), 800 * (n + 1)); } else setLink("lost");
        };
      } catch {
        if (disposed) return;
        if (n < 3) { setLink("reconnecting"); retry = setTimeout(() => void connect(n + 1), 800 * (n + 1)); } else setLink("lost");
      }
    };
    setLink("connecting");
    void connect(0);
    return () => { disposed = true; clearInterval(ping); clearTimeout(retry); socket.current = null; ws?.close(); };
  }, [client, loginId, attempt]);

  // Колесо: нужен не пассивный слушатель, иначе страница под кадром тоже прокрутится.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toFrame(el, e.clientX, e.clientY);
      send({ type: "mouse", action: "wheel", x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [send]);

  // Нативный beforeinput (React-овый onBeforeInput — другое событие): символы, Backspace и перевод строки с экранных клавиатур.
  useEffect(() => {
    const el = keys.current;
    if (!el) return;
    const onBefore = (ev: InputEvent) => {
      if (ev.isComposing) return;
      if (ev.inputType === "insertText" && ev.data) { ev.preventDefault(); send({ type: "text", text: ev.data.slice(0, MAX_TEXT) }); }
      else if (ev.inputType === "deleteContentBackward") { ev.preventDefault(); send({ type: "key", action: "down", key: "Backspace", code: "Backspace" }); send({ type: "key", action: "up", key: "Backspace", code: "Backspace" }); }
      else if (ev.inputType === "insertLineBreak" || ev.inputType === "insertParagraph") { ev.preventDefault(); send({ type: "key", action: "down", key: "Enter", code: "Enter" }); send({ type: "key", action: "up", key: "Enter", code: "Enter" }); }
    };
    el.addEventListener("beforeinput", onBefore);
    return () => el.removeEventListener("beforeinput", onBefore);
  }, [send]);

  const drag = useRef<{ id: number; touch: boolean; x: number; y: number; moved: boolean; lastMove: number } | null>(null);
  const down = useRef(new Set<string>());

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    keys.current?.focus({ preventScroll: true });
    const touch = e.pointerType === "touch" || e.pointerType === "pen";
    drag.current = { id: e.pointerId, touch, x: e.clientX, y: e.clientY, moved: false, lastMove: 0 };
    if (!touch) {
      const p = toFrame(el, e.clientX, e.clientY);
      send({ type: "mouse", action: "move", x: p.x, y: p.y });
      send({ type: "mouse", action: "down", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left" });
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const d = drag.current;
    const now = performance.now();
    if (d && d.id === e.pointerId && d.touch) {
      // Касание: короткое — нажатие, протяжка — прокрутка страницы в кадре.
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < TAP_SLOP) return;
      const scale = el.width / el.getBoundingClientRect().width;
      const p = toFrame(el, e.clientX, e.clientY);
      send({ type: "mouse", action: "wheel", x: p.x, y: p.y, dx: Math.round((d.x - e.clientX) * scale), dy: Math.round((d.y - e.clientY) * scale) });
      d.x = e.clientX; d.y = e.clientY; d.moved = true;
      return;
    }
    if (now - (d?.lastMove ?? 0) < MOVE_INTERVAL_MS) return;
    if (d) d.lastMove = now;
    const p = toFrame(el, e.clientX, e.clientY);
    send({ type: "mouse", action: "move", x: p.x, y: p.y });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const d = drag.current;
    drag.current = null;
    keys.current?.focus({ preventScroll: true }); // экранная клавиатура открывается по жесту пользователя
    const p = toFrame(el, e.clientX, e.clientY);
    if (d?.touch) {
      if (!d.moved) {
        send({ type: "mouse", action: "move", x: p.x, y: p.y });
        send({ type: "mouse", action: "down", x: p.x, y: p.y, button: "left" });
        send({ type: "mouse", action: "up", x: p.x, y: p.y, button: "left" });
      }
      return;
    }
    send({ type: "mouse", action: "up", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left" });
  };

  const sendText = (text: string) => { if (text) send({ type: "text", text: text.slice(0, MAX_TEXT) }); };
  const tap = (key: string) => { send({ type: "key", action: "down", key, code: key }); send({ type: "key", action: "up", key, code: key }); };

  // Клавиатура: символы уходят текстом (работает с экранной клавиатурой, IME и вставкой), служебные клавиши — как key.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Unidentified" || e.keyCode === 229) return;
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (!modified && e.key.length === 1) return; // дойдёт до beforeinput как текст
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // вставка придёт событием paste
    e.preventDefault();
    down.current.add(e.code);
    send({ type: "key", action: "down", key: e.key, code: e.code });
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!down.current.delete(e.code)) return;
    e.preventDefault();
    send({ type: "key", action: "up", key: e.key, code: e.code });
  };
  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => { sendText(e.data); e.currentTarget.value = ""; };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => { e.preventDefault(); sendText(e.clipboardData.getData("text")); };

  const live = link === "live";
  return (
    <div className="flex flex-col gap-2" data-remote-viewer={link}>
      <div className="relative overflow-hidden rounded-2xl bg-raised" style={{ aspectRatio: hasFrame ? undefined : "480 / 640" }}>
        <canvas
          ref={canvas} width={480} height={640} role="img" aria-label="Удалённый браузер со страницей входа вуза" data-remote-canvas
          className="block h-auto w-full max-w-full select-none"
          style={{ touchAction: "none", cursor, visibility: hasFrame ? "visible" : "hidden", position: hasFrame ? "static" : "absolute" }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }}
          onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}
        />
        {/* Скрытое поле: на телефоне нажатие по кадру открывает экранную клавиатуру, на ПК сюда приходят клавиши. */}
        <input
          ref={keys} aria-label="Ввод с клавиатуры в удалённый браузер" data-remote-keys autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="absolute top-0 left-0 size-px opacity-0" onKeyDown={onKeyDown} onKeyUp={onKeyUp}
          onCompositionEnd={onCompositionEnd} onPaste={onPaste}
        />
        {!hasFrame && (
          <p role="status" className="absolute inset-0 grid place-items-center px-4 text-center text-m font-semibold text-hint">
            {link === "lost" ? "Соединение потеряно." : link === "closed" ? "Поток закрыт." : "Подключаюсь к удалённому браузеру…"}
          </p>
        )}
      </div>
      {link === "reconnecting" && <p role="status" className="text-s font-semibold text-hint">Переподключаюсь…</p>}
      {(link === "lost" || link === "closed") && (
        <div className="flex items-center gap-2">
          <p role="alert" className="flex-1 text-s font-semibold text-red">{link === "lost" ? "Соединение с браузером потеряно." : "Сервер закрыл поток."}</p>
          {link === "lost" && <button type="button" className="min-h-11 rounded-2xl bg-raised px-3 text-s font-bold" onClick={() => { setHasFrame(false); setAttempt((n) => n + 1); }}>Переподключить</button>}
        </div>
      )}
      <p className="text-s text-hint">Нажимай на кадр как на обычной странице, прокручивай протяжкой. Страница вуза открыта на сервере: любой способ входа, MFA и капчу вводишь ты.</p>
      <form className="flex flex-wrap items-center gap-2" aria-label="Ввод текста в браузер" onSubmit={(e) => { e.preventDefault(); sendText(freeText); setFreeText(""); }}>
        <label className="sr-only" htmlFor={`remote-text-${loginId}`}>Текст для ввода</label>
        <input id={`remote-text-${loginId}`} type={hideText ? "password" : "text"} value={freeText} onChange={(e) => setFreeText(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder="Текст для поля на странице" className="min-h-11 min-w-0 flex-1 basis-40 rounded-2xl bg-raised px-3 text-m text-text outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <button type="submit" disabled={!live || !freeText} className="min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50">Ввести</button>
        <label className="flex min-h-11 items-center gap-2 text-s font-semibold text-hint">
          <input type="checkbox" checked={hideText} onChange={(e) => setHideText(e.target.checked)} /> Скрывать символы
        </label>
      </form>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Клавиши">
        {["Enter", "Tab", "Escape", "Backspace"].map((key) => (
          <button key={key} type="button" disabled={!live} onClick={() => tap(key)} className="min-h-11 rounded-2xl bg-raised px-3 text-s font-bold disabled:opacity-50">{key === "Escape" ? "Esc" : key}</button>
        ))}
      </div>
    </div>
  );
}

/** Координаты указателя в пикселях кадра (канвас масштабируется по ширине экрана). */
function toFrame(el: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = el.getBoundingClientRect();
  const x = ((clientX - rect.left) * el.width) / (rect.width || 1);
  const y = ((clientY - rect.top) * el.height) / (rect.height || 1);
  return { x: Math.max(0, Math.min(el.width - 1, Math.round(x))), y: Math.max(0, Math.min(el.height - 1, Math.round(y))) };
}
