#!/usr/bin/env bash
# Проверка Linux VPS под основной сервер Doodle (бот, Mini App, Moodle, журнал, расписание).
# Ничего не устанавливает и не меняет, секретов не нужно. Запуск на VPS:
#   bash check-vps.sh
# Отчёт печатается на экран и сохраняется в ~/check-vps-result.txt — его текст прислать в чат.
# Каждый адрес проверяется 3 раза: имя (DNS), соединение и ответ (HTTP-код, время). Любой HTTP-код,
# даже 403/404, значит «сайт отвечает»; «нет ответа» — сайт недоступен с этого сервера.

OUT="$HOME/check-vps-result.txt"
exec > >(tee "$OUT") 2>&1

line() { printf '%s\n' "------------------------------------------------------------"; }

echo "Doodle: проверка VPS, $(date '+%Y-%m-%d %H:%M:%S %Z')"
line
echo "Система"
. /etc/os-release 2>/dev/null && echo "  ОС: $PRETTY_NAME"
echo "  Ядро: $(uname -r), архитектура $(uname -m)"
echo "  Процессор: $(nproc) ядер, $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')"
echo "  Память: $(free -h | awk '/^Mem:/ {print $2 " всего, " $7 " свободно"}')"
echo "  Диск /: $(df -h / | awk 'NR==2 {print $2 " всего, " $4 " свободно"}')"
echo "  Виртуализация: $(systemd-detect-virt 2>/dev/null || echo неизвестно)"
echo "  Часовой пояс: $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)"
for p in node python3 git curl; do
  if command -v "$p" >/dev/null 2>&1; then echo "  $p: $($p --version 2>&1 | head -1)"; else echo "  $p: нет"; fi
done
if ! command -v curl >/dev/null 2>&1; then
  echo
  echo "Нет curl — проверку сети сделать нечем. Установить: sudo apt install -y curl, затем запустить снова."
  exit 1
fi

line
echo "Адрес сервера в интернете"
IP=$(curl -s -m 8 https://ifconfig.me 2>/dev/null)
echo "  IP: ${IP:-не определился}"
GEO=$(curl -s -m 8 "https://ipinfo.io/json" 2>/dev/null | tr -d '\n' | sed -E 's/.*"city": *"([^"]*)".*"country": *"([^"]*)".*"org": *"([^"]*)".*/\2, \1 (\3)/')
echo "  Где: ${GEO:-не определилось}"

line
echo "DNS: $(grep -m2 '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ' ')"

# name|url|важность (нужен — без него сервис не работает; желателен — работает с ограничениями; справка — для сведения)
TARGETS="
Moodle МИСИС|https://newlms.misis.ru/login/index.php|нужен
Moodle веб-сервис|https://newlms.misis.ru/webservice/rest/server.php|нужен
Электронный журнал|https://ej.misis.ru/|нужен
Вход МИСИС (журнал)|https://id.misis.ru/|нужен
Согласие МИСИС (журнал)|https://consent-id.misis.ru/|нужен
Сайт МИСИС (расписание)|https://misis.ru/students/schedule/|нужен
Telegram Bot API|https://api.telegram.org/|нужен
Дневач (расписание)|https://dnevuch.ru/|желателен
Кампус (оценки преподавателей)|https://campusapp.ru/|желателен
Яндекс Диск (копии)|https://cloud-api.yandex.net/|желателен
Google Таблицы|https://docs.google.com/|желателен
npm (установка)|https://registry.npmjs.org/|нужен
GitHub (код)|https://github.com/|нужен
PyPI (установка)|https://pypi.org/simple/|желателен
Claude API|https://api.anthropic.com/|справка
Claude (сайт)|https://claude.ai/|справка
"

line
echo "Доступность сайтов (3 попытки, время в секундах)"
bad=0; warn=0
while IFS='|' read -r name url need; do
  [ -z "$name" ] && continue
  host=$(echo "$url" | sed -E 's#https?://([^/]+).*#\1#')
  if getent hosts "$host" >/dev/null 2>&1; then dns="ok"; else dns="нет"; fi
  ok=0; res=""
  for i in 1 2 3; do
    r=$(curl -s -o /dev/null -m 15 -A "Mozilla/5.0 Doodle-check" -w '%{http_code} %{time_total}' "$url" 2>/dev/null)
    code=${r%% *}; t=${r##* }
    if [ -n "$code" ] && [ "$code" != "000" ]; then ok=$((ok + 1)); res="$res $code/${t%???}"; else res="$res нет"; fi
  done
  if [ "$ok" -eq 3 ]; then mark="OK  "; elif [ "$ok" -gt 0 ]; then mark="СБОИ"; else mark="НЕТ "; fi
  if [ "$ok" -lt 3 ] && [ "$need" = "нужен" ]; then bad=$((bad + 1)); fi
  if [ "$ok" -lt 3 ] && [ "$need" = "желателен" ]; then warn=$((warn + 1)); fi
  # название — последним: printf считает ширину в байтах, и кириллица сбивает колонки
  printf '  [%s] DNS %-3s;%-24s %s (%s)\n' "$mark" "$dns" "$res" "$name" "$need"
done <<< "$TARGETS"

line
echo "Скорость скачивания (файл 10 МБ)"
sp=$(curl -s -o /dev/null -m 30 -w '%{speed_download}' https://speed.cloudflare.com/__down?bytes=10000000 2>/dev/null)
if [ -n "$sp" ] && [ "${sp%.*}" -gt 0 ] 2>/dev/null; then echo "  $(( ${sp%.*} * 8 / 1000000 )) Мбит/с"; else echo "  не измерилась"; fi

line
if [ "$bad" -eq 0 ]; then
  echo "Итог: все нужные сайты отвечают — сервер подходит под основной сервер Doodle."
else
  echo "Итог: не отвечают нужные сайты ($bad) — сервер под основной сервер Doodle НЕ подходит без доработки."
fi
[ "$warn" -gt 0 ] && echo "Желательных недоступно: $warn — сервис будет работать, но без части функций."
echo "Claude здесь только для сведения: лабы будут на отдельном исполнителе."
echo
echo "Отчёт сохранён: $OUT — пришлите его текст в чат."
