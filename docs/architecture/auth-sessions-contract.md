# Контракт login-сессий, сохранённой сессии и выученных рецептов

Статус: контракт для параллельной реализации. **Задача B реализована** (рецепты v2, sync по сессии, agent — см. §11); `backend/src/login` пока заглушки.
Решение — [ADR-0005](../adr/0005-remote-browser-login-and-learned-recipes.md). Типы — [contracts.d.ts](../../backend/contracts.d.ts), маршруты —
[Backend API](../backend-api.md) (раздел «Planned»). Общие правила секретов и ACL — [backend-contract.md](backend-contract.md).
Слова «MUST/SHOULD» — требования к реализации; всё, что не названо, меняется только через ADR/RFC.

## 1. Login-сессия

**LoginSession** — серверный объект в памяти процесса (контекст Chromium нельзя сохранить). Состояние публично, секретов не содержит.

| Режим | Кто входит | Что вводится |
|---|---|---|
| `interactive` | человек в удалённом браузере (кадры + ввод) | всё сам: SSO, MFA, CAPTCHA |
| `password` | сервер заполняет форму по пресету входа | логин и пароль в теле старта (только память), MFA-код из UI |

Состояния: `starting` → (`awaiting_user` для interactive | `filling` для password) → `awaiting_mfa` (password; в interactive MFA вводит человек в кадре) →
`capturing` → `succeeded`. Из любого нетерминального: `failed` (с `errorCode`), `cancelled`, `expired`. Терминальные состояния читаются 5 минут, затем забываются.
`password` MAY перейти в `awaiting_user` (`POST …/handoff`), если форма не распознана или нужна CAPTCHA: дальше вход делает человек в кадре.

| Параметр | Значение |
|---|---|
| Активных сессий на пользователя | **1**; новый старт отменяет прежний (`cancelled`) и уничтожает его контекст |
| Одновременно на процесс | 3 (`LOGIN_BUSY` 429 при превышении); ожидающих MFA — в этот же лимит |
| Жёсткий TTL | interactive 10 мин; password: `filling` 60 с, `awaiting_mfa` 5 мин; `capturing` 20 с |
| Idle TTL (interactive) | 2 мин без ввода или подключения потока |
| Старты | 5 в минуту на пользователя; после 3 `source_login_failed` подряд — `LOGIN_COOLDOWN` 429 на 10 минут для подключения |
| Кадры | ≤ 8 fps, JPEG q≈60, вьюпорт ≤ 480×900 CSS px (DPR 1); один зритель на сессию |
| Ввод | ≤ 60 событий/с; вставка текста ≤ 4 КБ; только в `awaiting_user|awaiting_mfa` |
| Неверный MFA-код | 3 попытки (`attemptsLeft`), затем `failed` + `mfa_failed` |

Уничтожение контекста (любой терминал, TTL, перезапуск процесса, отключение подключения): закрыть страницы и браузерный процесс, удалить временный профиль, обнулить буферы.
После перезапуска процесса сессий нет: `GET` вернёт 404 → UI предлагает начать вход заново. Пароль/код живут только в замыкании задачи и обнуляются сразу после ввода в форму.
Disconnect подключения отменяет его активную сессию.

Успех (`capturing`): собрать `StoredSession` (§4), записать в `secrets` подключения (`replaceSession`, §4), поставить `sync`-job и перевести подключение в `pending`.
Если в пресете/рецепте нужен «bootstrap» для идентификации аккаунта — сохранить `identityDigest`.

## 2. API (planned)

Все маршруты — под `x-telegram-init-data` (или dev-авторизацией) и проверкой владения подключением до любых действий. Ошибки — `{error:{code,requestId}}`.

| Метод и маршрут | Тело → ответ |
|---|---|
| POST `/api/v1/connections/:id/login` | `{mode:'interactive'}` либо `{mode:'password', username, password, keepCalendar?}` → 201 `{login}`; 409 `LOGIN_UNAVAILABLE` (нет Chromium/пресета), 429 `LOGIN_COOLDOWN` / `LOGIN_BUSY` / `RATE_LIMITED` |
| GET `/api/v1/login/:id` | `{login}` — только владелец; чужой/неизвестный/забытый → 404 |
| POST `/api/v1/login/:id/mfa` | `{code}` (`^[0-9A-Za-z -]{4,12}$`) → 202 `{login}`; 409 `LOGIN_NOT_WAITING_MFA` |
| POST `/api/v1/login/:id/handoff` | `{}` → `{login}` (password → awaiting_user) |
| POST `/api/v1/login/:id/cancel` | `{}` → `{login}` |
| POST `/api/v1/login/:id/ticket` | `{}` → 200 `{ticket, expiresAt, path}` — одноразовый тикет потока: 30 с, привязан к пользователю и сессии, хранится как хэш |
| GET (Upgrade: websocket) `/api/v1/login/:id/stream?ticket=…` | WebSocket потока кадров и ввода (§3) |
| GET `/api/v1/connections/:id` | дополнительно `login: LoginSession \| null` (активная) и `authMethods` с `remote_login` / `sso_password` |

