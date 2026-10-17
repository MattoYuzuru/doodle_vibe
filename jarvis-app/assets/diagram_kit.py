# -*- coding: utf-8 -*-
"""Диаграммы для отчёта: единый стиль, рисование и проверка читаемости.

    python diagram_kit.py render work\\out\\uc.puml [ещё.puml ...] [--page 16.5x21]
    python diagram_kit.py list

render: добавляет к исходнику общий стиль (чёрно-белый, Arial 14, отступы), рисует PNG рядом с исходником
и проверяет результат: пересечения стрелок, стрелки поверх чужих элементов, число элементов, размер текста
на печатной странице. Для каждой диаграммы печатает ширину, с которой её ставить в report.md (width=…cm).

Коды возврата: 0 — все диаграммы годятся; 3 — есть обязательные замечания (исправь исходник и запусти снова);
2 — ошибка в исходнике (номер строки в сообщении); 5 — не запустился PlantUML.

Свой стиль вместо общего: строка «' стиль: свой» в исходнике. Образцы по видам диаграмм — папка diagrams рядом.
"""
import io
import math
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.normpath(os.path.join(HERE, "..", "..", "tools"))
SAMPLES = os.path.join(HERE, "diagrams")
JAVA_ALT = "D:/Android/jdk17/bin/java.exe"
NL = chr(10)

STYLE = """!theme plain
skinparam defaultFontName Arial
skinparam defaultFontSize 14
skinparam shadowing false
skinparam roundCorner 8
skinparam nodesep 35
skinparam ranksep 45
skinparam wrapWidth 190
skinparam maxMessageSize 170
skinparam ArrowColor #000000
skinparam ArrowThickness 1.1
skinparam packageStyle rectangle
skinparam swimlaneTitleFontStyle bold
skinparam sequenceMessageAlign center
skinparam classAttributeIconSize 0
hide circle
hide empty members
""".split(NL)

TARGET_PT = 11.0   # каким должен выйти текст диаграммы на странице
MIN_PT = 8.0       # мельче — не читается, обязательное замечание
SOFT_PT = 9.0
LIMITS = {  # вид: (элементов «многовато», элементов «дели», связей «дели»)
    "DESCRIPTION": (14, 20, 26), "CLASS": (10, 14, 20), "STATE": (10, 14, 20),
    "ACTIVITY": (14, 20, 0), "SEQUENCE": (6, 8, 30),
}
KIND_RU = {"DESCRIPTION": "вариантов использования / компонентов", "CLASS": "классов", "STATE": "состояний",
           "ACTIVITY": "деятельности", "SEQUENCE": "последовательности"}
NUM = re.compile("-?[0-9]+(?:[.][0-9]+)?(?:e-?[0-9]+)?")


def local(tag):
    return tag.rsplit("}", 1)[-1]


def fnum(el, name, default=0.0):
    m = NUM.search(el.get(name) or "")
    return float(m.group(0)) if m else default


def shape_box(el):
    t = local(el.tag)
    if t == "rect":
        x, y = fnum(el, "x"), fnum(el, "y")
        return (x, y, x + fnum(el, "width"), y + fnum(el, "height"))
    if t in ("ellipse", "circle"):
        cx, cy = fnum(el, "cx"), fnum(el, "cy")
        rx = fnum(el, "rx", fnum(el, "r"))
        ry = fnum(el, "ry", fnum(el, "r"))
        return (cx - rx, cy - ry, cx + rx, cy + ry)
    if t == "line":
        xs, ys = (fnum(el, "x1"), fnum(el, "x2")), (fnum(el, "y1"), fnum(el, "y2"))
        return (min(xs), min(ys), max(xs), max(ys))
    if t in ("polygon", "path"):
        v = [float(n) for n in NUM.findall(el.get("points") or el.get("d") or "")]
        xs, ys = v[0::2], v[1::2]
        if xs and ys:
            return (min(xs), min(ys), max(xs), max(ys))
    if t == "text":
        x, y, size = fnum(el, "x"), fnum(el, "y"), fnum(el, "font-size", 14)
        return (x, y - size, x + fnum(el, "textLength", size * len(el.text or "") * 0.55), y + size * 0.3)
    return None


def union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def entity_region(g):
    """Область элемента: большой овал, иначе самый большой прямоугольник, иначе всё вместе."""
    ovals, rects, rest = [], [], []
    for el in g.iter():
        b = shape_box(el)
        if not b:
            continue
        t = local(el.tag)
        if t == "ellipse" and fnum(el, "rx") > 15:
            ovals.append(b)
        elif t == "rect":
            rects.append(b)
        rest.append(b)
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])
    if ovals:
        return ("oval", max(ovals, key=area))
    if rects:
        return ("box", max(rects, key=area))
    return ("box", union(rest)) if rest else None


