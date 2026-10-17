# Лабы в Linux (WSL): для курсов, где методичка требует держать стенд в домашней папке дистрибутива, а не на диске
# Windows (преподаватель «Оптимизации клиент-серверных приложений» делал замечание за стенд на C:\).
#
#   python wsl_lab.py setup --id <owner|telegram id> --name "<Фамилия>"
#       Linux-пользователь студента в Ubuntu: у владельца ПК — его обычный пользователь WSL, у остальных — свой
#       (имя — фамилия латиницей), чтобы стенды и выводы разных студентов не смешивались и в чужом отчёте не было
#       чужого имени. Создаётся один раз, запоминается в moodle-work\wsl-users.json. Печатает JSON {user, home, host}.
#
#   python wsl_lab.py run --user <пользователь> --key <ключ лабы> --cwd ~/<папка> --out <...\work\out\имя.txt> -- "<команда bash>"
#       Выполняет команду в Ubuntu от имени пользователя в настоящем терминале (псевдотерминал через script, 120 колонок,
#       интерактивный bash — те же цвета и псевдонимы, что видит студент). Имя проекта Docker Compose — lab-<ключ>
#       (переменная окружения, в команде его не видно). Сохраняет:
#         имя.txt   — первая строка команда, дальше итоговый экран без цветов (его читать и брать из него числа);
#         имя.ansi  — то же с исходными цветами и управляющими кодами (для render_wsl.py);
#         имя.meta.json — пользователь, компьютер, папка, ширина окна (для приглашения на рисунке).
#       Код выхода — код команды.
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vt  # noqa: E402

DISTRO = os.environ.get("WSL_DISTRO", "Ubuntu")
COLS, ROWS = 120, 50
# Список tgId → пользователь Linux лежит в moodle-work, а она — на три уровня выше этого файла
# (moodle-work\jarvis-app\assets\wsl_lab.py), а не в домашней папке: агент может работать под своей учётной записью
# Windows (doodle-agent, ops\migrate\УЧЁТКА-АГЕНТА.md), и домашняя папка у него другая. Там же есть общая папка
# агента agent-shared (в корень moodle-work ему писать нельзя) — тогда список в ней.
WORK = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHARED = os.path.join(WORK, "agent-shared")
MAP_FILE = os.environ.get("WSL_USERS_FILE") or os.path.join(SHARED if os.path.isdir(SHARED) else WORK, "wsl-users.json")
TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f",
                                                    "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"]))


def wsl(args, user=None, input_=None, timeout=120):
    cmd = ["wsl.exe", "-d", DISTRO] + (["-u", user] if user else []) + ["-e"] + args
    return subprocess.run(cmd, input=input_, capture_output=True, timeout=timeout)


def out(r):
    return r.stdout.decode("utf-8", "replace").strip()


def to_wsl_path(p):
    p = os.path.abspath(p).replace("\\", "/")
    m = re.match(r"^([A-Za-z]):/(.*)$", p)
    return f"/mnt/{m.group(1).lower()}/{m.group(2)}" if m else p


def translit(name):
    s = "".join(TR.get(ch, ch) for ch in name.strip().lower())
    s = re.sub(r"[^a-z0-9]", "", s)[:24]
    return s if s and s[0].isalpha() else ("s" + s if s else "student")


def load_map():
    try:
        with open(MAP_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_map(m):
    tmp = MAP_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MAP_FILE)


def setup(args):
    host = out(wsl(["hostname"]))
    if args.id == "owner":
        user = out(wsl(["whoami"]))
        # Запоминаем и пользователя владельца: по списку сторож агента (guard.mjs) отличает «свой» Linux-пользователь лабы от чужого.
        m = load_map()
        if user and m.get("owner") != user:
            m["owner"] = user
            save_map(m)
    else:
        users = {line.split(":")[0]: line.split(":")[4] for line in out(wsl(["getent", "passwd"])).splitlines() if line.count(":") >= 6}
        m = load_map()
        user = m.get(str(args.id))
        if not user:
            base = translit(args.name or "") or "student"
            taken = set(m.values()) | {out(wsl(["whoami"])), "root", "docker", "ubuntu"}
            user, n = base, 2
            # Имя занято чужим пользователем (не заведённым здесь для этого студента) — добавляем номер.
            while user in taken or (user in users and users[user] != f"doodle {args.id}"):
                user, n = f"{base}{n}", n + 1
            m[str(args.id)] = user
            save_map(m)
        if user not in users:
            r = wsl(["/usr/sbin/useradd", "-m", "-s", "/bin/bash", "-c", f"doodle {args.id}", user], user="root")
            if r.returncode:
                sys.exit(f"не удалось завести пользователя {user}: {r.stderr.decode('utf-8', 'replace').strip()}")
        # Docker Desktop в Ubuntu доступен группе docker.
        if "docker" in out(wsl(["getent", "group", "docker"])):
            wsl(["/usr/sbin/usermod", "-aG", "docker", user], user="root")
    home = out(wsl(["sh", "-c", "echo $HOME"], user=user))
    docker = wsl(["docker", "version", "--format", "{{.Server.Version}}"], user=user)
    print(json.dumps({"user": user, "home": home, "host": host, "docker": out(docker) if docker.returncode == 0 else "недоступен: " + docker.stderr.decode("utf-8", "replace").strip()[:200]}, ensure_ascii=False))


