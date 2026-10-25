/*
 * Слова для стабильных кодов источников backend (docs/universities.md, backend/contracts.d.ts SourceErrorCode) и
 * ссылка на экран «Вузы» (#/universities/<раздел>, задача C, #22) — единственное место подключения вуза и входа:
 * удалённый браузер, пароль с MFA, токен, ссылка календаря. Чистые функции, без сети.
 */

/** Коды ошибок источников → что сделать студенту. */
const SOURCE_ERRORS: Record<string, string> = {
  source_auth_required: "Вход не принят: проверь данные. Пароль мог быть неверным, а токен или ссылка — отозваны.",
  source_network_restricted: "Сайт доступен только из сети вуза. Для РУЗ подключись к Wi‑Fi HSE.Student или VPN ВШЭ.",
  source_identifier_not_found: "Не нашли такого студента. Проверь почту, ФИО или номер.",
  source_identifier_ambiguous: "Нашлось несколько человек. Уточни: лучше всего подходит почта вуза.",
  source_lms_unsupported: "Эту LMS узнали, но подключать её Doodle пока не умеет.",
  source_mapping_required: "Формат сайта не распознан однозначно. Попробуй другую ссылку или тип сайта.",
  source_format_unsupported: "Формат сайта не поддерживается. Попробуй другую ссылку.",
  source_recipe_invalid: "Не получилось разобрать данные сайта. Попробуй позже или подключи другим способом.",
  source_format_changed: "Сайт изменился, и данные пока не читаются. Попробуй позже.",
  source_response_invalid: "Сайт ответил непонятно. Попробуй позже.",
  source_unavailable: "Сайт вуза сейчас недоступен. Попробуй позже.",
  source_timeout: "Сайт вуза отвечает слишком долго. Попробуй позже.",
  source_rate_limited: "Сайт вуза просит подождать. Попробуй через несколько минут.",
  // Вход через удалённый браузер (ADR-0005)
  source_session_expired: "Вход на сайт вуза истёк. Войди заново — прежние данные пока остаются.",
  source_login_failed: "Вход не удался: проверь логин и пароль.",
  source_bot_protection: "Сайт вуза не пустил автоматический вход. Войди вручную в браузере или подключи ссылку календаря.",
  source_login_unrecognized: "Не узнали страницу входа. Войди вручную в браузере.",
  source_login_form_ambiguous: "Не поняли форму входа. Войди вручную в браузере.",
  mfa_failed: "Код подтверждения не подошёл. Начни вход заново.",
  mfa_expired: "Время на ввод кода истекло. Начни вход заново.",
  login_credentials_lost: "Сервер перезапустился во время входа. Начни вход заново.",
};

export const sourceError = (code: string | null | undefined) =>
  code ? SOURCE_ERRORS[code] ?? `Источник не подключился (${code}).` : "Источник не подключился.";

/** Короткая подпись проблемы для списка источников. */
export const sourceProblem = (code: string | null | undefined) =>
  code === "source_network_restricted" ? "Только из сети вуза"
  : code === "source_auth_required" || code === "source_session_expired" ? "Нужен вход заново"
  : code === "source_lms_unsupported" ? "Не поддерживается"
  : code?.startsWith("source_identifier") ? "Уточни данные"
  : null;

/** Экран «Вузы»: разделы hse, misis, cu и custom (свой вуз); без вуза — общий вход в экран. */
export const universitiesLink = (universityId?: string | null) =>
  universityId ? `#/universities/${["hse", "misis", "cu"].includes(universityId) ? universityId : "custom"}` : "#/universities";
