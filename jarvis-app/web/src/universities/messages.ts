import type { AuthMethod, LoginSession } from "../api/v1";
import { ApiV1Error } from "../api/v1";

/* Тексты для кодов сервера: UI словами не гадает, код всегда виден в скобках. */

export interface Wording { text: string; /** Что сделать: подсказка рядом с текстом. */ action?: string }

const SOURCE: Record<string, Wording> = {
  source_auth_required: { text: "Нужен вход.", action: "Войди ещё раз: пароль мог измениться, а токен или ссылка — быть отозваны." },
  source_session_expired: { text: "Сессия истекла.", action: "Нажми «Войти снова». Прежние данные сохранены и показаны ниже." },
  source_login_failed: { text: "Вход не удался: сайт вуза не принял данные.", action: "Проверь логин и пароль или войди вручную в браузере." },
  source_bot_protection: { text: "Сайт вуза включил защиту от ботов.", action: "Войди вручную в удалённом браузере или используй ссылку календаря." },
  source_login_unrecognized: { text: "Не удалось распознать страницу входа.", action: "Войди вручную в удалённом браузере." },
  source_login_form_ambiguous: { text: "На странице входа несколько форм, непонятно какую заполнять.", action: "Войди вручную в удалённом браузере." },
  mfa_failed: { text: "Код подтверждения не подошёл.", action: "Попытки закончились. Начни вход заново." },
  mfa_expired: { text: "Время на ввод кода вышло.", action: "Начни вход заново." },
  login_credentials_lost: { text: "Сервер перезапустился, пока ты входил.", action: "Начни вход заново." },
  source_network_restricted: { text: "Источник доступен только из сети вуза.", action: "Подключись к Wi‑Fi вуза или VPN и повтори." },
  source_identifier_not_found: { text: "В РУЗ не нашлось такого студента.", action: "Уточни почту, ФИО или номер." },
  source_identifier_ambiguous: { text: "Под это имя подходит несколько студентов.", action: "Введи почту вуза или номер." },
  source_lms_unsupported: { text: "Эта система обучения пока не поддерживается.", action: "Можно добавить публичное расписание (iCal) или страницы сайта." },
  source_mapping_required: { text: "Не удалось однозначно понять формат сайта." },
  source_format_unsupported: { text: "Формат данных сайта пока не поддерживается." },
  source_format_changed: { text: "Сайт вуза изменил формат, данные не обновлены.", action: "Прежние данные сохранены. Обновление появится, когда мы подстроимся." },
  source_recipe_invalid: { text: "Схема чтения сайта оказалась некорректной, данные не обновлены." },
  source_response_invalid: { text: "Сайт вуза ответил непонятно, данные не обновлены.", action: "Попробуй обновить позже." },
  source_unavailable: { text: "Сайт вуза недоступен.", action: "Попробуй позже." },
  source_timeout: { text: "Сайт вуза слишком долго отвечает.", action: "Попробуй позже." },
  source_rate_limited: { text: "Сайт вуза просит подождать.", action: "Повтори позже." },
};

const API: Record<string, Wording> = {
  OFFLINE: { text: "Сервер не отвечает.", action: "Проверь соединение и повтори." },
  UNAUTHORIZED: { text: "Сервер не узнал тебя.", action: "Открой приложение из Telegram или запусти локальный режим." },
  RATE_LIMITED: { text: "Слишком много запросов.", action: "Подожди минуту." },
  LOGIN_UNAVAILABLE: { text: "Вход через браузер на этом сервере недоступен.", action: "Выбери другой способ входа ниже." },
  LOGIN_COOLDOWN: { text: "Слишком много неудачных входов подряд.", action: "Подожди 10 минут, прежде чем пробовать снова." },
  LOGIN_BUSY: { text: "Сервер сейчас занят чужими входами.", action: "Повтори через минуту." },
  LOGIN_NOT_WAITING_MFA: { text: "Код сейчас не нужен: сервер ничего не ждёт." },
  NOT_FOUND: { text: "Сессия входа закрыта или не найдена.", action: "Начни вход заново." },
  UNSAFE_SOURCE_URL: { text: "Адрес не подходит.", action: "Нужен https:// без логина, параметров и якоря." },
  INVALID_INPUT: { text: "Проверь введённые данные." },
  INVALID_SOURCE_URL: { text: "Адрес не подходит.", action: "Нужен https:// без логина, параметров и якоря." },
  CONNECTION_LIMIT: { text: "В пространстве уже максимум источников." },
  SPACE_LIMIT: { text: "Достигнут лимит вузов." },
  JOB_TIMEOUT: { text: "Проверка идёт дольше обычного.", action: "Статус обновится сам; можно нажать «Обновить»." },
  OAUTH_NOT_CONFIGURED: { text: "Вход через провайдера не настроен на сервере." },
};

export function wordCode(code: string | null | undefined): Wording | null {
  if (!code) return null;
  return SOURCE[code] ?? API[code] ?? { text: "Что-то пошло не так.", action: "Попробуй ещё раз." };
}

/** Одна строка для плашки: «Текст. Что сделать. (код)». */
export function sayCode(code: string | null | undefined): string {
  const w = wordCode(code);
  return w ? `${w.text}${w.action ? ` ${w.action}` : ""} (${code})` : "";
}

export function sayError(error: unknown): string {
  return sayCode(error instanceof ApiV1Error ? error.code : "INTERNAL_ERROR");
}

export const LOGIN_PROGRESS: Partial<Record<LoginSession["status"], string>> = {
  starting: "Запускаю удалённый браузер…",
  filling: "Заполняю форму входа…",
  capturing: "Вход выполнен, сохраняю сессию…",
};

const NOTES: Record<string, string> = {
  moodle_calendar_export: "Календарь Moodle: «Календарь → Импорт или экспорт → Экспорт календаря → Получить URL». Ссылка содержит личный токен — считай её паролем.",
  local_accounts_only: "Подойдёт только локальная учётная запись Moodle; пароль SSO не сработает.",
  sso_login_only: "Сайт входит через SSO: надёжнее удалённый браузер или календарь.",
  university_network_only: "Доступно только из сети вуза.",
};
export const sayNote = (code: string) => NOTES[code] ?? null;

export const METHOD_ORDER: AuthMethod["type"][] = ["remote_login", "sso_password", "password", "token", "calendar_url", "identifier", "oauth"];
export const METHOD_TITLES: Record<AuthMethod["type"], string> = {
  remote_login: "Войти в браузере", sso_password: "Логин, пароль и MFA", password: "Логин и пароль Moodle", token: "Токен", calendar_url: "Ссылка календаря",
  identifier: "Почта или ФИО", oauth: "Войти через провайдера",
};
