# Сводные листы для оценки дизайна: по одному на вариант, 5 экранов в ряд.
import sys
from PIL import Image, ImageDraw, ImageFont
raw, out = "design/raw", "design"
F = "C:/Windows/Fonts/segoeuib.ttf"; FR = "C:/Windows/Fonts/segoeui.ttf"
names = {"a": "Вариант A — «Кошелёк»", "b": "Вариант B — «Карта»", "c": "Вариант C — «Лайм»"}
screens = [("home", "Главная"), ("home-bottom", "Главная, ниже"), ("deadlines", "Дедлайны"), ("plan", "План"), ("notes", "Заметки")]
W, H, PAD, TOP = 390, 844, 36, 120
for v, title in names.items():
    sheet = Image.new("RGB", (PAD + len(screens) * (W + PAD), TOP + H + 70), "#141416")
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 34), title, font=ImageFont.truetype(F, 44), fill="#ffffff")
    for i, (s, label) in enumerate(screens):
        im = Image.open(f"{raw}/{v}-{s}.png").convert("RGB").resize((W, H), Image.LANCZOS)
        mask = Image.new("L", (W, H), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), 36, fill=255)
        x = PAD + i * (W + PAD)
        d.rounded_rectangle((x - 3, TOP - 3, x + W + 2, TOP + H + 2), 39, outline="#3a3a3c", width=3)
        sheet.paste(im, (x, TOP), mask)
        d.text((x + W // 2, TOP + H + 34), label, font=ImageFont.truetype(FR, 26), fill="#a1a1a6", anchor="mm")
    sheet.save(f"{out}/variant-{v.upper()}.png", optimize=True)
    print("saved", f"{out}/variant-{v.upper()}.png", sheet.size)
