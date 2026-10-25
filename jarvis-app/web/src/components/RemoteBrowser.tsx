import { useCallback, useEffect, useRef, useState } from "react";
import { type LoginSession, clipText, isSpecialKey, mouseButton, streamUrl, toFramePoint } from "../lib/remote-login";
import { apiBase } from "../store/api";
import { usePlatform } from "../store/platform";

/*
 * Просмотрщик удалённого браузера входа (ADR-0005, контракт §3): кадры JPEG с сервера по WebSocket, обратно — мышь,
 * прокрутка и клавиатура в пикселях кадра. Адресной строки нет: перейти на другой сайт отсюда нельзя. Печатный текст,
 * IME и вставка уходят событием text (≤ 4 КБ), управляющие клавиши — key. Кадры и ввод нигде не сохраняются: последний
 * кадр живёт как blob: URL и освобождается при следующем. Поток аутентифицируется одноразовым тикетом (30 с).
 */

type Props = {
  loginId: string;
  onStatus(login: LoginSession): void;
  onClosed?(reason: string): void;
};

export function RemoteBrowser({ loginId, onStatus, onClosed }: Props) {
  const ws = useRef<WebSocket | null>(null);
  const frameUrl = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const composing = useRef(false);
  const lastMove = useRef(0);
  const [frame, setFrame] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 480, height: 900 });
  const [cursor, setCursor] = useState("default");
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef({ onStatus, onClosed });
  cb.current = { onStatus, onClosed };

  useEffect(() => {
    let alive = true, ping = 0;
    setState("connecting");
    void (async () => {
      try {
        const ticket = await usePlatform.getState().loginTicket(loginId);
        if (!alive) return;
        const sock = new WebSocket(streamUrl(apiBase(), ticket));
        sock.binaryType = "blob";
        ws.current = sock;
        sock.onopen = () => { setState("open"); ping = window.setInterval(() => send({ type: "ping" }), 20_000); };
        sock.onmessage = (e) => {
          if (typeof e.data !== "string") {
            const url = URL.createObjectURL(e.data as Blob);
            if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
            // Первый кадр: окно входа могло открыться ниже края экрана — подводим к нему.
            else requestAnimationFrame(() => box.current?.scrollIntoView({ block: "nearest" }));
            frameUrl.current = url;
            setFrame(url);
            return;
          }
          let m: { type?: string; width?: number; height?: number; login?: LoginSession; cursor?: string; reason?: string };
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.type === "hello" && m.width && m.height) setSize({ width: m.width, height: m.height });
          else if (m.type === "status" && m.login) cb.current.onStatus(m.login);
          else if (m.type === "cursor" && typeof m.cursor === "string") setCursor(/^[a-z-]+$/.test(m.cursor) ? m.cursor : "default");
          else if (m.type === "closed") cb.current.onClosed?.(m.reason ?? "closed");
        };
        sock.onclose = () => { clearInterval(ping); if (alive) setState("closed"); };
      } catch {
        if (alive) setState("closed");
      }
    })();
    return () => {
      alive = false;
      clearInterval(ping);
      ws.current?.close();
      ws.current = null;
      if (frameUrl.current) { URL.revokeObjectURL(frameUrl.current); frameUrl.current = null; }
    };
  }, [loginId, attempt]);

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);
  const point = (e: { clientX: number; clientY: number }) =>
    toFramePoint(e.clientX, e.clientY, img.current!.getBoundingClientRect(), size);

  // Прокрутка: слушатель не passive, чтобы страница приложения не уезжала вместе с колесом.
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); send({ type: "mouse", action: "wheel", ...point(e), dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }); // каждый рендер: size и send в замыкании

  const sendText = (text: string) => { const t = clipText(text); if (t) send({ type: "text", text: t }); };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Удалённый браузер для входа" data-remote-browser={state}>
      <div ref={box} className="relative overflow-hidden rounded-2xl border border-separator bg-raised" style={{ aspectRatio: `${size.width} / ${size.height}`, maxHeight: "70vh" }}>
        {frame ? (
          <img ref={img} src={frame} alt="Экран входа на сайт вуза" width={size.width} height={size.height} draggable={false}
            className="block h-full w-full touch-none select-none object-contain" style={{ cursor }}
            onPointerDown={(e) => { e.preventDefault(); input.current?.focus(); send({ type: "mouse", action: "down", ...point(e), button: mouseButton(e.button) }); }}
            onPointerUp={(e) => send({ type: "mouse", action: "up", ...point(e), button: mouseButton(e.button) })}
            onPointerMove={(e) => { const t = performance.now(); if (t - lastMove.current < 33) return; lastMove.current = t; send({ type: "mouse", action: "move", ...point(e) }); }}
            onContextMenu={(e) => e.preventDefault()} />
        ) : (
          <p className="grid h-full place-items-center p-4 text-center text-s text-hint">{state === "closed" ? "Связь с браузером прервалась." : "Подключаюсь к браузеру…"}</p>
        )}
        {/* Клавиатура: невидимое поле поверх кадра ловит ввод (и на телефоне открывает клавиатуру по нажатию на кадр). */}
        <textarea ref={input} aria-label="Ввод в удалённый браузер" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
          className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
          onKeyDown={(e) => { if (isSpecialKey(e.key)) { e.preventDefault(); send({ type: "key", action: "down", key: e.key, code: e.code }); } }}
          onKeyUp={(e) => { if (isSpecialKey(e.key)) send({ type: "key", action: "up", key: e.key, code: e.code }); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; sendText(e.currentTarget.value); e.currentTarget.value = ""; }}
          onInput={(e) => { if (composing.current) return; sendText(e.currentTarget.value); e.currentTarget.value = ""; }} />
      </div>
      {state === "closed" && (
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="min-h-11 self-start rounded-2xl bg-raised px-4 text-m font-bold">Переподключиться</button>
      )}
      <p className="text-s text-hint">Нажми на окно, чтобы печатать. Это настоящий сайт вуза на сервере Doodle: что ты вводишь, сервер видит только на время входа и не сохраняет.</p>
    </div>
  );
}
