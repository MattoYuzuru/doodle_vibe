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

| Метод и маршрут | Запрос / результат |
|---|---|
| GET `/api/v1/me` | `{user,spaces}` |
| GET / POST `/api/v1/spaces` | `{spaces}` / `{universityId,name}` → 201 `{space}` |
| GET / DELETE `/api/v1/spaces/:id` | `{space}` / каскадное удаление |
| GET / POST `/api/v1/spaces/:id/connections` | `{connections}` / `{sourceUrl,kind,label?}` → 202 `{connection,job}` |
| GET / DELETE `/api/v1/connections/:id` | `{connection,authMethods}` / удаление доступа, задач и данных источника |
| POST `/api/v1/connections/:id/auth` | `{origin,token}` либо `{origin,username,password,service?}` → 202 `{saved,job}` |
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

## Подключение

1. Создать пространство, затем один или несколько источников через `+`.
2. API сразу ставит discovery-job. Произвольный новый вуз не требует релиза.
3. Проверенный публичный HTML/JSON/CSV читается автоматически; неоднозначная
   схема и страницы входа возвращают понятное требование действия.
4. МИСИС Moodle: token либо username/password для штатного обмена token.php.
   Пароль после успешного обмена удаляется; токен сохраняется зашифрованно.
   На другом Moodle требуется положительное определение установки.
5. OAuth: только после регистрации client/callback оператором. Произвольный
   redirect не переносит cookie чужого домена. Продолжение должно оставаться
   в том же браузере с cookie; открытие другого браузера требует нового входа.
6. Переиспользуется безопасный рецепт, персональные токены/данные разделены.
   Sync запускается вручную и каждые 15 минут для готовых/ошибочных подключений;
   auth-required ждёт пользователя. Истёкший OAuth обновляется через refresh token,
   если провайдер его выдал; revoked grant требует нового входа.

ВШЭ и МИСИС — приоритет при live-приёмке. Фикстуры подтверждают протокол и
границы безопасности, **не подтверждают живой вход** ВШЭ. Универсального
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
