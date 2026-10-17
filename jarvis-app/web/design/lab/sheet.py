# Сводный лист лаборатории: 8 вариантов Главной в два ряда.
from PIL import Image, ImageDraw, ImageFont

F = "C:/Windows/Fonts/segoeuib.ttf"
FR = "C:/Windows/Fonts/segoeui.ttf"
RAW, OUT = "../raw", "../lab-variants.png"
SHOTS = [
    ("paper", "1 · Бумага"), ("swiss", "2 · Швейцарский"), ("bento", "3 · Бенто"), ("aurora", "4 · Аврора"),
    ("dial", "5 · Циферблат"), ("line", "6 · Лента"), ("pastel", "7 · Пастель"), ("term", "8 · Терминал"),
]
W, H, PAD, TOP, COLS = 390, 844, 36, 120, 4
rows = (len(SHOTS) + COLS - 1) // COLS
sheet = Image.new("RGB", (PAD + COLS * (W + PAD), TOP + rows * (H + 80)), "#141416")
d = ImageDraw.Draw(sheet)
d.text((PAD, 34), "Варианты оформления — Главная", font=ImageFont.truetype(F, 44), fill="#ffffff")
for i, (name, label) in enumerate(SHOTS):
    im = Image.open(f"{RAW}/lab-{name}.png").convert("RGB").resize((W, H), Image.LANCZOS)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), 36, fill=255)
    x = PAD + (i % COLS) * (W + PAD)
    y = TOP + (i // COLS) * (H + 80)
    d.rounded_rectangle((x - 3, y - 3, x + W + 2, y + H + 2), 39, outline="#3a3a3c", width=3)
    sheet.paste(im, (x, y), mask)
    d.text((x + W // 2, y + H + 36), label, font=ImageFont.truetype(FR, 28), fill="#d1d1d6", anchor="mm")
sheet.save(OUT, optimize=True)
print(OUT, sheet.size)
