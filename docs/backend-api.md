# Backend v1 и передача frontend

Backend реализован отдельно в `backend/`. Сохраняем React/бота; текущие экраны
ещё используют legacy API. Новый API **не является drop-in заменой** всех старых
маршрутов. Frontend подключает этот контракт в своей отдельной задаче, не
возвращая Moodle-specific DTO в модель пространств. Типы: [contracts](../backend/contracts.d.ts).
Реализация маршрутов: [http](../backend/src/http.mjs).

Каждый private-запрос содержит `x-telegram-init-data` от Telegram Mini App.
Сервер проверяет подпись, срок 1 час и отклоняет будущую дату с допуском 30 с.
Открытие вне Telegram не даёт личного доступа. `userId` клиент не задаёт.
Запись — JSON; unknown-поля отклоняются. Ошибка: `{error:{code,requestId}}`.
Все даты — ISO UTC. UI форматирует их в выбранном часовом поясе.
Если данные удалились/изменились во время ответа модели, API возвращает 409
`EVIDENCE_CHANGED` без записи ответа в память; UI предлагает повторить вопрос.

| Метод и маршрут | Запрос / результат |
|---|---|
| GET `/api/v1/me` | `{user,spaces}` |
| GET / POST `/api/v1/spaces` | `{spaces}` / `{universityId,name}` → 201 `{space}` |
| GET / DELETE `/api/v1/spaces/:id` | `{space}` / каскадное удаление |
| GET / POST `/api/v1/spaces/:id/connections` | `{connections}` / `{sourceUrl,kind,label?}` → 202 `{connection,job}` |
| GET / DELETE `/api/v1/connections/:id` | `{connection,authMethods}` (формы входа исполнителя, затем OAuth) / удаление доступа, задач и данных источника |
| POST `/api/v1/connections/:id/auth` | ровно одна форма: `{origin,token}`, `{origin,username,password,service?}`, `{origin,calendarUrl}` или `{origin,identifier}` → 202 `{saved,job}` |
| POST `/api/v1/connections/:id/discover` или `/sync` | `{}` → 202 `{job}` |
| GET `/api/v1/jobs/:id` | `{job}`; опрос до terminal status |
| GET `/api/v1/spaces/:id/schedule`, `/deadlines`, `/courses` | `{spaceId,items,sources,connections}` |
| GET `/api/v1/spaces/:id/documents?q=...` или `/faq?q=...` | `{documents,kind:'source_documents'}`; FAQ — подтверждённые документы, не генерация |
| GET / POST `/api/v1/spaces/:id/chat` | `{messages}` / `{text}` → `ChatAnswer` |
| POST `/api/v1/connections/:id/oauth` | `{providerId}` → `{authorizationUrl,expiresAt}` + защищённая cookie |
| GET `/api/v1/oauth/callback` | Только configured OAuth-провайдер, PKCE/state/browser binding; затем возврат в Telegram |

`sourceUrl` — публичный HTTPS URL без query/fragment/credentials. Kind: lms,
schedule, document, table, website. Один источник не смешивается с другим даже
при одинаковом внешнем ID. Сохраняются последние полные снимки; сбой виден в
connection status, старые данные не исчезают. UI показывает `fetchedAt`, stale
и ошибку, а не крутит бесконечный spinner. Состояние `user_action_required`
может быть успешным результатом discovery-job: задача завершена, вход ещё нужен.

## Frontend (DES-010)

Когда `/api/me` возвращает `platformApi: "/api/v1"`, Mini App переключается в режим вузов:
`store/platform.ts` (вузы, активный вуз, данные только активного; при переключении сразу
сбрасываются), `lib/space-adapter.ts` (SourceItem → дедлайны, пары, курсы прежних экранов и
контекст маскота) и `screens/space/` (Главная, Дедлайны, План, Курсы).
Маскот — Варя для ВШЭ, Дуся для остальных. Подключение вуза и любой вход — только на экране «Вузы»
(`#/universities`, задача C): «+» у переключателя вуза, «Подключить учёбу» на пустой Главной, «Добавить» и
«Войти» у источника и действия маскота ведут туда (`lib/sources.ts`: `universitiesLink`, тексты кодов
`errorCode`). Со старым сервером МИСИС (без `platformApi`)
работают прежние экраны. Данные вузов не пишутся в облачную копию прежнего хранилища.

Dev-авторизация: при `DOODLE_DEV_AUTH=1` (только loopback `HOST`, без `PUBLIC_BASE_URL`, не production) запросы без `x-telegram-init-data`
получают одного синтетического пользователя, а same-origin `Origin` на loopback принимается; см. [локальный запуск](DEVELOPMENT.md).


## Login-сессии, удалённый браузер и выученные рецепты

Статус: маршруты login-сессий **реализованы** (`backend/src/login`, фикстуры с настоящим Chromium; без Chromium на хосте — `LOGIN_UNAVAILABLE`, `authMethods` их не предлагает); чтение данных по сохранённой сессии и выученные рецепты (`recipe.version = 2`) — **planned** (задача B). Контракт — в
[auth-sessions-contract.md](architecture/auth-sessions-contract.md), решение — [ADR-0005](adr/0005-remote-browser-login-and-learned-recipes.md),
типы — `LoginSession`, `StoredSession`, `LearnedRecipe` в [contracts](../backend/contracts.d.ts). Вход любым способом (SSO, MFA, CAPTCHA) выполняет человек в
удалённом браузере; пароль не хранится, хранится только зашифрованная сессия.

