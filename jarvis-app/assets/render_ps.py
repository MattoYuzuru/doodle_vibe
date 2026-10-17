# Рисунок «окно PowerShell в Терминале Windows 11» из сохранённого вывода команды — для снимков терминала в отчётах.
# Верхняя панель берётся из образца студента powershell-titlebar.png (левая часть с вкладкой и правая с кнопками окна,
# середина заливается цветом полосы #2E2E2E) — только она взята с образца. Ниже область терминала: фон #0C0C0C, Cascadia Mono,
# а текст красится как в настоящем окне (см. termcolor.py): цвета ANSI из файла вывода, подсветка команды как в PSReadLine,
# ✓/✗, ошибки PowerShell, PASSED/FAILED. Не всё подряд серым.
# Текст — ровно из файла вывода, ничего не добавляется и не меняется (длинные строки переносятся, как в терминале).
#
# Запуск: python render_ps.py <файл вывода.txt> <рисунок.png> [папка]
#   папка — где команда реально выполнялась: если первая строка файла — сама команда (без «PS …>»), к ней
#   добавляется приглашение «PS <папка>> », как в настоящем окне.
import os
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import termcolor

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = os.path.join(HERE, "powershell-titlebar.png")
COLS = 120  # ширина окна в символах: длиннее — перенос, как в терминале

src, out = sys.argv[1], sys.argv[2]
cwd = sys.argv[3] if len(sys.argv) > 3 else None
lines = open(src, encoding="utf-8-sig").read().rstrip("\n").split("\n")
if cwd and lines and not lines[0].startswith("PS "):
    lines[0] = f"PS {cwd}> {lines[0].lstrip('$ ').strip()}"
wrapped = termcolor.layout(lines, COLS, termcolor.CAMPBELL, (0xCC, 0xCC, 0xCC), ps_highlight=True)

FONT_PX = 22
font = ImageFont.truetype(r"C:\Windows\Fonts\CascadiaMono.ttf", FONT_PX)
char_w = font.getlength("M")
line_h = int(FONT_PX * 1.35)
pad_x, pad_y = 14, 10

bar = Image.open(TITLE).convert("RGB")
left_w, right_w = 520, 220
width = max(left_w + right_w + 40, int(max(sum(len(t) for t, _ in r) for r in wrapped) * char_w + 2 * pad_x))
top = Image.new("RGB", (width, bar.height), (0x2E, 0x2E, 0x2E))
top.paste(bar.crop((0, 0, left_w, bar.height)), (0, 0))
top.paste(bar.crop((bar.width - right_w, 0, bar.width, bar.height)), (width - right_w, 0))

img = Image.new("RGB", (width, bar.height + pad_y * 2 + line_h * len(wrapped)), (0x0C, 0x0C, 0x0C))
img.paste(top, (0, 0))
d = ImageDraw.Draw(img)
y = bar.height + pad_y
SYMBOLS = "✓✔✗✘"  # нет в Cascadia Mono — берём из Segoe UI Symbol, как делает терминал
sym_font = ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", FONT_PX)
for row in wrapped:
    x = pad_x
    for text, color in row:
        for ch in text:
            d.text((x, y), ch, font=sym_font if ch in SYMBOLS else font, fill=color)
            x += char_w
    y += line_h
img.save(out)
print(out, img.size)
