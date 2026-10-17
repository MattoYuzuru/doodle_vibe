# Уменьшенная копия рисунка — чтобы агент лабы посмотрел свой рисунок, не загружая в контекст полноразмерный PNG.
# Каждая просмотренная картинка остаётся в контексте до конца хода и перечитывается при каждом следующем вызове модели;
# снимок 1600 px стоит около 1600 токенов, копия 1000 px — около 700 (замер по лабам 14 окт 2026, п. 159 NOTES.md).
# Проверять общий вид (что на рисунке, читаются ли подписи) — по копии; мелкий текст — по фрагменту (--crop) в полном
# размере, а не по всему рисунку.
#
# Запуск: python peek.py <рисунок> [--max 1000] [--crop x0,y0,x1,y1]
#   --max  — наибольшая сторона копии в пикселях (по умолчанию 1000);
#   --crop — вырезать фрагмент в координатах исходного рисунка (копия фрагмента тоже не больше --max).
# Копия ложится в tmp\peek\ рабочей папки лабы (папка, где лежит JOB.json), иначе во временную папку.
# Печатает путь к копии и размеры: «<путь> <ширина>x<высота> (исходный <ширина>x<высота>)».
import argparse
import os
import sys
import tempfile
from PIL import Image


def lab_dir(path):
    d = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.isfile(os.path.join(d, "JOB.json")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows иначе печатает русский текст в cp1251
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--max", type=int, default=1000)
    ap.add_argument("--crop")
    a = ap.parse_args()
    img = Image.open(a.image)
    src = img.size
    name = os.path.splitext(os.path.basename(a.image))[0]
    if a.crop:
        box = tuple(int(v) for v in a.crop.split(","))
        if len(box) != 4:
            sys.exit("--crop: нужно четыре числа x0,y0,x1,y1")
        img = img.crop(box)
        name += "-crop-" + "-".join(str(v) for v in box)
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.convert("RGBA").split()[-1])
        img = bg
    img.thumbnail((a.max, a.max), Image.LANCZOS)
    root = lab_dir(a.image)
    out_dir = os.path.join(root, "tmp", "peek") if root else os.path.join(tempfile.gettempdir(), "peek")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, name + ".png")
    img.save(out, optimize=True)
    print(f"{out} {img.size[0]}x{img.size[1]} (исходный {src[0]}x{src[1]})")


if __name__ == "__main__":
    main()