def inside(region, x, y, pad=3.0):
    kind, (x0, y0, x1, y1) = region
    if kind == "oval":
        rx, ry = (x1 - x0) / 2 - pad, (y1 - y0) / 2 - pad
        if rx <= 0 or ry <= 0:
            return False
        dx, dy = (x - (x0 + x1) / 2) / rx, (y - (y0 + y1) / 2) / ry
        return dx * dx + dy * dy < 1
    return x0 + pad < x < x1 - pad and y0 + pad < y < y1 - pad


def flatten(d):
    """Путь SVG (M, L, C — как пишет PlantUML) в ломаную."""
    out, cur = [], None
    for cmd, body in re.findall("([MLCZ])([^MLCZ]*)", d):
        v = [float(n) for n in NUM.findall(body)]
        pts = list(zip(v[0::2], v[1::2]))
        if cmd in ("M", "L"):
            out.extend(pts)
            cur = pts[-1] if pts else cur
        elif cmd == "C":
            for k in range(0, len(pts) - 2, 3):
                p0, p1, p2, p3 = cur, pts[k], pts[k + 1], pts[k + 2]
                for s in range(1, 13):
                    t = s / 12.0
                    a, b, c, e = (1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3
                    out.append((a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]))
                cur = p3
    return out


def cross(p, q, r, s):
    def side(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2, d3, d4 = side(p, q, r), side(p, q, s), side(r, s, p), side(r, s, q)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0) and min(abs(d1), abs(d2), abs(d3), abs(d4)) > 1e-6


def lines_cross(a, b):
    for i in range(len(a) - 1):
        for j in range(len(b) - 1):
            if cross(a[i], a[i + 1], b[j], b[j + 1]):
                return True
    return False


def title_of(g):
    words = [(el.text or "").strip() for el in g.iter() if local(el.tag) == "text"]
    name = " ".join(w for w in words if w)
    return name if len(name) <= 40 else name[:38] + "…"


def analyse_svg(path):
    root = ET.parse(path).getroot()
    info = {"kind": root.get("data-diagram-type") or "", "w": fnum(root, "width"), "h": fnum(root, "height")}
    sizes = Counter()
    for el in root.iter():
        if local(el.tag) == "text" and (el.text or "").strip():
            sizes[fnum(el, "font-size", 14)] += len(el.text.strip())
    info["font"] = sizes.most_common(1)[0][0] if sizes else 14.0
    info["font_min"] = min(sizes) if sizes else 14.0
    ents, links = {}, []
    for g in root.iter():
        cls = g.get("class")
        if cls == "entity":
            reg = entity_region(g)
            if reg:
                ents[g.get("id")] = {"reg": reg, "name": title_of(g) or (g.get("data-qualified-name") or "").rsplit(".", 1)[-1]}
        elif cls == "link":
            line = []
            for el in g:
                if local(el.tag) == "path":
                    line = flatten(el.get("d") or "")
                    break
            if len(line) > 1:
                links.append({"a": g.get("data-entity-1"), "b": g.get("data-entity-2"), "line": line})
    info["entities"], info["links"] = len(ents), len(links)
    name = lambda k: ents[k]["name"] if k in ents else "?"
    tag = lambda l: "«" + name(l["a"]) + "» → «" + name(l["b"]) + "»"
    crossings, through = [], []
    for i, l in enumerate(links):
        for m in links[i + 1:]:
            if {l["a"], l["b"]} & {m["a"], m["b"]}:
                continue  # сходятся в общем элементе — это не пересечение
            if lines_cross(l["line"], m["line"]):
                crossings.append(tag(l) + "  ×  " + tag(m))
        for key, e in ents.items():
            if key in (l["a"], l["b"]):
                continue
            if any(inside(e["reg"], x, y) for x, y in l["line"]):
                through.append(tag(l) + " проходит поверх «" + e["name"] + "»")
    info["crossings"], info["through"] = crossings, through
    return info


def source_stats(text):
    body = [s.strip() for s in text.splitlines()]
    return {
        "actions": sum(1 for s in body if s.startswith(":") or s.startswith("if ") or s.startswith("while ") or s.startswith("repeat")),
        "lanes": len({s for s in body if len(s) > 2 and s.startswith("|") and s.endswith("|")}),
        "participants": sum(1 for s in body if re.match("(participant|actor|boundary|control|entity|database|collections|queue) ", s)),
        "messages": sum(1 for s in body if re.search("-+>>?|<<?-+", s) and ":" in s),
    }