Старый `POST /connections/:id/auth` (token/password/calendarUrl/identifier) остаётся для способов без браузера. Пароль **MUST NOT** попадать в URL, payload `jobs`, result,
логи, `errorCode` и запросы к модели. Старт `mode:'password'` не создаёт job с паролем: сессия — собственный объект менеджера; наружу виден `loginId`.
Ответ `login.url` содержит только `origin+path` текущей страницы, без query/hash.

## 3. Поток кадров и ввода

Аутентификация: initData проверяется на `POST …/ticket` (браузер не умеет ставить заголовки на WebSocket); upgrade принимает **только** валидный непросроченный
тикет, помечает его использованным, проверяет `Origin` (= `PUBLIC_BASE_URL` или loopback в dev) и состояние сессии; иначе закрывает 4401/4403/4404.
Второе подключение к сессии вытесняет первое только по новому тикету. Закрытие потока не отменяет сессию (idle-таймер идёт); `cancel` — отменяет.

Сервер → клиент: **binary** — один JPEG-кадр на сообщение (размер из последнего `hello`/`resize`); **text JSON**:
`{type:'hello',width,height}`, `{type:'status',login}`, `{type:'cursor',cursor}` (CSS cursor), `{type:'closed',reason}`.
Клиент → сервер (text JSON, координаты в пикселях кадра, сервер ограничивает по `width×height`):
`{type:'mouse',action:'move'|'down'|'up'|'wheel',x,y,button?:'left'|'right'|'middle',dx?,dy?}`,
`{type:'key',action:'down'|'up',key,code?}`, `{type:'text',text}` (символы/IME/вставка ≤ 4 КБ), `{type:'resize',width,height}`, `{type:'ping'}`.
Неизвестные/слишком частые/слишком большие сообщения — игнор + счётчик; > 100 нарушений — закрытие 4400. Адресной строки нет: клиент **не может** передать URL навигации.
События ввода и содержимое кадров **MUST NOT** логироваться, храниться или попадать в метрики; метрики — только счётчики и длительности.

## 4. Сохранённая сессия

Лежит в `secrets` как `{origin, session: StoredSession}` (шифруется целиком; публичные ответы, jobs, снимки, логи его не видят). `StoredSession` v2:

```
{ version: 2, capturedAt, expiresAt,           // expiresAt = min(exp cookies, exp JWT, capturedAt + maxAgeHours пресета, по умолчанию 12 ч; жёсткий максимум 30 суток)
  identityDigest?,                              // sha256 стабильного id аккаунта из bootstrap; смена → прежние данные удаляются
  cookies: [{name,value,domain,path,expires?,secure,httpOnly,sameSite?}],   // только хосты allowlist пресета/рецепта
  bearer?: { token, scheme:'Bearer', source:'localStorage'|'sessionStorage'|'xhr-header', key?, host, expiresAt? },
  calendarUrl? }                                // по согласию, см. ADR-0004
```

- Не сохраняются: весь `localStorage`/`sessionStorage` целиком, IndexedDB, HTML, скриншоты, заголовки кроме `Authorization`, refresh-токены (пока пресет не включил `allowRefresh` и рецепт не описал обновление).
- Bearer выбирается правилом: значение, которое **браузер сам отправлял** в `Authorization` на API origin источника (приоритет), либо ключ storage, совпавший с этим значением; произвольные JWT из storage не берутся.
- Запись — `store.replaceSession(userId, connectionId, session, {clearData:boolean})`: `setSecret` без удаления jobs; снимки/документы не трогаются (reauth), кроме `clearData:true` при смене `identityDigest`. Исполнитель sync читает секрет только внутри задачи.
- Удаление: disconnect (каскад), новая сессия (замена), истечение `expiresAt` (секрет остаётся до замены, но sync не использует и ставит `user_action_required`).
- Cookie header формируется исполнителем по домену/пути/secure; запрос уходит только на origin, связанный с подключением; редиректы не следуются на другой origin с секретом.

## 5. Выученный рецепт v2

