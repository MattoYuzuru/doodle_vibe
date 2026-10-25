# Локальная разработка

Статус: командный путь установки и проверок. Полный прежний production-runtime
не запускается этими командами. Фактический результат прогона указывается в PR.

## Runtime и установка

Команды выполняются из корня репозитория. Нужны Node.js **24** с npm и Python
**3.14** с `venv`. Версия Node задана репозиторными `.nvmrc`/`.node-version`;
не меняй глобальные настройки других проектов. Используй lockfile и `npm ci`.

macOS / Linux:

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
export PYTHON="$PWD/.venv/bin/python"
npm ci
npm run bootstrap
npx playwright install chromium
```

На чистом Linux runner системные библиотеки браузера устанавливаются через
`npx playwright install --with-deps chromium`. GitHub Actions выполняет это в
своём disposable runner; это не инструкция менять общий сервер.

Chromium для backend (удалённый браузер входа в вуз) использует запиненный
`playwright-core` из `backend/package.json`; он не скачивает браузеры при `npm ci`.
Версия браузера привязана к версии пакета (сейчас 1.63.0, как и у `@playwright/test`
в корне, поэтому локальный кэш общий). Установка и проверка:

```bash
node backend/node_modules/playwright-core/cli.js install chromium   # Linux runner: добавь --with-deps
npm run test:chromium
```

Smoke запускает Chromium с включённым OS-sandbox (без `--no-sandbox`), открывает `data:`-страницу,
проверяет рендер и получение кадра CDP `Page.startScreencast`; внешняя сеть заблокирована.
Версию `playwright-core` обновляй только вместе с lockfile и документацией; не берите релиз младше двух недель.

В Windows используй установленный Python 3.14, `py -3.14 -m venv .venv`,
`.venv\Scripts\python.exe -m pip install -r requirements-test.txt` и переменную
`PYTHON` с абсолютным путём к `.venv\Scripts\python.exe`. Команды npm те же.
Часть исторических PowerShell/Windows-сценариев не входит в переносимый CI.

## Команды из корня

| Команда | Область |
|---|---|
| `npm run bootstrap` | Установка зависимостей backend и Mini App по их lockfile |
| `npm run check` | Синтаксис исходников и ссылки/структура актуальной документации |
| `npm run typecheck` | Проверка TypeScript Mini App |
| `npm run build` | Сборка Mini App |
| `npm run test:unit` | Выбранные локальные проверки функций и форматов |
| `npm run test:web` | Unit-тесты чистых модулей Mini App (логика маскота) в Node с фиксированными часами |
| `npm run test:integration` | Изолированные проверки модулей с локальными поддельными сервисами |
| `npm run test:platform` | SQLite, HTTP, auth, источники и retrieval на синтетических данных |
| `npm run test:deploy` | Python-фикстуры release/backup/rollback без SSH |
| `npm run test:e2e` | Браузерные smoke-сценарии собранного UI с синтетическим API |
| `npm run test:chromium` | Smoke рантайма Chromium для backend: sandbox, рендер `data:`-страницы, CDP screencast |
| `npm test` | Unit, web unit, integration и platform; не включает browser smoke и сборку |
| `npm run ci` | Check, typecheck, test, deploy, build, browser smoke и Chromium smoke последовательно |

После изменения зависимостей обновляй соответствующий lockfile. Наличие
`node_modules` с чужого компьютера не заменяет установку по lockfile.

## Разработка UI

```bash
npm --prefix jarvis-app/web run dev
```

Каталог маскотов (DES-005) открывается на том же dev-сервере: `/mascot-catalog.html`. Он показывает
все состояния Дуси и Вари на синтетических данных и фиксированных часах; параметры адреса
`?character=varya|dusya&theme=light|dark&motion=full|static&size=46|72|120&nightcap=1` дают повторяемый
вид для скриншота. В сборку приложения страница не входит.

Vite запускает интерфейс, но не предоставляет учебный API и не подтверждает
вход в LMS. Демо/фикстуры явно отличаются от живых данных. Не запускай
`server.mjs`, старые watchdog, туннели или OpenClaw ради проверки UI: они могут
использовать локальные секреты и внешние интеграции.

## Изоляция проверок

Репозиторный runner выбирает именованные suites и копирует необходимые исходники
во временные каталоги с синтетическими настройками; сеть ограничена loopback.
Не запускай автоматически все найденные `*-test.mjs`: некоторые исторические
сценарии привязаны к Windows, конкретным портам или прежним каталогам.

Loopback-guard проверяет сетевые обращения Node.js в выбранных доверенных
сценариях; он не является sandbox для произвольного сгенерированного кода.
Browser smoke использует отдельный порт `14173`; при конфликте задай `E2E_PORT`.
Не останавливай чужой процесс и не подключай тест к уже запущенному серверу.

Новый backend: `npm --prefix backend start`, с внешней приватной конфигурацией.
Живая проверка источников владельцем (ВШЭ и другие вузы, без Telegram/HTTP):
`npm --prefix backend run live -- --env-file <файл> --university hse`; см.
[universities.md](universities.md#живая-проверка-владельцем). Агент её не запускает.
Требования к env и API — в [Backend API](backend-api.md). Legacy UI требует
перевода на v1; маршруты не считаются автоматически совместимыми. Основной
runtime порт — `18110` на loopback.

Отчёты создаются в `artifacts/` и не коммитятся. Не помещай туда реальные
браузерные профили, личные ответы, токены или дампы. Перед общим прогоном в
разделяемом checkout остановите изменения исходников; один участник владеет
runtime, портами и итоговым результатом.

Если мешает версия runtime или отсутствует зависимость, зафиксируй конкретный
сбой и исправь окружение в границах задачи. Не сбрасывай чужие контейнеры,
кэши или данные. Реальные LMS/SSO/Telegram и деплой требуют отдельного сценария.

Подробные границы доказательств: [TESTING.md](TESTING.md).
