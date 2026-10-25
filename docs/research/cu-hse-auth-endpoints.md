# ЦУ и ВШЭ: вход и read-only API (исследование)

Статус: исследование от **2026-10-25**; входные данные для пресетов входа, менеджера браузерных сессий и learned recipes.
Это не контракт: форматы рецептов ниже — **черновики**, их нужно свести с ADR-0005 и
`auth-sessions-contract.md` (на момент написания в `main` их нет). Связанные документы:
[Вузы](../universities.md), [ADR-0004](../adr/0004-universal-source-types.md).

## Как это собрано и границы

- **Анонимно:** только публичные GET (страницы входа, `.well-known`, публичные JS-бандлы, 401-ответы). Без входа,
  паролей, POST и отправки форм, без обхода защиты. Значения токенов и cookies не читались и здесь не приводятся.
- **Chrome владельца (по его явному разрешению «только структура»):** в уже открытой сессии ЦУ выполнены GET-запросы
  к собственному API фронта; сохранены только имена эндпоинтов, статусы и **схема** JSON (имена и типы полей).
  Значения, ПДн (ФИО, ИНН, СНИЛС, телефон, e-mail), идентификаторы курсов и людей в документ не попали.
  `lk.hse.ru` в том же Chrome оказался **не авторизован** (`/api/get-user` → 401), поэтому его закрытое API
  проверено только по публичному бандлу.
- Навык владельца `central-university-lms` (дата его заметок: 2026-07-14) прочитан как текст; ничего из него не запускалось.
- Нагрузочных проб не было: лимиты запросов не измерялись.

Обозначения уверенности: **Ф** — факт, наблюдаемый в этот день; **Н** — взято из навыка/внешних сведений, сегодня не
проверено; **П** — предположение/вывод.

## 1. ЦУ (`my.centraluniversity.ru`)

### 1.1 Факты (2026-10-25)

| # | Утверждение | Ур. | Источник проверки |
|---|---|---|---|
| CU-1 | IdP — **Keycloak**, realm `central-university`, хост `id.centraluniversity.ru`; `.well-known/openid-configuration` публичен | Ф | GET discovery |
| CU-2 | `GET id.centraluniversity.ru/` → 301 на `…/realms/central-university/protocol/openid-connect/auth?response_type=code&client_id=api-gateway&scope=openid email offline_access&redirect_uri=https://my.centraluniversity.ru/api/account/signin/callback` | Ф | GET без follow |
| CU-3 | Протокол — OIDC Authorization Code; обмен кода делает **серверный шлюз** (`client_id=api-gateway`, redirect на `/api/account/signin/callback`), а не SPA. PKCE поддержан IdP (`S256`, `plain`) | Ф | discovery + redirect |
| CU-4 | Фронт — Angular SPA (`/learn/...`), конфигурация публична: `GET /dynamical-config/configuration.json` (`authUrl`, `baseApiV1Url=https://my.centraluniversity.ru/api`, `lmsAppUrl`, `selfServiceUrl`, `eduUrl` и др.). Там же лежат публичные SDK-ключи сторонних сервисов — не копировать | Ф | GET |
| CU-5 | Фронт **не ставит заголовок `Authorization`** на запросы к `/api/*`: в бандлах нет такого кода для первой стороны; авторизованные same-origin `fetch(..., {credentials:'include'})` без заголовков возвращают 200. Значит, авторизация — **cookie шлюза** (BFF), JWT в JS не лежит | Ф | бандлы + запросы из сессии |
| CU-6 | Без сессии API отвечает `401`, `content-type: application/problem+json`, заголовок `www-authenticate: Bearer`, тело `{"title":"Unauthorized","status":401,"traceId":"…"}`. Шлюз — Kestrel за nginx | Ф | GET без cookie |
| CU-7 | `GET /api/account/me` — «текущая сессия»: SPA трактует 401 как «не вошёл», иначе читает claims (`sub`, `roles`, `groups`, …). Ключи ответа: `exp, iat, auth_time, jti, iss, aud, sub, typ, azp, sid, acr, allowed-origins, scope, email_verified, roles, groups, phone_number_verified, created_at, preferred_username, locale, middle_name, given_name, name, phone_number, id, family_name, email` | Ф | бандл + запрос из сессии |
| CU-8 | Срок жизни access-токена в claims: `exp − iat = 300 с`. Браузер при этом работает дольше, то есть **обновление делает шлюз по cookie-сессии** | Ф (300 с) / П (механизм обновления) | claims |
| CU-9 | Scope запроса содержит `offline_access` → шлюз держит refresh-токен у себя | Ф (scope) / П (хранение) | redirect |
| CU-10 | Страница входа — кастомная тема Keycloak (Angular), состояния: `emailLogin`, `passwordLogin`, `password`, `otp`, `otpEmail`, `otpConfigure`, `registration`, `updatePassword`, `resetPassword`, `verifyEmail`. Первая страница — ввод e-mail (`activePage = emailLogin`). Регистрация включена (`registrationAllowed`) | Ф | HTML + бандл темы |
| CU-11 | В теме есть код **Google reCAPTCHA v3/v2** (поля `recaptchaV3Token`, `g-recaptcha-response`), сейчас найден на ветке отправки SMS-кода; в HTML первого шага `recaptchaEnabled` не выставлен | Ф (код) / П (когда включается) | бандл темы |
| CU-12 | Куки Keycloak при открытии входа: `AUTH_SESSION_ID`, `KC_RESTART`, `KC_AUTH_SESSION_HASH` (`Secure; SameSite=None`, первые два `HttpOnly`; `KC_AUTH_SESSION_HASH` живёт 60 с) | Ф | Set-Cookie |
| CU-13 | `login-status-iframe` и front-channel logout включены; выход SPA — `/api/account/signout` | Ф | discovery + бандл |
| CU-14 | Видимых признаков WAF/QRATOR у ЦУ нет (`server: nginx`/`Kestrel`, без rate-limit заголовков в наблюдавшихся ответах) | Ф (отсутствие заголовков) | заголовки |