Хранится как обычный адаптер (`adapters`): `recipe = LearnedRecipe`, `id = learned:<digest(origin)>:<revision>`, `version = String(revision)`. Общий на origin, **без значений пользователя**.
Типы — `LearnedRecipe` в [contracts.d.ts](../../backend/contracts.d.ts). Состав:

- `version: 2`, `type: 'learned'`, `origin`, `revision`, `learnedAt`, `rollbackOf?`, `auth: {type:'cookie'} | {type:'bearer'}` (откуда брать секрет; заголовок всегда `Authorization: Bearer`);
- `bootstrap?: [{id, method:'GET', path, extract:{ paramName: '/json/pointer' }}]` — ответы вида «/me»; извлечённые параметры (`userId`) подставляются в шаблоны `{paramName}` и не сохраняются в рецепт;
- `endpoints: [{id, kind:'courses'|'schedule'|'deadlines'|'documents', request, response, pagination?}]`:
  `request = {method:'GET'|'POST', path, query?, body?}`; `path`/`query`/`body` — шаблоны; параметры: bootstrap-параметры и встроенные `{today}`, `{nowUnix}`, `{plusDaysUnix:N}`; путь начинается с `/`, query и fragment не в `path`;
  `response = {itemsPath:'/json/pointer', fields:{id,title,url?,startsAt?,endsAt?,dueAt?,location?,courseId?,description?}}`, каждое поле — `{path:'/pointer', transform?:'iso'|'unixSeconds'|'unixMillis'}`.
- `validation: {requireKinds:[…], minItems?}` для canary.

Ограничения (MUST, проверяет `validateLearnedRecipe` до сохранения и при каждом чтении):
1. Метод GET. POST — только read-only из allowlist **в коде** (`backend/src/sources/learned.mjs`): сейчас Moodle `POST /lib/ajax/service.php` с `methodname` из `{core_course_get_enrolled_courses_by_timeline_classification, core_calendar_get_action_events_by_timesort}`.
2. Только origin рецепта; абсолютные URL, `//`, `..`, фрагменты, userinfo — отказ; не более 10 эндпоинтов, 3 страниц на эндпоинт, 1000 элементов.
3. Нет личных данных: строки рецепта не содержат e-mail, телефон, JWT, UUID, длинные цифры (≥6) и **не равны ни одному значению, увиденному в наблюдениях** (личные значения заменяются `{param}` или отбрасываются); имена параметров — из `[A-Za-z][A-Za-z0-9]{0,30}`.
4. Нет токенов/сессий/заголовков в рецепте: авторизация — только поле `auth`.
5. Нет кода: ни выражений, ни регулярных выражений, ни JS; трансформации — из закрытого списка.

Жизненный цикл: **наблюдение** (в памяти во время входа и просмотра: только XHR/fetch к origin источника; метаданные + форма JSON — ключи и типы, значения не покидают память) → **кандидат** (детерминированные эвристики, LLM — только по форме/ключам, как `proposeRecipe`) →
**lint** → **canary** на сессии наблюдавшего: рецепт исполняется и даёт ≥ `minItems` корректных элементов нужных видов → **активация** (новая ревизия адаптера) → **теневая проверка** при первых sync других пользователей (формат совпадает).
Рецепт **откатывается** созданием новой ревизии `rollbackOf` с копией предыдущей (`findAdapter` выбирает последнюю): при 3 подряд `source_format_changed` разных пользователей или ручном решении. Старая ревизия не удаляется.
Несоответствие формата → `source_format_changed`, снимок не заменяется; личные данные в рецепт не попадают даже при отказе.

## 6. Признаки протухания и повторный вход

Sync **MUST** считать сессию протухшей: HTTP 401/403 на bootstrap или любом эндпоинте; редирект (3xx) на другой origin или на путь `/login|/auth|/sso|/oidc|/signin`; тело с кодами `servicerequireslogin`, `invalid_token`, `token_expired`, `unauthorized`;
HTML вместо ожидаемого JSON с формой входа; `expiresAt` в прошлом. Результат: `errorCode:'source_session_expired'`, статус `user_action_required`, прежние снимки сохраняются, запросов на вход не создаётся (пароля нет), планировщик перестаёт опрашивать подключение.
UI предлагает новый login (`POST …/login`); после успеха — `replaceSession` и sync. Один повтор запроса допустим только при сетевой ошибке, не при 401/403.

## 7. Agent retrieval

