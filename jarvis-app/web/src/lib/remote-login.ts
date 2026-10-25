/*
 * Вход через удалённый браузер (ADR-0005, docs/architecture/auth-sessions-contract.md §1–§3): чистые помощники для
 * экрана — тексты состояний, адрес потока, пересчёт координат из показанной картинки в пиксели кадра и какие клавиши
 * уходят событием «key» (печатные символы, IME и вставка уходят «text»). Без сети, DOM и таймеров.
 */

export type LoginMode = "interactive" | "password";
export type LoginStatus = "starting" | "awaiting_user" | "filling" | "awaiting_mfa" | "capturing" | "succeeded" | "failed" | "cancelled" | "expired";
export interface LoginSession {
  id: string; connectionId: string; mode: LoginMode; status: LoginStatus; errorCode: string | null;
  createdAt: string; expiresAt: string; idleExpiresAt: string | null;
  viewport: { width: number; height: number };
  url: string | null;
  mfa: { kind: "totp" | "code"; attemptsLeft: number } | null;
}
export interface LoginTicket { ticket: string; expiresAt: string; path: string }

export const TERMINAL: readonly LoginStatus[] = ["succeeded", "failed", "cancelled", "expired"];
export const isTerminal = (s: LoginStatus) => TERMINAL.includes(s);

export const STATUS_TEXT: Record<LoginStatus, string> = {
  starting: "Запускаю браузер…",
  awaiting_user: "Войди на сайт вуза в окне ниже — как обычно, со своим паролем и кодом.",
  filling: "Ввожу логин и пароль на сайте вуза…",
  awaiting_mfa: "Сайт просит код подтверждения.",
  capturing: "Вход выполнен, сохраняю сессию…",
  succeeded: "Вход сохранён. Загружаю данные…",
  failed: "Вход не удался.",
  cancelled: "Вход отменён.",
  expired: "Время на вход истекло.",
};

/** Код MFA по контракту: 4–12 символов из цифр, латиницы, пробела и дефиса. */
export const MFA_CODE = /^[0-9A-Za-z -]{4,12}$/;

/** Адрес WebSocket потока: тот же сервер, что у приложения; ws:// для http, wss:// для https; тикет — параметром. */
export function streamUrl(appBase: string, t: Pick<LoginTicket, "path" | "ticket">): string {
  const u = new URL(t.path.replace(/^\//, ""), appBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("ticket", t.ticket);
  return u.toString();
}

/** Точка нажатия на показанной картинке → пиксели кадра (сервер сам ограничивает по width×height). */
export function toFramePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, frame: { width: number; height: number }) {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const clamp = (v: number, max: number) => Math.min(Math.max(Math.round(v), 0), Math.max(max - 1, 0));
  return {
    x: clamp(((clientX - rect.left) / rect.width) * frame.width, frame.width),
    y: clamp(((clientY - rect.top) / rect.height) * frame.height, frame.height),
  };
}

/** Клавиши, которые уходят событием key (управляющие); всё печатное — через text. */
const SPECIAL = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
export const isSpecialKey = (key: string) => SPECIAL.has(key);

/** Кнопка мыши для потока. */
export const mouseButton = (b: number): "left" | "middle" | "right" => (b === 1 ? "middle" : b === 2 ? "right" : "left");

/** Вставка не длиннее 4 КБ (UTF-8) — по контракту; лишнее отрезается по символам. */
export function clipText(text: string, maxBytes = 4096): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let out = "";
  for (const ch of text) { if (enc.encode(out + ch).length > maxBytes) break; out += ch; }
  return out;
}

/** Сколько осталось секунд до конца сессии (для подписи «осталось 4:30»), не меньше 0. */
export const secondsLeft = (expiresAt: string, nowMs: number) => Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