### 1.2 Read-only эндпоинты (все `GET`, cookie-сессия, база `https://my.centraluniversity.ru`)

Схема — из реальных ответов 2026-10-25; значения не сохранялись. «Фронт» — вызывался самим интерфейсом.

| Эндпоинт | Назначение | Схема ответа (ключи) | Ур. |
|---|---|---|---|
| `/api/account/me` | проверка сессии, claims | см. CU-7 | Ф, фронт |
| `/api/micro-lms/students/me` | краткий профиль студента для LMS | `id, lastName, firstName, middleName, universityEmail, timeAccount, studyStartYear, studyLevel, lateDaysBalance` | Ф, фронт |
| `/api/student-hub/students/me` | **полный профиль с ПДн** (ИНН, СНИЛС, дата рождения…) | не использовать и не описывать в рецептах | Ф, фронт |
| `/api/micro-lms/courses/student?limit=&offset=&state=published` | курсы | `items[]{id:number, name, state, category, commitLevel, participationType, subjectId, isArchived, publishDate, publishedAt, settings{skillLevel,isSkillLevelEnabled,syllabusUrl,timeChannelUrl}, blocker}`, `paging{limit,offset,totalCount}` | Ф, фронт |
| `/api/micro-lms/courses/{courseId}/overview` | структура курса | `{id,name,state,isArchived,settings,blocker{enabled,enableAt,score},themes[]{id,name,order,state,publishDate,publishedAt,longreads[]}}`; поля `longreads[]`/`exercises[]` глубже не разбирались (по навыку: `exercises[]{name,maxScore,activity{name,weight},deadline}`) | Ф (до themes), Н (глубже) |
| `/api/micro-lms/courses/{courseId}/student/progress` | баллы курса | `{earnedScore, leftToEarnScore, maxScore}` | Ф |
| `/api/micro-lms/deadlines` | **дедлайны студента** | массив `{id (taskId), state, deadline, createdAt, rejectAt, reviewer, exercise{id,name,type,maxScore,startDate,deadline,activity{id,name,weight,isLateDaysEnabled}}, course{id,name,isArchived}, theme{id,name}, longread{id,name}}`; наблюдавшееся `state`: `backlog` | Ф (в июле навык видел `[]`) |
| `/api/micro-lms/students/me/timetables` | **расписание** | массив `{courseId, courseName, eventRows[]{eventType (lecture/seminar), eventRowNumber, calendarEvent{calendarEventId, eventType, format (напр. offline), location{id,title,building}, hosts[]{name,email}, schedule{startDate:"YYYY-MM-DD", endDate, startTime:"HH:MM", endTime, dayOfWeek:"monday", interval:number, comment}}}}` — недельное правило повторения, не список занятий | Ф, фронт (страница `/learn/timetable`) |
| `/api/micro-lms/longreads/{longreadId}/materials?limit=100&offset=0` | материалы и id заданий лонгрида | `items[]{id, order, type, discriminator, viewType, viewContent, state, publishDate, publishedAt}`, `paging` | Ф |
| `/api/micro-lms/tasks/{taskId}` | карточка задания (в т. ч. ПДн студента — фильтровать) | ключи начинаются с `id, type, state, score, scoreSkillLevel, isSkillLevelEnabled, isLateDaysEnable…` (вывод был усечён) | Ф (частично) |
| `/api/micro-lms/tasks/{taskId}/events`, `…/comments` | история и комментарии | схема не снималась | Н |
| `/api/notification-hub/notifications/in-app/stats` | счётчик уведомлений | не снималась | Ф (200) |
| `/api/micro-lms/calendar-events/slot-management/config`, `/course-selection/student/campaigns`, `/banners`, `/api/admin/configurations/lms-block-requests` | служебные запросы фронта | не снималась | Ф (200/204) |