def is_activity(text):
    return bool(re.search("(?m)^\\s*(start|:[^:].*;|[|][^|]+[|])\\s*$", text))


def styled(text):
    if re.search("(?m)^\\s*'\\s*стиль:\\s*свой", text):
        return text
    out, done = [], False
    for line in text.splitlines():
        if re.match("\\s*skinparam\\s+(dpi|defaultFontSize|defaultFontName|wrapWidth)\\b", line, re.I):
            continue  # размер и шрифт задаёт общий стиль — иначе текст на странице не предсказать
        out.append(line)
        if not done and re.match("\\s*@start", line):
            out.extend(STYLE)
            if is_activity(text):
                out.append("skinparam wrapWidth 115")  # дорожки узкие — иначе диаграмма не влезает в ширину страницы
            done = True
    return NL.join(out) + NL


def plantuml(args):
    java = JAVA_ALT if os.path.exists(JAVA_ALT) else "java"
    cmd = [java, "-DGRAPHVIZ_DOT=" + os.path.join(TOOLS, "graphviz", "bin", "dot.exe"), "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true",
           "-jar", os.path.join(TOOLS, "plantuml.jar"), "-charset", "UTF-8"] + args
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=240)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 99, str(e)
    return r.returncode, (r.stderr or b"").decode("utf-8", "replace") + (r.stdout or b"").decode("utf-8", "replace")


