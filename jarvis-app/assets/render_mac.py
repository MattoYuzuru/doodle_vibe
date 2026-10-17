# Рисунок «окно Терминала macOS» из сохранённого вывода команды — для студентов, которые работают на Mac.
# Вид — по образцу владельца (снимок окна Терминала macOS): окно со скруглёнными углами и тенью, тёмно-серая планка
# #3E3E3E с тремя кнопками (красная #ED6B60, жёлтая #F2C04F, зелёная #61C654) и заголовком «<папка> — -zsh — 80×24»
# (#BDBDBD), под планкой тонкая чёрная линия, область терминала #1E1E1E, моноширинный текст (DejaVu Sans Mono —
# основа шрифта Menlo из macOS). Приглашение — «<папка> % », только имя папки, без придуманных имени пользователя и
# компьютера. Текст красится как в настоящем терминале (termcolor.py): цвета ANSI из файла вывода, ✓/✗, PASSED/FAILED;
# белым остаётся только обычный текст. Текст — ровно из файла вывода, ничего не добавляется и не меняется (длинные строки переносятся).
#
# Запуск: python render_mac.py <файл вывода.txt> <рисунок.png> [папка]
#   папка — где команда реально выполнялась (в приглашении и заголовке — только её имя, как в macOS); если первая
#   строка файла — сама команда (без приглашения), к ней добавляется «<папка> % ».
import os
import sys
import textwrap
import matplotlib
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import termcolor

src, out = sys.argv[1], sys.argv[2]
folder = sys.argv[3] if len(sys.argv) > 3 else None
name = os.path.basename(os.path.normpath(folder)) if folder else "~"
lines = open(src, encoding="utf-8-sig").read().rstrip("\n").split("\n")
if folder and lines and not lines[0].startswith(f"{name} % "):
    lines[0] = f"{name} % {lines[0].lstrip('$ ').strip()}"
COLS = 100
wrapped = termcolor.layout(lines, COLS, termcolor.MAC_BASIC, (0xFF, 0xFF, 0xFF))

S = 2  # рисуем в двойном размере, как снимок с экрана Retina
mono = ImageFont.truetype(os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf", "DejaVuSansMono.ttf"), 13 * S)
ui = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 13 * S)
char_w, line_h = mono.getlength("M"), int(13 * S * 1.32)
cols = max(80, max(sum(len(t) for t, _ in r) for r in wrapped)); rows = len(wrapped)  # размер в заголовке — как у нарисованного окна
bar_h, pad = 28 * S, 6 * S
win_w = int(cols * char_w + 2 * pad)
win_h = bar_h + 1 * S + pad * 2 + line_h * len(wrapped)
margin = 40 * S  # место под тень

win = Image.new("RGBA", (win_w, win_h), (0, 0, 0, 0))
d = ImageDraw.Draw(win)
r = 10 * S
d.rounded_rectangle((0, 0, win_w - 1, win_h - 1), r, fill=(0x1E, 0x1E, 0x1E, 255))
d.rounded_rectangle((0, 0, win_w - 1, bar_h + r), r, fill=(0x3E, 0x3E, 0x3E, 255))
d.rectangle((0, bar_h, win_w - 1, bar_h + r + 1), fill=(0x1E, 0x1E, 0x1E, 255))
d.line((0, bar_h, win_w, bar_h), fill=(0, 0, 0, 255), width=S)
for i, c in enumerate([(0xED, 0x6B, 0x60), (0xF2, 0xC0, 0x4F), (0x61, 0xC6, 0x54)]):
    cx, cy, rr = (14 + 20 * i) * S, bar_h // 2, 6 * S
    d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=c + (255,))
title = f"{name} — -zsh — {cols}×{rows}"
tw = d.textlength(title, font=ui)
icon_w = 16 * S
tx = (win_w - tw - icon_w - 6 * S) / 2
# значок папки, как в заголовке Терминала
fy = bar_h // 2 - 6 * S
d.rounded_rectangle((tx, fy + 2 * S, tx + icon_w, fy + 13 * S), 2 * S, fill=(0x4A, 0x9E, 0xF0, 255))
d.rounded_rectangle((tx, fy, tx + 7 * S, fy + 4 * S), 1 * S, fill=(0x4A, 0x9E, 0xF0, 255))
d.text((tx + icon_w + 6 * S, bar_h // 2), title, font=ui, fill=(0xBD, 0xBD, 0xBD, 255), anchor="lm")
y = bar_h + S + pad
SYMBOLS = "✓✔✗✘"  # нет в DejaVu Sans Mono не бывает, но на всякий случай берём из Segoe UI Symbol
sym_font = ImageFont.truetype(r"C:\Windows\Fonts\seguisym.ttf", 13 * S)
for row in wrapped:
    x = pad
    for text, color in row:
        for ch in text:
            d.text((x, y), ch, font=sym_font if ch in SYMBOLS and mono.getmask(ch).getbbox() is None else mono, fill=color + (255,))
            x += char_w
    y += line_h
# рамка окна — тонкая светлая линия по краю, как у тёмных окон macOS
d.rounded_rectangle((0, 0, win_w - 1, win_h - 1), r, outline=(0x5A, 0x5A, 0x5A, 255), width=S)

canvas = Image.new("RGBA", (win_w + 2 * margin, win_h + 2 * margin), (255, 255, 255, 0))
shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((margin, margin + 8 * S, margin + win_w, margin + win_h + 8 * S), r, fill=(0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(14 * S))
canvas = Image.alpha_composite(canvas, shadow)
canvas.alpha_composite(win, (margin, margin))
# Белая подложка: в отчёте рисунок стоит на белой странице, а прозрачность не все конвертеры в PDF передают одинаково.
bg = Image.new("RGB", canvas.size, (255, 255, 255))
bg.paste(canvas, mask=canvas.split()[3])
bg.save(out)
print(out, bg.size)
