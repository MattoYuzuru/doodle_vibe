# ADR-0003: отдельный Cloudflare-host для Telegram webhook

Статус: Superseded — деплой на mnema и webhook-host удалены по решению владельца
2026-10-26. Ранее: Accepted 2026-10-25.

На mnema прямой обмен с Telegram получил сетевые таймауты. HTTPS приложения
доступен из другого соединения, firewall разрешает 443, исходящие пакеты покидают
хост без ответа. Это подтверждает транспортный сбой, но не его причину у провайдера.

Для webhook используется отдельный `doodle-hook.mnema.app`, Proxied в Cloudflare.
Правило только этого hostname задаёт SSL Strict с проверкой сертификата origin.
Caddy принимает только `POST /api/telegram/webhook`; остальные пути — 404.
Backend независимо проверяет секрет webhook. Основной `doodle.mnema.app`
остаётся DNS-only: Mini App и credentials вузов идут прямо на mnema.

Cloudflare получает доступ к Telegram update и webhook-header; это согласованная
граница доверия. Проксирование всего Mini App расширило бы её на доступ к вузам,
поэтому выбрана отдельная точка входа. Общие правила SSL, firewall и сервисы
Mnema сохраняются.

Ответ `/start` использует штатный метод в JSON webhook-response. Это best-effort
приветствие без результата исполнения; будущие уведомления вне webhook требуют
исходящего доступа к Telegram. Очередь обновлений сохраняется при переключении.
Синтетический тест не доказывает доставку: приёмка проверяет pending count и
отсутствие новых ошибок Telegram.
