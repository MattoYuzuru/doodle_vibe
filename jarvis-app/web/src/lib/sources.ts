/*
 * Подключение источников вузов во frontend (25 окт 2026): готовые адреса вузов и слова для стабильных кодов backend.
 * Адреса повторяют backend/src/sources/presets.mjs (там же порядок способов входа); API их пока не отдаёт, поэтому
 * при изменении пресетов в backend поправь и этот список. Коды note/notes/errorCode — из docs/universities.md;
 * backend отдаёт коды, слова — здесь. Чистые данные и функции, без сети.
 */

export type SourceKind = "lms" | "schedule" | "document" | "table" | "website";
export type AuthField = "token" | "username" | "password" | "service" | "calendarUrl" | "identifier";
export interface AuthMethod {
  // sso_password и remote_login идут не через /auth, а через сессию входа (/connections/:id/login, ADR-0005).
  id: string; type: "token" | "password" | "calendar_url" | "identifier" | "oauth" | "sso_password" | "remote_login"; label: string; fields?: AuthField[];
  sourceType?: "moodle" | "ical" | "ruz"; note?: string; notes?: string[];
}

export interface SourcePreset { url: string; kind: SourceKind; label: string; hint: string }

/** Готовые источники вузов: нажал — и не нужно вбивать адрес. */
export const SOURCE_PRESETS: Record<string, SourcePreset[]> = {
  hse: [
    { url: "https://edu.hse.ru/", kind: "lms", label: "Smart LMS", hint: "edu.hse.ru — дедлайны и курсы" },
    { url: "https://ruz.hse.ru/", kind: "schedule", label: "Расписание РУЗ", hint: "ruz.hse.ru — пары; только из сети ВШЭ" },
  ],
  misis: [
    { url: "https://newlms.misis.ru/", kind: "lms", label: "LMS МИСИС", hint: "newlms.misis.ru — задания и курсы" },
  ],
};

/** Пояснения к способу входа (note) и к источнику целиком (notes). */
export const AUTH_NOTES: Record<string, string> = {
  sso_login_only: "Smart LMS входит через единый вход ВШЭ (SSO). Doodle его не проходит, поэтому проще всего дать ссылку экспорта календаря.",
  university_network_only: "РУЗ отвечает только из сети ВШЭ: Wi‑Fi HSE.Student или VPN. Из другой сети расписание не загрузится.",
  local_accounts_only: "Подойдёт только локальная учётная запись LMS. Пароль от единого входа ВШЭ здесь не сработает.",
  moodle_calendar_export: "В LMS: Календарь → Импорт или экспорт календарей → Экспорт календаря → события «Все» → «Получить URL календаря». Ссылка содержит личный ключ — храни её как пароль.",
};

/** Подписи полей формы входа. */
export const FIELD_LABEL: Record<AuthField, string> = {
  calendarUrl: "Ссылка календаря",
  identifier: "Почта вуза, ФИО или номер в РУЗ",
  token: "Токен",
  username: "Логин",
  password: "Пароль",
  service: "Сервис",
};

/** Коды ошибок источников → что сделать студенту. */
const SOURCE_ERRORS: Record<string, string> = {
  source_auth_required: "Вход не принят: проверь данные. Пароль мог быть неверным, а токен или ссылка — отозваны.",
  source_network_restricted: "Сайт доступен только из сети вуза. Для РУЗ подключись к Wi‑Fi HSE.Student или VPN ВШЭ.",
  source_identifier_not_found: "Не нашли такого студента. Проверь почту, ФИО или номер.",
  source_identifier_ambiguous: "Нашлось несколько человек. Уточни: лучше всего подходит почта вуза.",
  source_lms_unsupported: "Эту LMS узнали, но подключать её Doodle пока не умеет.",
  source_mapping_required: "Формат сайта не распознан однозначно. Попробуй другую ссылку или тип сайта.",
  source_format_unsupported: "Формат сайта не поддерживается. Попробуй другую ссылку.",
};

export const sourceError = (code: string | null | undefined) =>
  code ? SOURCE_ERRORS[code] ?? `Источник не подключился (${code}).` : "Источник не подключился.";

/** Короткая подпись проблемы для списка источников. */
export const sourceProblem = (code: string | null | undefined) =>
  code === "source_network_restricted" ? "Только из сети вуза"
  : code === "source_auth_required" ? "Нужен вход заново"
  : code === "source_lms_unsupported" ? "Не поддерживается"
  : code?.startsWith("source_identifier") ? "Уточни данные"
  : null;

/** Тело POST /connections/:id/auth: ровно одна форма; origin — origin подключения. */
export function authBody(origin: string, method: AuthMethod, values: Partial<Record<AuthField, string>>) {
  const body: Record<string, string> = { origin };
  for (const f of method.fields ?? []) {
    const v = f === "password" ? values[f] ?? "" : (values[f] ?? "").trim();
    if (v) body[f] = v;
  }
  return body;
}

/** Все поля способа заполнены (пароль не обрезаем: пробелы в нём бывают нарочно). */
export const authReady = (method: AuthMethod, values: Partial<Record<AuthField, string>>) =>
  (method.fields ?? []).filter((f) => f !== "service").every((f) => (f === "password" ? !!values[f] : !!values[f]?.trim()));
