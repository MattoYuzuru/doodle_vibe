import type { Connection } from "../api/v1";

/*
 * Разделы экрана «Вузы»: ВШЭ, МИСИС, ЦУ и «Свой вуз». Пресет — это только заготовка адреса и подсказка, какие поля
 * входа показать заранее; способы входа и сам вход определяет сервер (authMethods). Никаких тестовых данных.
 */

export type SourceKind = Connection["kind"];
export interface PresetSource {
  /** Заготовка адреса: пользователь может её изменить до подключения. */
  url: string;
  kind: SourceKind;
  label: string;
  hint?: string;
  /** Показать поля «логин/пароль» прямо в карточке: их используют, если сервер предложит вход паролем. */
  credentials?: { title: string; login: string };
}
export interface UniversityDef {
  /** universityId пространства (и ключ раздела). */
  id: "hse" | "misis" | "cu" | "custom";
  name: string;
  short: string;
  sources: PresetSource[];
  intro: string;
}

export const UNIVERSITIES: UniversityDef[] = [
  {
    id: "hse", name: "ВШЭ", short: "ВШЭ",
    intro: "Smart LMS и расписание РУЗ. Вход — через удалённый браузер или логин, пароль и код MFA: пароль не хранится, сохраняется только зашифрованная сессия.",
    sources: [
      { url: "https://edu.hse.ru/", kind: "lms", label: "Smart LMS ВШЭ", hint: "Курсы и дедлайны. Вход через SSO ВШЭ.",
        credentials: { title: "Логин и пароль ВШЭ (по желанию)", login: "Почта вида логин@edu.hse.ru" } },
      { url: "https://ruz.hse.ru/", kind: "schedule", label: "РУЗ ВШЭ", hint: "Расписание. Работает только из сети ВШЭ (HSE.Student Wi‑Fi или VPN)." },
    ],
  },
  {
    id: "misis", name: "МИСИС", short: "МИСИС",
    intro: "LMS МИСИС на Moodle: логин и пароль Moodle или токен; запасной путь — ссылка календаря.",
    sources: [
      { url: "https://newlms.misis.ru/", kind: "lms", label: "LMS МИСИС (Moodle)", hint: "Курсы и задания.",
        credentials: { title: "Логин и пароль Moodle (по желанию)", login: "Логин в Moodle" } },
    ],
  },
  {
    id: "cu", name: "ЦУ", short: "ЦУ",
    intro: "Центральный университет: вход в личный кабинет делаешь ты сам в удалённом браузере, дальше данные обновляются сами.",
    sources: [{ url: "https://my.centraluniversity.ru/", kind: "lms", label: "Личный кабинет ЦУ", hint: "Курсы, задания и расписание." }],
  },
  {
    id: "custom", name: "Свой вуз", short: "Свой вуз",
    intro: "Введи адрес LMS или сайта вуза. Сервер сам определит тип сайта и предложит способы входа.",
    sources: [],
  },
];

export const KIND_LABELS: Record<SourceKind, string> = { lms: "LMS / Moodle", schedule: "Расписание", document: "Документ", table: "Таблица", website: "Сайт" };

export const slugify = (name: string) => name.trim().toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "university";

/** Приводит ввод к адресу источника: https, без логина, параметров и якоря. null — адрес не годится. */
export function normalizeSourceUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname.includes(".")) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}

export const originOf = (sourceUrl: string) => new URL(sourceUrl).origin;
export const hostOf = (sourceUrl: string) => { try { return new URL(sourceUrl).host; } catch { return sourceUrl; } };