Запрещено или пока не изучено: любые `POST/PUT/PATCH/DELETE` (сдача работ, `late-days-prolong`/`late-days-cancel`,
комментарии, запись на слоты); «ведомость» по всем курсам — эндпоинта не найдено (Н).

### 1.3 Сессия и срок жизни

- Признак успешного входа: `GET /api/account/me` → `200` + JSON с `sub`; браузер находится на `https://my.centraluniversity.ru/learn/...` (Ф).
- Признак протухания: `GET /api/account/me` → `401` (SPA сама так определяет «нет сессии»), любой `/api/micro-lms/*` → `401 problem+json` (Ф);
  браузер уводит на `id.centraluniversity.ru/realms/central-university/...` (П).
- Срок жизни cookie-сессии шлюза **неизвестен**; навык владельца наблюдал «около 3 недель» для сохранённого состояния
  браузера (Н, июль 2026). Закладывать как оценку, не как гарантию.
- Токена для хранения в хранилище приложения нет: сохранять нужно **cookies сессии шлюза** (имена не выяснены:
  они `HttpOnly`, из JS не видны) — снимать из контекста браузера (П).
- Привязка к IP/устройству: не проверялась. Рефреш-токен у шлюза (CU-9), а cookie `SameSite`/`Domain` не снимались (П).

### 1.4 Бот-защита ЦУ

- Заголовков QRATOR/WAF нет (Ф). В теме входа есть Google reCAPTCHA v3/v2 (Ф, код), включённость на пути email→пароль неизвестна.
- Навык владельца сообщает, что **безголовый вход упирается в Yandex SmartCaptcha** (Н, 2026-07-14; в публичных бандлах
  SmartCaptcha сегодня не найден). Поэтому вход должен идти **живым браузером с участием пользователя**; автоматически капчу не проходим.
- Rate limits: не измерялись; заголовков лимитов не видно.

## 2. ВШЭ

### 2.1 Факты (2026-10-25)

