# Рисунок «терминал Ubuntu (WSL)» из вывода, сохранённого wsl_lab.py run, — для курсов, где лабы делаются в Linux.
# Вид — по принятому отчёту студента по ЛР2 «Оптимизации клиент-серверных приложений» (снимки Терминала Windows с
# вкладкой Ubuntu, обрезанные по области текста, без рамки окна): фон #0C0C0C, Cascadia Mono 24 px, шаг строк 28 px,
# схема Campbell; приглашение Ubuntu по умолчанию — «пользователь@компьютер» ярко-зелёным, путь ярко-синим, «$»;
# «жирный» цвет — яркий, как в Терминале Windows. Цвета вывода — те, что дала сама программа (её настоящий терминальный
# вывод из файла .ansi), ничего не перекрашивается и не добавляется.
#
# Запуск: python render_wsl.py <...\work\out\имя.txt> <рисунок.png> [--cursor]
#   рядом с имя.txt должны лежать имя.ansi и имя.meta.json (их пишет wsl_lab.py run);
#   --cursor — в конце пустое приглашение с курсором, как на снимке, сделанном сразу после команды.
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vt  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith("--")]
cursor = "--cursor" in sys.argv
src, out = args[0], args[1]
base = os.path.splitext(src)[0]
if not os.path.exists(base + ".ansi") or not os.path.exists(base + ".meta.json"):
    sys.exit(f"нет {base}.ansi или {base}.meta.json — команду нужно выполнять через wsl_lab.py run")
with open(base + ".ansi", encoding="utf-8", newline="") as f:  # newline="": одиночный \r (перерисовка прогресса) не превращать в перевод строки
    command, _, raw = f.read().partition("\n")
with open(base + ".meta.json", encoding="utf-8") as f:
    meta = json.load(f)
cols = int(meta.get("cols", 120))
cwd = meta["cwd"].rstrip("/") if meta["cwd"] not in ("~", "/") else meta["cwd"]

# Приглашение Ubuntu (PS1 из /etc/skel/.bashrc): \[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$
prompt = f"\x1b[01;32m{meta['user']}@{meta['host']}\x1b[00m:\x1b[01;34m{cwd}\x1b[00m$ "
screen = vt.Screen(cols)
screen.feed(prompt + command.replace("\n", "\r\n") + "\r\n" + raw)
if cursor:
    screen.feed("\r\n" if screen.c else "")
    screen.feed(prompt)
rows = screen.lines()
if cursor:
    cur_row, cur_col = len(rows) - 1, len(rows[-1]) + 1  # ячейка после пробела за «$»

FONT_PX, LINE, PAD_X, PAD_TOP, PAD_BOTTOM = 24, 28, 6, 0, 4
font = ImageFont.truetype(r"C:\Windows\Fonts\CascadiaMono.ttf", FONT_PX)
sym = ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", FONT_PX)
char_w = font.getlength("M")
BG, FG = (0x0C, 0x0C, 0x0C), (0xCC, 0xCC, 0xCC)
width = int(PAD_X * 2 + char_w * (max((len(r) for r in rows), default=1) + 1))
height = PAD_TOP + LINE * len(rows) + PAD_BOTTOM
img = Image.new("RGB", (width, height), BG)
d = ImageDraw.Draw(img)
# Символа нет в Cascadia Mono (вместо него рисуется пустой квадрат) — берём его из Segoe UI Symbol, как делает сам терминал.
NOTDEF = bytes(font.getmask("\ue000"))
has = {}
for i, row in enumerate(rows):
    y = PAD_TOP + i * LINE
    for k, (ch, color) in enumerate(row):
        if ch == " ":
            continue
        if ch not in has:
            has[ch] = ord(ch) < 0x2000 or bytes(font.getmask(ch)) != NOTDEF
        d.text((PAD_X + k * char_w, y), ch, font=font if has[ch] else sym, fill=color or FG)
if cursor:
    x = round(PAD_X + cur_col * char_w)
    y = PAD_TOP + cur_row * LINE + 2
    d.rectangle((x, y, x + 1, y + LINE - 5), fill=FG)
img.save(out)
print(out, img.size)
