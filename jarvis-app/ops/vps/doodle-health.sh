#!/bin/bash
# Сторож VPS Doodle (17 окт 2026): раз в 5 минут проверяет, жив ли сервер, и пишет владельцу в Telegram, если нет.
# Бот сам о своём падении сообщить не может, поэтому проверка — отдельной службой systemd (doodle-health.timer).
#
# Что проверяется:
#   - служба doodle и туннель doodle-tunnel запущены, сервер отвечает на 127.0.0.1:8787;
#   - адрес Mini App из tunnel.log открывается снаружи (быстрый туннель Cloudflare иногда умирает молча);
#   - свободной памяти больше 120 МБ, диск занят меньше чем на 85%.
# Одна и та же беда напоминается не чаще раза в 6 часов; когда проходит — приходит «✅ снова в порядке».
# Вызов с аргументом failed (из doodle.service.d/alert.conf, OnFailure) — сразу сообщить, что служба упала совсем.
#
# Установка (под root, из рабочей копии):
#   install -m 755 ops/vps/doodle-health.sh /usr/local/bin/doodle-health
#   cp ops/vps/doodle-health.service ops/vps/doodle-health.timer ops/vps/doodle-health-failed.service /etc/systemd/system/
#   mkdir -p /etc/systemd/system/doodle.service.d && cp ops/vps/doodle-alert.conf /etc/systemd/system/doodle.service.d/alert.conf
#   systemctl daemon-reload && systemctl enable --now doodle-health.timer
# Проверить отправку: doodle-health test

APP=/home/doodle/moodle-work/jarvis-app
OWNER=${OWNER_ID:-945210206}
STATE=/var/lib/doodle-health
REPEAT=$((6 * 3600))
mkdir -p "$STATE"

send() {
  local token
  token=$(tr -d ' \r\n' < "$APP/bot-token.txt" 2>/dev/null) || return 1
  [ -n "$token" ] || return 1
  # Адрес с токеном — через -K из stdin, чтобы токен не светился в списке процессов.
  local code
  code=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -s -m 20 -o /dev/null -w '%{http_code}' -K - --data-urlencode "chat_id=$OWNER" --data-urlencode "text=$1")
  [ "$code" = "200" ]
}

# problem <ключ> <текст> — сообщить, если давно не сообщали; ok <ключ> <текст> — сообщить, что прошло.
problem() {
  local f="$STATE/$1" now
  now=$(date +%s)
  if [ ! -f "$f" ] || [ $((now - $(cat "$f"))) -ge $REPEAT ]; then
    send "⚠️ VPS Doodle: $2" && echo "$now" > "$f"
  fi
}
ok() {
  if [ -f "$STATE/$1" ]; then send "✅ VPS Doodle: $2" && rm -f "$STATE/$1"; fi
}

case "$1" in
  test) send "🔔 VPS Doodle: проверка оповещений — всё работает" && echo sent || echo "не отправилось"; exit ;;
  failed) send "🛑 VPS Doodle: служба doodle упала и не поднимается после нескольких попыток — бот не отвечает. Посмотреть: journalctl -u doodle -n 50"; exit ;;
esac

if ! systemctl is-active -q doodle; then
  problem doodle "служба doodle не запущена — бот не отвечает"
elif [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/)" = "000" ]; then
  problem doodle "служба doodle запущена, но сервер не отвечает (завис?)"
else
  ok doodle "бот снова отвечает"
fi

if ! systemctl is-active -q doodle-tunnel; then
  problem tunnel "туннель Mini App (doodle-tunnel) не запущен — Mini App не открывается"
else
  url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$APP/tunnel.log" 2>/dev/null | tail -1)
  if [ -z "$url" ]; then
    problem tunnel "в tunnel.log нет адреса туннеля — Mini App не открывается"
  elif [ "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/")" != "200" ]; then
    # Одна неудача — ещё не беда: перепроверить через минуту.
    sleep 60
    if [ "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/")" != "200" ]; then
      problem tunnel "Mini App не открывается по адресу туннеля $url — помогает systemctl restart doodle-tunnel (адрес сменится, бот пришлёт новый)"
    fi
  else
    ok tunnel "Mini App снова открывается"
  fi
fi

avail=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$avail" -lt 120 ]; then
  problem memory "свободной памяти осталось ${avail} МБ — пора поднять тариф до 2 ГБ"
else
  ok memory "памяти снова хватает (${avail} МБ свободно)"
fi

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$disk" -ge 85 ]; then
  problem disk "диск занят на ${disk}% — почистить server.log и старые копии или увеличить диск"
else
  ok disk "на диске снова есть место (${disk}% занято)"
fi