| # | Утверждение | Ур. | Источник |
|---|---|---|---|
| HSE-1 | Все проверенные хосты ВШЭ (`edu.hse.ru`, `saml.hse.ru`, `www.hse.ru`) отвечают `Server: QRATOR` | Ф | заголовки |
| HSE-2 | `edu.hse.ru/` → 303 `/login/index.php` → 303 `/login/hselogin.php` (кнопка «Войти» `/auth/oidckc/`; для локальной учётной записи — `/login/hseloginfull.php`). Cookie сессии Moodle — `MoodleSession` (`path=/; secure`), выдаётся уже анонимному посетителю | Ф | GET |
| HSE-3 | `GET /auth/oidckc/` → 303 на `https://saml.hse.ru/realms/hse/protocol/openid-connect/auth?response_type=code&client_id=smart-lms-edu&scope=openid profile email&nonce=…&response_mode=form_post&state=…&redirect_uri=https://edu.hse.ru/auth/oidckc/&resource=https://saml.hse.ru` | Ф | GET без follow |
| HSE-4 | IdP — **Keycloak**, realm `hse`, хост **`saml.hse.ru`** (а не `auth.hse.ru`: этот хост в цепочке не наблюдался). Название хоста указывает на брокер SAML/ADFS за Keycloak, но это предположение. `.well-known` публичен (PKCE `S256`) | Ф (хост/realm/client) / П (SAML за ним) | GET |
| HSE-5 | Форма входа Keycloak (тема `hse-custom-theme-v1`): поля `username` («Имя пользователя или e-mail»), `password`, скрытые `credentialId`; ссылки «Зарегистрироваться», «Восстановить пароль» (`lk.hse.ru/password_recovery`), `digital@hse.ru`. На первой странице ни OTP, ни капчи нет | Ф | HTML формы (без отправки) |
| HSE-6 | **MFA** на шаге после пароля: неизвестно (без входа не видно) | неизвестно | — |
| HSE-7 | Moodle ≥ 4.5 (`lib/upgrade.txt` → «=== 4.5 Onwards ===»), Apache/2.4.52 (Ubuntu) за QRATOR | Ф | GET |
| HSE-8 | `GET /lib/ajax/service.php` и `/lib/ajax/service-nologin.php` существуют: на пустой запрос отвечают JSON `{"error":"…","errorcode":"invalidjsonrequest",…}` (не 404 и не редирект) | Ф | GET |
| HSE-9 | `GET /login/token.php?service=moodle_mobile_app` → JSON «Отсутствует обязательный параметр (username)»; `/webservice/rest/server.php` → XML `invalidtoken`; `/admin/tool/mobile/launch.php` → 404. Мобильная авторизация через SSO недоступна, токен WS у SSO-студента получить нельзя (П: токен возможен только для локальных учёток) | Ф / П | GET |
| HSE-10 | `lk.hse.ru` — «SmartPoint, единый личный кабинет» (Vue SPA). Вход: Keycloak `saml.hse.ru`, `client_id=elk`, `redirect_uri=https://lk.hse.ru/api/keycloak-auth/`, `scope=openid`, realm `hse` (prod) / `hse-dev`; есть и устаревший путь ADFS `/api/adfs-auth`. `GET /api/get-adfs-entry-point` публичен → `{adfs_entry_point}` (origin `https://saml.hse.ru`) | Ф | бандл + GET |
| HSE-11 | Закрытое API `lk.hse.ru` — `GET /api/<имя>`: `get-user`, `get-myschedule`, `get-myschedule-soon`, `get-academic-data`, `get-grants`, `get-my-news`, `get-profile`, `get-learners`, `get-notification-count`, … (имена из бандла). Анонимно `get-user` и `get-myschedule-soon` → **401** | Ф | бандл + GET |
| HSE-12 | **Параметры и схема `get-myschedule`/`get-myschedule-soon` не сняты** (нужна авторизованная сессия `lk.hse.ru`, в этом Chrome её не было) | неизвестно | — |
| HSE-13 | Страница `www.hse.ru/eduland/schedule/`: «Доступ к РУЗ осуществляется только из внутренней сети НИУ ВШЭ… расписание всегда доступно в **Едином личном кабинете**» и в приложении **HSE App** | Ф | GET |
| HSE-14 | `ruz.hse.ru/*` (в т. ч. `/api/search`, `/ruzservice.svc/`) из внешней сети → 302 на `www.hse.ru/eduland/schedule/`. Это сетевая блокировка, не вопрос формата | Ф | GET |
| HSE-15 | `api.hse.ru` отвечает nginx 404 на корень; публичного API приложения HSE App не найдено | Ф (404) | GET |
| HSE-16 | Публичного iCal-расписания вне личного кабинета не найдено; у `lk.hse.ru` в бандле нет `webcal`/`.ics` | Ф (не найдено) | бандл |

### 2.2 Read-only методы Moodle AJAX (`/lib/ajax/service.php`) — **предположения**