def run(args):
    command = args.command.strip("\n")
    if not command:
        sys.exit("пустая команда")
    # От root команды лабы не идут: root читает домашние папки всех студентов (17 окт 2026, ревью). Пакеты ставит подготовка окружения.
    if args.user.strip().lower() == "root" or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", args.user):
        sys.exit(f"пользователь {args.user!r} не подходит: команды лабы — только от своего пользователя (wsl_lab.py setup)")
    cwd = args.cwd
    if not re.fullmatch(r"~(/[\w.@+-]+)*/?|/[\w./@+-]*", cwd):
        sys.exit(f"папка {cwd!r}: нужен путь вида ~/папка (без пробелов)")
    body = "\n".join([
        f"export COMPOSE_PROJECT_NAME=lab-{args.key}" if args.key else "",
        # Постраничный просмотр (less) ждал бы нажатия клавиши, если вывод длиннее окна, — выводим сразу целиком.
        "export PAGER=cat GIT_PAGER=cat PSQL_PAGER=cat SYSTEMD_PAGER= MANPAGER=cat",
        f"cd {cwd} || exit 1",
        command,
        "",
    ])
    fd, script_path = tempfile.mkstemp(prefix="wslrun-", suffix=".sh")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    try:
        inner = f"stty cols {COLS} rows {ROWS} 2>/dev/null; exec bash -ic 'source {to_wsl_path(script_path)}'"
        try:
            r = subprocess.run(["wsl.exe", "-d", DISTRO, "-u", args.user, "--cd", "~", "-e", "script", "-qefc", inner, "/dev/null"],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=args.timeout or None)
        except subprocess.TimeoutExpired as e:
            sys.stderr.write(f"команда не закончилась за {args.timeout} с (ждёт ввода?) — остановлена\n")
            r = subprocess.CompletedProcess(e.cmd, 124, stdout=e.stdout or b"")
    finally:
        os.remove(script_path)
    raw = r.stdout.decode("utf-8", "replace")
    # Служебное сообщение bash о сигналах терминала в начале вывода — не часть вывода команды.
    raw = re.sub(r"^(bash: (cannot set terminal process group|no job control)[^\n]*\n)+", "", raw)
    screen = vt.render_text(raw, COLS)
    host = out(wsl(["hostname"]))
    base = os.path.splitext(args.out)[0]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(command + "\n" + screen + "\n")
    with open(base + ".ansi", "w", encoding="utf-8", newline="\n") as f:
        f.write(command + "\n" + raw)
    with open(base + ".meta.json", "w", encoding="utf-8") as f:
        json.dump({"user": args.user, "host": host, "cwd": cwd, "cols": COLS, "exit": r.returncode}, f, ensure_ascii=False)
    sys.stdout.buffer.write((screen + "\n").encode("utf-8", "replace"))
    sys.stdout.flush()
    return r.returncode


def main():
    p = argparse.ArgumentParser(description="Лабы в WSL")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("--id", required=True)
    s.add_argument("--name", default="")
    r = sub.add_parser("run")
    r.add_argument("--user", required=True)
    r.add_argument("--key", default="")
    r.add_argument("--cwd", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--timeout", type=int, default=1800)  # секунд: команда, ждущая ввода, не повиснет навсегда
    r.add_argument("command")
    a = p.parse_args()
    if a.cmd == "setup":
        setup(a)
    else:
        sys.exit(run(a))


if __name__ == "__main__":
    main()
