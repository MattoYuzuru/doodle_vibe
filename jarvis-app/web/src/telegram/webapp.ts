// Обёртка над Telegram.WebApp. Вне Telegram (в обычном браузере) всё работает, но без системных кнопок и вибро.

type Cb = () => void;
type CloudCb<T> = (err: string | null, value?: T) => void;

interface TgButton {
  show(): void; hide(): void; enable(): void; disable(): void;
  setParams(p: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }): void;
  onClick(cb: Cb): void; offClick(cb: Cb): void;
  showProgress?(leaveActive?: boolean): void; hideProgress?(): void;
}
export interface TgCloudStorage {
  setItem(key: string, value: string, cb?: CloudCb<boolean>): void;
  getItem(key: string, cb: CloudCb<string>): void;
  getItems(keys: string[], cb: CloudCb<Record<string, string>>): void;
  removeItems(keys: string[], cb?: CloudCb<boolean>): void;
}
interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name: string; last_name?: string; username?: string; photo_url?: string } };
  colorScheme: "light" | "dark";
  version: string;
  ready(): void; expand(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor(c: string): void; setBackgroundColor(c: string): void; setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  onEvent(e: string, cb: Cb): void;
  offEvent?(e: string, cb: Cb): void;
  /** Bot API 8.0+: мини-приложение на экране (false — свёрнуто в Telegram). */
  isActive?: boolean;
  BackButton: TgButton;
  MainButton: TgButton;
  HapticFeedback: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  CloudStorage: TgCloudStorage;
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  /** Bot API 6.2: всплывающее окно с кнопками; в cb приходит id нажатой кнопки. */
  showPopup?(params: { title?: string; message: string; buttons: { id?: string; type?: "default" | "ok" | "close" | "cancel" | "destructive"; text?: string }[] }, cb?: (id: string) => void): void;
  openLink?(url: string): void;
  /** Bot API 8.0: ярлык на экран телефона. */
  addToHomeScreen?(): void;
  checkHomeScreenStatus?(cb: (status: "unsupported" | "unknown" | "added" | "missed") => void): void;
}
declare global {
  interface Window { Telegram?: { WebApp: TgWebApp } }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp;
/** Открыто ли приложение действительно внутри Telegram (а не просто подключён скрипт). */
export const inTelegram = !!tg?.initData;

/** Цвет фона страницы в виде #RRGGBB — чтобы шапка Telegram совпадала с темой приложения, а не с темой Telegram. */
function pageHex(): string | null {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  return m && m.length >= 3 ? "#" + m.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("") : null;
}

/** По умолчанию тема светлая — независимо от темы Telegram и системы. Тёмная — по выбору в меню совы (запоминается) или ?scheme=dark. */
function applyScheme(scheme: "light" | "dark" = "light") {
  document.documentElement.dataset.scheme = scheme;
  if (inTelegram) {
    try {
      const hex = pageHex() ?? (scheme === "dark" ? "#111a2e" : "#ffffff");
      tg!.setHeaderColor(hex);
      tg!.setBackgroundColor(hex);
      tg!.setBottomBarColor?.(hex);
    } catch { /* старый клиент */ }
  }
}

export function initTelegram() {
  if (tg && inTelegram) {
    tg.ready();
    tg.expand();
    // Иначе жест «потянуть вниз» закрывает приложение и мешает pull-to-refresh.
    try { tg.disableVerticalSwipes?.(); } catch { /* старый клиент */ }
  }
  // ?scheme=light|dark — для проверки дизайна вне Telegram; иначе — выбор пользователя из меню совы.
  const forced = new URLSearchParams(location.search).get("scheme");
  applyScheme((forced ?? savedScheme()) === "dark" ? "dark" : "light");
}

const SCHEME_KEY = "doodle-scheme";
function savedScheme() { try { return localStorage.getItem(SCHEME_KEY); } catch { return null; } }
/** Смена темы на лету (меню совы): атрибут на <html>, цвета шапки Telegram, запоминание; подписчики useScheme перерисуются. */
export function setScheme(scheme: "light" | "dark") {
  applyScheme(scheme);
  try { localStorage.setItem(SCHEME_KEY, scheme); } catch { /* приватный режим */ }
  window.dispatchEvent(new Event("schemechange"));
}

export const haptic = {
  tap: () => { try { if (inTelegram) tg!.HapticFeedback.impactOccurred("light"); } catch { /* нет вибро */ } },
  select: () => { try { if (inTelegram) tg!.HapticFeedback.selectionChanged(); } catch { /* нет вибро */ } },
  success: () => { try { if (inTelegram) tg!.HapticFeedback.notificationOccurred("success"); } catch { /* нет вибро */ } },
  warning: () => { try { if (inTelegram) tg!.HapticFeedback.notificationOccurred("warning"); } catch { /* нет вибро */ } },
};

export function telegramUser() {
  const u = tg?.initDataUnsafe?.user;
  return {
    firstName: u?.first_name ?? "",
    lastName: u?.last_name ?? "",
    photoUrl: u?.photo_url,
  };
}

/** CloudStorage доступен с версии 6.9. */
export const cloudStorage = inTelegram && tg!.isVersionAtLeast("6.9") ? tg!.CloudStorage : null;

/** Ярлык на главный экран телефона (Bot API 8.0+). Возвращает статус или null, если клиент не умеет. */
export function homeScreenStatus(): Promise<"unsupported" | "unknown" | "added" | "missed" | null> {
  if (!inTelegram || !tg!.checkHomeScreenStatus || !tg!.isVersionAtLeast("8.0")) return Promise.resolve(null);
  return new Promise((r) => { try { tg!.checkHomeScreenStatus!((s) => r(s)); } catch { r(null); } });
}
export function addToHomeScreen() { try { tg?.addToHomeScreen?.(); } catch { /* старый клиент */ } }

export function confirmDialog(message: string): Promise<boolean> {
  // showConfirm есть с Bot API 6.2; в старом клиенте вызов бросает исключение — тогда обычный confirm, а не «кнопка не работает».
  // Telegram принимает в showConfirm не больше 256 знаков и на более длинный текст тоже бросает исключение. Раньше оно
  // возникало внутри Promise и уходило мимо catch: 1 окт 2026 «Прикрепить черновик» с длинным вопросом молча ничего не делал.
  if (inTelegram) {
    const text = message.length > 256 ? `${message.slice(0, 255)}…` : message;
    return new Promise((resolve) => {
      try { tg!.showConfirm(text, resolve); }
      catch { try { resolve(window.confirm(message)); } catch { resolve(false); } }
    });
  }
  return Promise.resolve(window.confirm(message));
}