Метод AJAX вызывается как `POST /lib/ajax/service.php?sesskey=<sesskey>&info=<method>` с телом `[{"index":0,"methodname":"…","args":{…}}]`,
`sesskey` берётся из страницы (`M.cfg.sesskey`) после входа. Это **POST по транспорту, но чтение по смыслу**: рецепты
должны явно разрешать такие вызовы по allowlist методов, это нужно решить в ADR-0005. Сегодня не проверено ничего, кроме
существования эндпоинта (HSE-8); список ниже — из исходников Moodle 4.x, годность на `edu.hse.ru` надо подтвердить с сессией.

| Назначение | `methodname` | Ключевые `args` | Ключевые поля ответа | Ур. |
|---|---|---|---|---|
| Курсы студента | `core_course_get_enrolled_courses_by_timeline_classification` | `classification` (`inprogress`/`future`/`past`/`all`), `limit`, `offset`, `sort`, `customfieldname`, `customfieldvalue` | `courses[]{id, fullname, shortname, viewurl, startdate, enddate}`, `nextoffset` | П |
| Задания и события по сроку | `core_calendar_get_action_events_by_timesort` | `timesortfrom`, `timesortto` (unix), `limitnum`, `limittononsuspendedevents` | `events[]{id, name, timesort, course{id,fullname}, url, modulename, action{…}}` | П |
| Месячный календарь | `core_calendar_get_calendar_monthly_view` | `year`, `month`, `courseid`, `categoryid`, `includenavigation`, `mini` | `weeks[].days[].events[]` | П |
| Ближайшие события | `core_calendar_get_calendar_upcoming_view` | `courseid`, `categoryid` | `events[]` | П |

Альтернатива без sesskey: личная ссылка экспорта календаря (`/calendar/export_execute.php?userid=…&authtoken=…`) уже заведена
как пресет (`calendar_url`, [universities.md](../universities.md)); в Chrome-сессии её можно получить через интерфейс календаря (П).

### 2.3 Сессия и срок жизни (ВШЭ)

- Признак успешного входа в Smart LMS (П): после возврата на `https://edu.hse.ru/` нет редиректа на `/login/…`, на странице
  `M.cfg.userId` ≠ 0 и доступен `sesskey`; cookie `MoodleSession` обновлена.
- Протухание (П): редирект на `/login/index.php` или `hselogin.php`; AJAX отвечает ошибкой авторизации/`servicerequireslogin`.
  Срок жизни `MoodleSession` и SSO-сессии Keycloak неизвестен.
- Для ЕЛК (П): признак входа — `GET /api/get-user` → 200 (анонимно — 401, Ф); протухание — снова 401.
- Привязка к IP/устройству: не проверялась. Сетевое ограничение только у РУЗ (HSE-14).

### 2.4 Бот-защита и лимиты (ВШЭ)

- QRATOR на всех хостах (HSE-1). Это значит: нужен нормальный браузерный отпечаток и умеренная частота запросов; **обход не делаем**.
  Если QRATOR покажет проверку браузера — это сигнал «нужен вход человека», как для капчи.
- Капчи на первой странице входа нет (HSE-5); MFA неизвестна (HSE-6).
- Rate limits: не измерялись.

### 2.5 Расписание ВШЭ вне сети ВШЭ

1. **РУЗ** — недоступен (HSE-14); оставить пресет `ruz.hse.ru` как «только из сети ВШЭ».
2. **ЕЛК `lk.hse.ru`** — официально заявленный путь (HSE-13). После Keycloak-входа (`client_id=elk`) расписание отдают
   `GET /api/get-myschedule` и `/api/get-myschedule-soon`. Схема неизвестна: **первая задача для сессии с входом владельца** —
   снять её по рецепту ниже (только GET, только схема).
3. **Moodle-календарь** `edu.hse.ru` (экспорт iCal / `core_calendar_*`) — дедлайны и события курсов, но не полное расписание пар (П).
4. HSE App — мобильное приложение; его API публично не найден (HSE-15), не рассматриваем.

## 3. Черновики пресетов входа

Формат — черновик для A/C; поля сводятся с `auth-sessions-contract.md`. Все пресеты предполагают **удалённый браузер
с входом пользователя**, секреты не вводятся агентом.