LLM-агент — резерв, когда нет детерминированного пути. Инструменты: `open(url)` (только GET, только origin источника, не `logout|delete|edit|submit|sesskey=` и пр.), `list_links`, `extract(kind, items)`. Cookies/bearer подставляет исполнитель, ключи модели и сессии LLM не доступны.
Текст страниц санитизируется (`sanitizeText`) и подаётся как **данные**; формы и не-GET отсутствуют по построению; адреса API/origin агент не меняет. Бюджет: 12 страниц, 20 шагов, 60 с, ограниченный объём токенов. Документы сохраняются из **текста открытой страницы**, не из текста модели;
элементы без посещённой страницы-источника отбрасываются; результат — нормализованный формат с `sourceUrl` и `extractedBy:'agent'`. Без ключа модели режим выключен.

## 8. Модель угроз

| Угроза | Мера |
|---|---|
| Сервер видит нажатия клавиш и экран (пароль, MFA, CAPTCHA) | Только память; без логов/метрик содержимого; TTL; один контекст на пользователя; терминал → уничтожение; остаточный риск оператора принят владельцем (ADR-0005) |
| Межпользовательская утечка | Отдельный браузерный процесс и временный профиль на сессию; владелец проверяется на каждый маршрут/тикет; тикет одноразовый и привязан к сессии; нет общих cookies/кэша |
| SSRF через навигацию и редиректы | Адресной строки нет; весь трафик Chromium — через локальный CONNECT-прокси: только HTTPS:443, хосты из allowlist пресета (+ редирект-цепочка по правилу суффикса для неизвестного вуза, ≤ 10 хостов), IP-литералы запрещены, DNS через `resolvePublicAddress` с пином адреса; `route` — только вторая линия (редиректы не перехватывает) |
| Загрузки/загрузка файлов, права устройств | `acceptDownloads:false`, file chooser отменяется, permissions пусты, service workers и расширения выключены, popups — в ту же страницу только на разрешённый хост |
| Подмена потока (чужой WebSocket, CSRF) | Одноразовый тикет + проверка `Origin` + состояние сессии; ввод — только от одного зрителя |
| Перебор паролей/блокировка аккаунта у вуза | 3 подряд `source_login_failed` → пауза 10 мин; 5 стартов/мин |
| Утечка в рецепт | lint §5, сравнение с наблюдавшимися значениями, рецепты общие, токены только в секрете |
| Prompt injection из страницы | §7 |
| Обход защиты от ботов | Запрещён; при блокировке — `source_bot_protection`, остаётся interactive-режим человека и способ с календарём |

## 9. Рантайм Chromium в проде

Зависимость `playwright-core` (бэкенд) и Chromium на хосте (`CHROMIUM_PATH` или `npx playwright install --with-deps chromium` на хосте-сервисе, не в общем окружении). Запас ОЗУ 400 МБ на активную сессию × 3; `--disable-dev-shm-usage` или `/dev/shm` ≥ 256 МБ;
сервис — непривилегированный пользователь, лимиты cgroup (память/CPU/процессы), исходящий HTTPS только к хостам пресетов (фильтр на хосте поверх прокси), без `--no-sandbox` вне контейнера с seccomp; временный профиль в `tmpfs`, удаляется при закрытии. Без Chromium менеджер возвращает `LOGIN_UNAVAILABLE`, а `authMethods` не предлагает `remote_login`/`sso_password`.
Деплой не входит в эти задачи; изменения runbook — отдельным PR ([deployment.md](../deployment.md)).

## 10. Владельцы файлов и интеграция

| Задача | Владеет | Не трогает |
|---|---|---|
| **A** — менеджер browser-сессий: remote browser, CDP-кадры, WebSocket, password+MFA, пресеты входа ВШЭ/ЦУ, egress-прокси, `StoredSession` | `backend/src/login/**` (кроме stub-экспортов, которые сохраняют форму), `backend/test/login*.test.mjs`, `backend/test/fixtures/login/**`, `store.replaceSession` (`backend/src/store.mjs`, только этот метод), `backend/package.json` (`playwright-core`) | `sources/learned.mjs`, `jarvis-app/web/**` |
| **B** — learned recipes, sync по сохранённой сессии, reauth, agent retrieval | `backend/src/sources/learned.mjs`, `backend/src/sources/session-sync.mjs` (новый), `backend/src/sources/agent.mjs` (новый), `backend/src/sources/index.mjs` (ветка выбора исполнителя), `network.mjs` (режим запроса с сессией), `backend/test/learned*.test.mjs`, `backend/test/session-sync*.test.mjs`, `deepseek.mjs` | `backend/src/login/**`, `jarvis-app/web/**` |
| **C** — UI Mini App на `/api/v1`, просмотрщик удалённого браузера, dev-авторизация | `jarvis-app/web/**` (включая `src/api/v1.ts`), `tests/e2e/**`, `backend/src/dev-auth.mjs`, `docs/DEVELOPMENT.md` (раздел локального запуска) | остальной `backend/**` |

