@echo off
rem Туннель к серверу приложения.
rem ВАЖНО: бесплатный ngrok показывает страницу-предупреждение любому клиенту с "Mozilla" в User-Agent — в том числе
rem WebView Telegram (пустой экран), политика трафика это не обходит. Поэтому основной туннель — Cloudflare
rem (быстрый, без предупреждений; адрес меняется при каждом запуске и пишется в tunnel.log и current-url.txt).
rem Если есть именованный туннель Cloudflare (config.yml) — используем его: адрес постоянный.
rem --protocol http2: по умолчанию cloudflared ходит по QUIC (UDP), а в сети раздачи с телефона UDP не проходит —
rem туннель вставал с "failed to dial to edge with quic" (1 окт 2026). HTTP/2 идёт по TCP и работает в любой сети.
rem Цикл: если cloudflared завершился сам (не удалось создать туннель — сеть моргнула, "failed to request quick Tunnel"),
rem через 15 секунд пробуем снова. Сторож, когда надо заменить туннель, гасит и cloudflared, и это окно cmd.
rem --edge-bind-address: соединение с Cloudflare идёт с адреса сетевого интерфейса, у которого шлюз по умолчанию (Wi-Fi),
rem то есть В ОБХОД VPN-клиента на ноутбуке. Через VPN поверх мобильной сети туннель рвался каждые ~35 с (1 окт 2026:
rem 52 %% потерь провалами по 10 с через VPN против 2 %% напрямую). Туннелю VPN не нужен; Moodle и Claude идут как раньше.
rem Отключить привязку: создать рядом пустой файл tunnel-nobind.flag.
cd /d "%~dp0"
set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"
:loop
set BIND=
if not exist "%~dp0tunnel-nobind.flag" for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress"`) do set BIND=--edge-bind-address %%i
if exist "%USERPROFILE%\.cloudflared\config.yml" (
  %CF% tunnel --no-autoupdate --protocol http2 %BIND% run jarvis >> tunnel.log 2>&1
) else (
  %CF% tunnel --no-autoupdate --protocol http2 %BIND% --url http://127.0.0.1:8787 >> tunnel.log 2>&1
)
rem пауза 15 с (ping вместо timeout: тот не работает в скрытом окне без ввода)
ping -n 16 127.0.0.1 >nul
goto loop