```json
{
  "draft": "login-preset/v0",
  "id": "cu",
  "name": "Центральный университет",
  "timeZone": "Europe/Moscow",
  "start": { "url": "https://my.centraluniversity.ru/learn/courses/view/actual/all",
             "note": "неавторизованный запрос приводит на id.centraluniversity.ru" },
  "idp": { "kind": "oidc-keycloak", "issuer": "https://id.centraluniversity.ru/realms/central-university",
           "clientId": "api-gateway", "flow": "authorization_code (обмен на шлюзе)" },
  "loginPages": { "origin": "https://id.centraluniversity.ru", "pathPrefix": "/realms/central-university/" },
  "steps": ["emailLogin", "passwordLogin|otpEmail|otp|otpConfigure"],
  "success": {
    "allOf": [
      { "urlOrigin": "https://my.centraluniversity.ru", "urlPathPrefix": "/learn" },
      { "probe": { "method": "GET", "url": "https://my.centraluniversity.ru/api/account/me", "expectStatus": 200, "jsonHas": ["sub"] } }
    ]
  },
  "expired": { "probe401": ["/api/account/me"], "redirectOrigin": "https://id.centraluniversity.ru" },
  "mfa": { "possible": true, "kinds": ["otp", "otpEmail"], "automate": false },
  "captcha": { "possible": true, "kinds": ["recaptcha-v3/v2", "yandex-smartcaptcha (по навыку)"], "automate": false },
  "capture": { "what": "cookies сессии my.centraluniversity.ru (HttpOnly), без JWT/localStorage",
               "storage": "encrypted", "lifetimeHintDays": 21, "lifetimeKnown": false },
  "sessionBinding": { "ip": "unknown", "device": "unknown" },
  "errors": [
    { "signal": "страница id.… содержит сообщение об ошибке входа", "code": "login_failed" },
    { "signal": "GET /api/account/me → 401 после возврата в my.…", "code": "source_auth_required" }
  ]
}
```

```json
{
  "draft": "login-preset/v0",
  "id": "hse-smartlms",
  "name": "НИУ ВШЭ — Smart LMS (edu.hse.ru)",
  "timeZone": "Europe/Moscow",
  "start": { "url": "https://edu.hse.ru/auth/oidckc/",
             "note": "через /login/hselogin.php; кнопка «Войти»; локальная учётка — /login/hseloginfull.php" },
  "idp": { "kind": "oidc-keycloak", "issuer": "https://saml.hse.ru/realms/hse",
           "clientId": "smart-lms-edu", "responseMode": "form_post", "scope": "openid profile email" },
  "loginPages": { "origin": "https://saml.hse.ru", "pathPrefix": "/realms/hse/",
                  "fields": ["username", "password"] },
  "success": {
    "allOf": [
      { "urlOrigin": "https://edu.hse.ru", "urlPathNot": ["/login/", "/auth/"] },
      { "pageProbe": "M.cfg.userId != 0 и M.cfg.sesskey непустой", "status": "inferred" }
    ]
  },
  "expired": { "redirectPathPrefix": "/login/" },
  "mfa": { "possible": "unknown", "automate": false },
  "captcha": { "possible": false, "note": "на первой странице нет; QRATOR может показать проверку" },
  "botProtection": { "waf": "QRATOR", "automate": false },
  "capture": { "what": "cookies edu.hse.ru (MoodleSession) + sesskey с загруженной страницы", "storage": "encrypted",
               "lifetimeKnown": false },
  "errors": [
    { "signal": "остались на saml.hse.ru после отправки формы", "code": "login_failed" },
    { "signal": "редирект на /login/ при последующем запросе", "code": "source_auth_required" }
  ]
}
```

```json
{
  "draft": "login-preset/v0",
  "id": "hse-elk",
  "name": "НИУ ВШЭ — Единый личный кабинет (lk.hse.ru)",
  "start": { "url": "https://lk.hse.ru/" },
  "idp": { "kind": "oidc-keycloak", "issuer": "https://saml.hse.ru/realms/hse", "clientId": "elk",
           "redirectUri": "https://lk.hse.ru/api/keycloak-auth/", "scope": "openid" },
  "loginPages": { "origin": "https://saml.hse.ru", "pathPrefix": "/realms/hse/" },
  "success": { "probe": { "method": "GET", "url": "https://lk.hse.ru/api/get-user", "expectStatus": 200 } },
  "expired": { "probe401": ["/api/get-user"] },
  "mfa": { "possible": "unknown", "automate": false },
  "capture": { "what": "cookies lk.hse.ru", "storage": "encrypted", "lifetimeKnown": false },
  "note": "SSO-сессия saml.hse.ru общая с edu.hse.ru: после входа в один сервис второй может пройти без ввода пароля (П)"
}
```