Общие файлы — только через небольшие правки: `backend/contracts.d.ts` (дополняется; ломающие изменения — через ADR), `backend/src/http.mjs` (точки подключения уже есть: `login`, `devAuth`; логика маршрутов — в `backend/src/login/routes.mjs` у A), `backend/src/main.mjs` (подключение фабрик), `docs/backend-api.md` (после реализации снимать пометку planned у своих маршрутов).
Порядок слияния: контракт (этот PR) → A и B независимо (B использует сессию из фикстур, не из A) → C (может начать сразу на синтетическом API). Имена модулей, сигнатуры заглушек и форма `StoredSession`/`LearnedRecipe` менять нельзя без согласования; добавлять поля можно, если они необязательны.

Готово для A/B/C: фикстурные тесты по §8–§9 своей области, `npm test` и `npm run check` зелёные, документ раздела обновлён, живой вход выполняет только владелец.

## 11. Реализация B (learned recipes, sync по сессии, agent)

Код: `backend/src/sources/learned.mjs` (lint, исполнитель, canary, ревизии), `learned-observe.mjs` (обучение по наблюдениям), `learned-seeds.mjs` (seed ЦУ и ВШЭ),
`session-sync.mjs` (sync, протухание), `agent.mjs` (§7), режим сессии в `network.mjs` (`request(url, {session})`). Тесты: `backend/test/learned*.test.mjs`, `session-sync*.test.mjs` на loopback-фикстурах.

- **Вход для A.** `createSourceService(...).learn({userId, connectionId, observations})` после записи сессии: наблюдения `{method:'GET', url, status, body}` (разобранный JSON, только в памяти) → кандидат → lint → canary на этой сессии → новая ревизия адаптера `learned:<digest(origin)>:<n>`.
  Sync выбирает путь сам: в секрете подключения `{origin, session}` (`StoredSession` v2) → рецепт (последняя ревизия, иначе seed) → иначе agent, если есть ключ модели → иначе `source_mapping_required`.
- **Имена параметров bootstrap** становятся ключами рецепта, а `store.putAdapter` отвергает ключи `userId`, `studentId`, `email`, `token`, `session` и т. п.: параметр называется `uid` (в шаблоне `{uid}`); lint отвергает такие имена заранее.
- **Дополнения к рецепту (необязательные).** Значение `extract` может быть именем из закрытого списка вместо JSON-указателя: `@moodle:sesskey` (читает `sesskey` из `M.cfg` HTML-страницы bootstrap; живёт в памяти одного sync). Ключи query/body с именем вроде `sesskey|token|session` допустимы только как целый параметр `{name}`.
  Числовые встроенные параметры (`{nowUnix}`, `{plusDaysUnix:N}`) целиком в значении тела POST становятся числом.
- **Обучение** детерминированное: ищет массив объектов в JSON, поля по именам ключей, тип даты по значению, пагинацию `offset|page` и параметры времени. Личные значения заменяются `{uid}` из bootstrap-ответа (id аккаунта, встречающийся в путях других запросов) либо эндпоинт отбрасывается.
  Повторяющиеся служебные слова (`published`) не считаются личными значениями при сравнении с наблюдениями. POST не обучается (только seed и ручной рецепт по allowlist). Модель: `deepseek.proposeLearnedRecipe` получает только формы (пути, имена ключей, типы).
- **Статусы sync.** Протухание → `user_action_required` + `source_session_expired` без запросов на вход; известное протухание (`expiresAt`) не делает запросов вообще. Сбой формата одного эндпоинта → сохраняются остальные виды, статус `error` + `source_format_changed` (планировщик продолжает опрашивать, откат возможен);
  три разных пользователя подряд (счётчик в памяти процесса, сбрасывается успехом) → откат ревизией `rollbackOf`.
- **Seed** (`learned-seeds.mjs`) — данные из [исследования](../research/cu-hse-auth-endpoints.md) (§4): ЦУ (курсы, дедлайны) и ВШЭ Smart LMS (Moodle AJAX по allowlist). **Живьём не проверены**.
  Пробелы исследования §4.4: G4 (корневой массив, `itemsPath: ""`) и G5 (`sesskey` со страницы, `@moodle:sesskey`) закрыты; G1 (обход по курсам), G2/G3 (вложенные массивы и недельное правило расписания ЦУ), G6 (шаблон `url`), G7 (два origin одного вуза) — нет.
- **Не сделано:** сверка `identityDigest` при sync (формулу задаёт A), обучение POST и cursor-пагинации, персистентный счётчик отката.

