# Референсы: официальные скриншоты популярных планировщиков и заметочников из App Store, по два на приложение.
from PIL import Image, ImageDraw, ImageFont

F = "C:/Windows/Fonts/segoeuib.ttf"
FR = "C:/Windows/Fonts/segoeui.ttf"
APPS = [
    ("things", "Things 3", "тихий белый, серые подзаголовки, синие чекбоксы"),
    ("structured", "Structured", "лента дня по часам, цветные иконки"),
    ("todoist", "Todoist", "простой список, один красный акцент"),
    ("bear", "Bear", "заметки: типографика и много воздуха"),
    ("notion", "Notion", "документ как основа, серые блоки"),
]
W, H, PAD, TOP = 300, 650, 24, 110
sheet = Image.new("RGB", (PAD + len(APPS) * (2 * W + PAD + 8), TOP + H + 90), "#141416")
d = ImageDraw.Draw(sheet)
d.text((PAD, 30), "Как это делают популярные приложения", font=ImageFont.truetype(F, 40), fill="#ffffff")
for i, (key, name, hint) in enumerate(APPS):
    x0 = PAD + i * (2 * W + PAD + 8)
    for j in (1, 2):
        path = next(p for p in (f"{key}-{j}.jpg", f"{key}-{j}.webp") if __import__("os").path.exists(p))
        im = Image.open(path).convert("RGB")
        im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS).crop((0, 0, W, H))
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), 28, fill=255)
        x = x0 + (j - 1) * (W + 8)
        sheet.paste(im, (x, TOP), mask)
    d.text((x0, TOP + H + 22), name, font=ImageFont.truetype(F, 28), fill="#ffffff")
    d.text((x0, TOP + H + 56), hint, font=ImageFont.truetype(FR, 20), fill="#a1a1a6")
sheet.save("../refs-popular-apps.png", optimize=True)
print(sheet.size)