def advise(info, stats, page_w, page_h):
    """Замечания и ширина для report.md."""
    must, soft = [], []
    kind = info["kind"]
    lim = LIMITS.get(kind, (14, 20, 26))
    nat_w, nat_h = info["w"] / 96 * 2.54, info["h"] / 96 * 2.54
    font_pt = info["font"] * 0.75
    k = TARGET_PT / font_pt
    k = min(k, page_w / nat_w, page_h / nat_h)
    width = round(nat_w * k, 1)
    pt = font_pt * k
    how_split = "Раздели на несколько диаграмм (одна роль, один процесс или один пакет — один рисунок) и убери второстепенное."
    if pt < MIN_PT:
        why = "слишком высокая" if page_h / nat_h < page_w / nat_w else "слишком широкая"
        turn = " Или поверни: добавь «left to right direction»." if kind in ("DESCRIPTION", "CLASS", "STATE") and why == "слишком высокая" else ""
        turn = " Или убери «left to right direction» — диаграмма станет уже." if kind in ("DESCRIPTION", "CLASS", "STATE") and why != "слишком высокая" else turn
        must.append("Текст на странице выйдет %.1f пт (нужно не мельче %d): диаграмма %s. %s%s" % (pt, MIN_PT, why, how_split, turn))
    elif pt < SOFT_PT:
        soft.append("Текст на странице выйдет %.1f пт — на пределе читаемости; лучше упростить или разделить." % pt)
    count = {"ACTIVITY": stats["actions"], "SEQUENCE": stats["participants"]}.get(kind, info["entities"])
    what = {"ACTIVITY": "действий и условий", "SEQUENCE": "участников"}.get(kind, "элементов")
    if count > lim[1]:
        must.append("%s: %d — на одном рисунке это не читается (предел %d). %s" % (what.capitalize(), count, lim[1], how_split))
    elif count > lim[0]:
        soft.append("%s: %d — многовато для одного рисунка (удобно до %d)." % (what.capitalize(), count, lim[0]))
    if lim[2] and (info["links"] or stats["messages"]) > lim[2]:
        n = info["links"] or stats["messages"]
        must.append("Связей: %d (предел %d). Оставь главные, однотипные замени одной связью с пакетом или примечанием. %s" % (n, lim[2], how_split))
    if kind == "ACTIVITY" and stats["lanes"] > 4:
        soft.append("Дорожек %d — диаграмма выйдет широкой; обычно хватает 2–4 (объедини близкие роли)." % stats["lanes"])
    fix = ("Как убрать: объявляй элементы в том порядке, в каком они должны стоять; связанные элементы собери в один package; "
           "общий элемент, к которому сходится много стрелок (например «Авторизоваться»), вынеси из пучка — оставь одну-две связи, "
           "остальное скажи примечанием note; выровняй соседей скрытой связью «A -[hidden]- B»; смени направление "
           "(«left to right direction») или длину стрелки («-->» длиннее, «->» короче).")
    if info["through"]:
        must.append("Стрелка идёт поверх чужого элемента (%d): %s. %s" % (len(info["through"]), "; ".join(info["through"][:4]), fix))
    n = len(info["crossings"])
    if n > max(2, info["links"] // 8):
        must.append("Стрелки пересекаются %d раз(а): %s. %s" % (n, "; ".join(info["crossings"][:4]), fix))
    elif n:
        soft.append("Стрелки пересекаются %d раз(а): %s. Если легко — переставь элементы." % (n, "; ".join(info["crossings"][:3])))
    return must, soft, width, pt


def render(files, page_w, page_h):
    worst = 0
    jobs = []
    for f in files:
        f = os.path.abspath(f)
        if not os.path.isfile(f):
            print("НЕТ ФАЙЛА: " + f)
            worst = max(worst, 2)
            continue
        tmp = os.path.join(os.path.dirname(f), "_dk")
        os.makedirs(tmp, exist_ok=True)
        with io.open(f, encoding="utf-8-sig") as fh:
            text = fh.read()
        copy = os.path.join(tmp, os.path.basename(f))
        with io.open(copy, "w", encoding="utf-8", newline=NL) as fh:
            fh.write(styled(text))
        jobs.append((f, copy, text))
    if not jobs:
        return worst
    copies = [j[1] for j in jobs]
    code, log = plantuml(["-tsvg"] + copies)
    if code == 99 or "Unable to access jarfile" in log:
        print("PlantUML не запустился: " + log.strip()[:300])
        return 5
    for f, copy, text in jobs:
        base = os.path.splitext(os.path.basename(f))[0]
        print("== " + os.path.basename(f))
        svg = os.path.splitext(copy)[0] + ".svg"
        bad = None
        for m in re.finditer("Error line ([0-9]+) in file: ([^" + chr(13) + NL + "]*)", log):
            if os.path.basename(m.group(2).strip()) == os.path.basename(copy):
                bad = int(m.group(1))
        if bad is not None or not os.path.isfile(svg):
            own = "свой" in text and re.search("(?m)^\\s*'\\s*стиль:\\s*свой", text)
            line = (bad - (0 if own else len(STYLE) + (1 if is_activity(text) else 0))) if bad else None
            print("  ОШИБКА в исходнике" + (", строка %d" % line if line and line > 0 else "") + ". Проверь синтаксис PlantUML по образцу вида диаграммы.")
            worst = max(worst, 2)
            continue
        try:
            info = analyse_svg(svg)
        except ET.ParseError as e:
            print("  не разобрался рисунок: %s" % e)
            worst = max(worst, 5)
            continue
        must, soft, width, pt = advise(info, source_stats(text), page_w, page_h)
        c2, log2 = plantuml(["-tpng", "-Sdpi=200", "-o", os.path.dirname(f), copy])
        png = os.path.join(os.path.dirname(f), base + ".png")
        if c2 != 0 or not os.path.isfile(png):
            print("  PNG не получился: " + log2.strip()[:200])
            worst = max(worst, 5)
            continue
        kind = KIND_RU.get(info["kind"], info["kind"].lower() or "?")
        print("  диаграмма %s; элементов %d, связей %d; рисунок: %s" % (kind, info["entities"], info["links"], png))
        for s in must:
            print("  ИСПРАВИТЬ: " + s)
        for s in soft:
            print("  замечание: " + s)
        if must:
            worst = max(worst, 3)
        else:
            print("  ГОДИТСЯ. В report.md ставь с шириной width=%scm (текст выйдет %.0f пт)." % (("%.1f" % width).rstrip("0").rstrip("."), pt))
    for d in {os.path.dirname(c) for c in copies}:
        shutil.rmtree(d, ignore_errors=True)
    return worst


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(argv) >= 1 and argv[0] == "list":
        for n in sorted(os.listdir(SAMPLES)) if os.path.isdir(SAMPLES) else []:
            if n.endswith(".puml"):
                head = io.open(os.path.join(SAMPLES, n), encoding="utf-8").read().splitlines()
                note = next((s.lstrip("' ").strip() for s in head if s.startswith("'")), "")
                print(os.path.join(SAMPLES, n) + " — " + note)
        return 0
    if len(argv) >= 2 and argv[0] == "render":
        page_w, page_h, files = 16.5, 21.0, []
        it = iter(argv[1:])
        for a in it:
            if a == "--page":
                m = re.match("([0-9.]+)[xх]([0-9.]+)$", next(it, ""))
                if not m:
                    print("--page: нужно ШИРИНАxВЫСОТА в сантиметрах, например 16.5x21")
                    return 2
                page_w, page_h = float(m.group(1)), float(m.group(2))
            else:
                files.append(a)
        return render(files, page_w, page_h)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