## 4. Черновики рецептов эндпоинтов

Формат черновика: `urlTemplate`, `method`, `auth` (источник авторизации), `bootstrap` (значения, получаемые до основного вызова),
`map` (поля ответа → общие модели `courses` / `schedule` / `deadlines` / `documents`). Выражения путей — точечные,
`[]` — перебор массива. **Ничего не отправляющие вызовы:** только `GET`, кроме отдельно помеченного Moodle AJAX.

### 4.1 ЦУ

```json
{
  "draft": "recipe/v0",
  "university": "cu",
  "auth": { "kind": "browser-session-cookies", "origin": "https://my.centraluniversity.ru", "headers": "none" },
  "check": { "method": "GET", "urlTemplate": "https://my.centraluniversity.ru/api/account/me", "ok": 200, "expired": 401 },
  "endpoints": {
    "courses": {
      "method": "GET",
      "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/courses/student?limit=100&offset=0&state=published",
      "paging": { "limit": "limit", "offset": "offset", "total": "paging.totalCount" },
      "map": { "items": "items[]", "id": "id", "title": "name", "category": "category",
               "archived": "isArchived", "url": "https://my.centraluniversity.ru/learn/courses/view/actual/{id}",
               "syllabusUrl": "settings.syllabusUrl" }
    },
    "deadlines": {
      "method": "GET",
      "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/deadlines",
      "map": { "items": "[]", "externalId": "id", "title": "exercise.name", "dueAt": "deadline",
               "courseId": "course.id", "courseTitle": "course.name", "state": "state",
               "maxScore": "exercise.maxScore", "startsAt": "exercise.startDate",
               "group": "theme.name", "url": null }
    },
    "schedule": {
      "method": "GET",
      "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/students/me/timetables",
      "map": {
        "items": "[].eventRows[].calendarEvent",
        "context": { "courseId": "[].courseId", "courseTitle": "[].courseName" },
        "externalId": "calendarEventId", "kind": "eventType", "format": "format",
        "location": ["location.title", "location.building"], "hosts": "hosts[].name",
        "recurrence": { "startDate": "schedule.startDate", "endDate": "schedule.endDate", "startTime": "schedule.startTime",
                        "endTime": "schedule.endTime", "weekday": "schedule.dayOfWeek", "intervalWeeks": "schedule.interval" }
      },
      "notes": ["это правило повторения, а не список занятий: нужно развернуть в даты", "часовой пояс не передан — по умолчанию Europe/Moscow (П)", "не сохранять hosts[].email"]
    },
    "progress": {
      "method": "GET",
      "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/courses/{courseId}/student/progress",
      "bootstrap": { "courseId": "courses.items[].id" },
      "map": { "earned": "earnedScore", "left": "leftToEarnScore", "max": "maxScore" }
    },
    "documents": {
      "method": "GET",
      "chain": [
        { "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/courses/{courseId}/overview",
          "bootstrap": { "courseId": "courses.items[].id" }, "yields": { "longreadId": "themes[].longreads[].id" } },
        { "urlTemplate": "https://my.centraluniversity.ru/api/micro-lms/longreads/{longreadId}/materials?limit=100&offset=0",
          "map": { "items": "items[]", "externalId": "id", "kind": "type", "viewType": "viewType", "state": "state" } }
      ],
      "status": "схема `longreads[]` в overview не снята; ссылки на файлы в materials не проверены"
    }
  },
  "forbidden": ["/api/student-hub/students/me", "любые POST/PUT/PATCH/DELETE"]
}
```

### 4.2 ВШЭ — Smart LMS (Moodle AJAX, предположение)