| Метод и маршрут | Запрос / результат (planned) |
|---|---|
| POST `/api/v1/connections/:id/login` | `{mode:'interactive'}` либо `{mode:'password',username,password,keepCalendar?}` → 201 `{login}` |
| GET `/api/v1/login/:id` | `{login}` — состояние, TTL, `mfa:{kind,attemptsLeft}` |
| POST `/api/v1/login/:id/mfa` · `/handoff` · `/done` · `/cancel` | `{code}` / `{}` / `{}` / `{}` → `{login}` |
| POST `/api/v1/login/:id/ticket` | `{ticket,expiresAt,path}` — одноразовый тикет WebSocket (30 с) |
| GET `/api/v1/login/:id/stream?ticket=…` | WebSocket: JPEG-кадры сервер→клиент, мышь/клавиатура клиент→сервер |
| GET `/api/v1/connections/:id` | дополнительно `login` (активная сессия или null); `authMethods` включает `remote_login` и `sso_password`, когда на сервере есть Chromium |

Ошибки login-маршрутов: `LOGIN_UNAVAILABLE` 409, `LOGIN_COOLDOWN` 429, `LOGIN_BUSY` 429, `LOGIN_NOT_WAITING_MFA` 409, `LOGIN_NOT_COMPLETE` 409.
Успешный вход сохраняет зашифрованную сессию и ставит `sync`-job; до подключения чтения по сессии (задача B) такой sync возвращает `source_auth_required`, если не сохранена ссылка календаря (`keepCalendar`).
Коды источников: `source_session_expired`, `source_login_failed`, `source_bot_protection`, `source_login_unrecognized`, `source_login_form_ambiguous`, `mfa_failed`, `mfa_expired`, `login_credentials_lost`.
Выученный рецепт (`recipe.version = 2`) — адаптер общий на origin без личных данных; sync по нему использует токены конкретного пользователя.

## Подключение

1. Создать пространство, затем один или несколько источников через `+`.
2. API сразу ставит discovery-job. Произвольный новый вуз не требует релиза.
3. Проверенный публичный HTML/JSON/CSV и публичный iCal (`text/calendar`) читаются автоматически;
   неоднозначная схема и страницы входа возвращают понятное требование действия.
4. Вузы-пресеты (МИСИС, ВШЭ) и любой Moodle, определённый положительно (маркеры либо структурированная ошибка
   `token.php`/`server.php`, в том числе за SSO), отдают `user_action_required` с `authMethods`: token, username/password
   (штатный обмен `token.php`, пароль после обмена удаляется), `calendarUrl` (личный экспорт календаря Moodle: дедлайны,
   события, курсы по названиям). ВШЭ: Smart LMS `edu.hse.ru` — Moodle за SSO, поэтому первой предлагается ссылка календаря;
   РУЗ `ruz.hse.ru` — `identifier` (почта/ФИО/номер), доступен только из сети ВШЭ (`source_network_restricted` вне её).
   Подробности, статусы проверок и список неподтверждённого — [universities.md](universities.md).
5. OAuth: только после регистрации client/callback оператором. Произвольный
   redirect не переносит cookie чужого домена. Продолжение должно оставаться
   в том же браузере с cookie; открытие другого браузера требует нового входа.
6. Переиспользуется безопасный рецепт, персональные токены/данные разделены.
   Sync запускается вручную и каждые 15 минут для готовых/ошибочных подключений;
   auth-required ждёт пользователя. Истёкший OAuth обновляется через refresh token,
   если провайдер его выдал; revoked grant требует нового входа.

ВШЭ и МИСИС — приоритет при live-приёмке. Фикстуры подтверждают протокол и
границы безопасности, **не подтверждают живой вход** ВШЭ; локальная живая проверка владельца — в [universities.md](universities.md#живая-проверка-владельцем). Универсального
обхода SSO/MFA/CAPTCHA нет. Рецепты — данные, исполнитель не запускает код/curl
из ответа модели. Нет произвольного shell или доступа LLM к секретам.

## Чат и FAQ

Расписание/задания читаются из SQL выбранного пространства; документы — FTS5.
При первом FAQ без локального результата ограниченный reader читает публичные
страницы уже подключённых источников: до 2 seed URL и 2 релевантных ссылок
того же origin, общий бюджет 15 с, TTL 15 минут, максимум 20 тыс. знаков страницы.
Это чтение известных сайтов, не глобальный поисковик и не приватная SSO-сессия.
Новые ссылки cached seed повторно исследуются после TTL. PDF/XLSX и приватные
Google Sheets пока требуют следующего адаптера; CSV/публичный HTML/JSON доступны.

DeepSeek получает ограниченное evidence с происхождением; цитаты проверяются
сервером. Без ключа/при сбое модели возвращается извлечение с источниками и
`mode:'retrieval'`. История сохраняется отдельно и не становится публичным FAQ.
Удаление пространства удаляет его сообщения/документы/FTS/подключения/задачи.

## Конфигурация

См. [деплой и секреты](deployment.md). Для локального запуска передай env из
приватного launcher и выполни `npm --prefix backend start`. Ключ БД — отдельная
base64 строка из 32 случайных байт; не используй Telegram/DeepSeek токен как ключ.
Не коммить env. Для OAuth необязательный `OAUTH_PROVIDERS_JSON` содержит массив:
`id,origin,authorizationEndpoint,tokenEndpoint,clientId,scope` и при необходимости
`clientSecret,issuer`. Это конфигурация оператора, не пользовательский ввод.
Callback: `https://<app>/api/v1/oauth/callback`; refresh token rotation сохраняется
транзакционно. Пока провайдеры не зарегистрированы, `authMethods` пуст.

Лимиты MVP: 20 пространств, 30 источников/пространство, body 64 KiB,
120 API-запросов/мин, 15 запусков задач/мин и 8 вопросов/мин на пользователя.
SQLite/один worker — текущий масштаб; глобальный межсерверный лимитер и
очередь моделей потребуют отдельного расширения перед большим публичным трафиком.
