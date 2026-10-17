# Универсальный сводный лист: python sheet.py "<заголовок>" <out.png> <cols> имя=подпись [имя=подпись ...]
# Берёт raw/<имя>.png (390×844), раскладывает по колонкам, подписывает.
import sys
from PIL import Image, ImageDraw, ImageFont

F = "C:/Windows/Fonts/segoeuib.ttf"
FR = "C:/Windows/Fonts/segoeui.ttf"
title, out, cols, *items = sys.argv[1:]
cols = int(cols)
shots = [tuple(i.split("=", 1)) for i in items]
W, H, PAD, TOP, CAP = 390, 844, 36, 120, 80
rows = (len(shots) + cols - 1) // cols
sheet = Image.new("RGB", (PAD + cols * (W + PAD), TOP + rows * (H + CAP)), "#141416")
d = ImageDraw.Draw(sheet)
d.text((PAD, 34), title, font=ImageFont.truetype(F, 44), fill="#ffffff")
for i, (name, label) in enumerate(shots):
    im = Image.open(f"raw/{name}.png").convert("RGB").resize((W, H), Image.LANCZOS)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), 36, fill=255)
    x = PAD + (i % cols) * (W + PAD)
    y = TOP + (i // cols) * (H + CAP)
    d.rounded_rectangle((x - 3, y - 3, x + W + 2, y + H + 2), 39, outline="#3a3a3c", width=3)
    sheet.paste(im, (x, y), mask)
    d.text((x + W // 2, y + H + 36), label, font=ImageFont.truetype(FR, 26), fill="#d1d1d6", anchor="mm")
sheet.save(out, optimize=True)
print(out, sheet.size)