```json
{
  "draft": "recipe/v0",
  "university": "hse",
  "source": "https://edu.hse.ru",
  "auth": { "kind": "browser-session-cookies", "origin": "https://edu.hse.ru", "cookie": "MoodleSession" },
  "bootstrap": [
    { "name": "sesskey", "from": "page-js", "page": "https://edu.hse.ru/my/", "expr": "M.cfg.sesskey", "status": "inferred" }
  ],
  "transport": {
    "kind": "moodle-ajax",
    "request": "POST https://edu.hse.ru/lib/ajax/service.php?sesskey={sesskey}&info={methodname}",
    "body": "[{\"index\":0,\"methodname\":\"{methodname}\",\"args\":{args}}]",
    "readOnlyAllowlist": ["core_course_get_enrolled_courses_by_timeline_classification", "core_calendar_get_action_events_by_timesort"],
    "decision": "нужно ли разрешать POST только для allowlist — решает ADR-0005"
  },
  "endpoints": {
    "courses": {
      "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
      "args": { "classification": "all", "limit": 100, "offset": 0, "sort": "fullname asc" },
      "map": { "items": "[0].data.courses[]", "id": "id", "title": "fullname", "url": "viewurl" }
    },
    "deadlines": {
      "methodname": "core_calendar_get_action_events_by_timesort",
      "args": { "timesortfrom": "{nowUnix}", "timesortto": "{nowUnix+8w}", "limitnum": 50, "limittononsuspendedevents": true },
      "map": { "items": "[0].data.events[]", "externalId": "id", "title": "name", "dueAt": "timesort (unix)",
               "courseId": "course.id", "courseTitle": "course.fullname", "url": "url" }
    }
  },
  "errorSignals": { "expired": "[0].error == true и errorcode servicerequireslogin / редирект на /login/", "status": "inferred" },
  "status": "все методы и пути ответов — из исходников Moodle 4.x; на edu.hse.ru не проверялись"
}
```

### 4.3 ВШЭ — ЕЛК (расписание вне сети ВШЭ)

```json
{
  "draft": "recipe/v0",
  "university": "hse",
  "source": "https://lk.hse.ru",
  "auth": { "kind": "browser-session-cookies", "origin": "https://lk.hse.ru" },
  "check": { "method": "GET", "urlTemplate": "https://lk.hse.ru/api/get-user", "ok": 200, "expired": 401 },
  "endpoints": {
    "schedule": {
      "method": "GET",
      "urlTemplate": "https://lk.hse.ru/api/get-myschedule",
      "params": "unknown: снять схему и параметры (период?) в авторизованной сессии",
      "fallbackProbe": "https://lk.hse.ru/api/get-myschedule-soon",
      "map": "unknown"
    }
  },
  "status": "эндпоинты найдены в публичном бандле; анонимно 401; схему ответа ещё нужно снять"
}
```

## 5. Расхождения с исходным заданием и документами репозитория

- IdP ВШЭ — **`saml.hse.ru`**, не `auth.hse.ru` (HSE-4). Клиенты: `smart-lms-edu` (LMS), `elk` (ЕЛК).
- Навык ЦУ говорит о хранении состояния браузера и SmartCaptcha; сегодня фронт ЦУ работает на cookie-сессии шлюза без
  заголовка `Authorization`, а в публичном коде входа найдена только Google reCAPTCHA (CU-5, CU-11).
- `GET /api/micro-lms/deadlines` в июле возвращал `[]`, сегодня отдаёт элементы — использовать его, обход курсов не нужен (Ф).
- В `universities.md` ВШЭ сказано «Keycloak/OIDC» без хоста; уточнено выше. Пресет `hse` в `presets.mjs` не менялся.

## 6. Открытые вопросы и следующие проверки

1. Снять схему `lk.hse.ru /api/get-myschedule` и `-soon` и параметры периода — нужна сессия владельца в ЕЛК (только GET, только схема).
2. Подтвердить на `edu.hse.ru` методы Moodle AJAX и признак входа (`M.cfg.userId`, `sesskey`) — нужна сессия владельца.
3. Узнать, есть ли MFA после пароля на `saml.hse.ru` и в какой момент в ЦУ включается reCAPTCHA/SmartCaptcha.
4. Имена и срок жизни cookies шлюза ЦУ и `MoodleSession`; привязка к IP/устройству; поведение при смене IP сервера.
5. Решение для ADR-0005: допустимы ли read-only POST (Moodle AJAX) в декларативных рецептах и как это ограничить allowlist.
6. Снять схему `overview.themes[].longreads[]`/`exercises[]` и `tasks/{id}` без ПДн для рецепта `documents` ЦУ.
