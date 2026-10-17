"""
Логическая схема в программе Digital (H. Neemann — современный преемник Logisim / замена Electronics Workbench):
из описания элементов строит файл схемы .dig, проверяет её в самой программе по таблице истинности и выгружает рисунок.

    python dig_logic.py <описание.json> --out <папка>

Описание (UTF-8):
    {"name": "f3",
     "inputs": ["x3", "x2", "x1"],                       // старший аргумент первым — как столбцы таблицы истинности
     "gates": [{"id": "n2", "type": "NAnd", "in": ["x2", "x2"]},      // инвертор на И-НЕ: оба входа на один сигнал
               {"id": "a",  "type": "NAnd", "in": ["x3", "n2"]},
               {"id": "f",  "type": "NAnd", "in": ["a", "b", "c"]}],  // входы — имена аргументов или id других элементов
     "outputs": {"f": "f"},                              // имя выхода → id элемента
     "expect": {"f": [0, 1, 0, 0, 1, 1, 0, 1]}}          // столбец f таблицы истинности, наборы в порядке двоичного счёта
Типы элементов: And, NAnd, Or, NOr, XOr, XNOr (2 и больше входов), Not (один вход).

В папке --out: <name>.dig (открывается в Digital), <name>.svg и <name>.png (рисунок схемы: прямоугольные элементы
«&», «1», «=1» по ГОСТ/IEC, провода под прямым углом, точки соединений), <name>-test.txt (итог проверки программой).
Код 0 — схема построена и прошла проверку по expect; 2 — программа нашла расхождение (схема не реализует функцию:
исправь описание, а не рисунок); 1 — ошибка в описании.
"""
import argparse
import json
import os
import subprocess
import sys
from xml.sax.saxutils import escape

JAVA = r"D:\Android\jdk17\bin\java.exe"
JAR = r"C:\Users\User\moodle-work\tools\Digital\Digital.jar"
G = 20  # шаг сетки Digital
WIDTH = {"And": 3, "Or": 3, "XOr": 3, "NAnd": 4, "NOr": 4, "XNOr": 4, "Not": 2}  # от входов до выхода, в шагах сетки


def fail(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def pin_rows(n):
    """Строки входов элемента (в шагах сетки): при чётном числе входов Digital пропускает середину — там выход."""
    return [i + (1 if n % 2 == 0 and i >= n // 2 else 0) for i in range(n)]


def build(spec):
    inputs = list(spec["inputs"])
    gates = {g["id"]: g for g in spec["gates"]}
    if len(gates) != len(spec["gates"]):
        fail("id элементов повторяются")
    for g in gates.values():
        if g["type"] not in WIDTH:
            fail("%s: неизвестный тип %r (есть: %s)" % (g["id"], g["type"], ", ".join(WIDTH)))
        if g["type"] == "Not" and len(g["in"]) != 1 or g["type"] != "Not" and len(g["in"]) < 2:
            fail("%s: у %s должно быть %s" % (g["id"], g["type"], "ровно один вход" if g["type"] == "Not" else "два входа или больше"))
        for s in g["in"]:
            if s not in gates and s not in inputs:
                fail("%s: вход %r — не аргумент и не id элемента" % (g["id"], s))
        if g["id"] in inputs:
            fail("id элемента %r совпадает с именем аргумента" % g["id"])
    outs = spec["outputs"]
    for name, src in outs.items():
        if src not in gates:
            fail("выход %s: нет элемента %r" % (name, src))

    # Уровень элемента — на один больше самого дальнего из его входов (аргументы — уровень 0).
    level = {}

    def lv(i, seen=()):
        if i in inputs:
            return 0
        if i in seen:
            fail("в схеме петля через элемент %s — для комбинационной схемы так нельзя" % i)
        if i not in level:
            level[i] = 1 + max(lv(s, seen + (i,)) for s in gates[i]["in"])
        return level[i]

    for i in gates:
        lv(i)
    used = set()
    for g in gates.values():
        used.update(g["in"])
    for i in gates:
        if i not in used and i not in outs.values():
            fail("элемент %s никуда не подключён (ни к другому элементу, ни к выходу)" % i)

    # Порядок по вертикали: элемент стоит между своими входами (обход «левые входы — сам — правые»), у каждого своя полоса.
    order = []

    def walk(i):
        if i in inputs or i in order or i in walking:
            return
        walking.add(i)
        kids = [s for s in gates[i]["in"] if s in gates]
        half = (len(kids) + 1) // 2
        for s in kids[:half]:
            walk(s)
        order.append(i)
        for s in kids[half:]:
            walk(s)

    walking = set()
    for src in outs.values():
        walk(src)
    for i in gates:
        walk(i)

    n_levels = max(level.values())
    per_level = [sum(1 for i in gates if level[i] == L) for L in range(n_levels + 1)]
    # Колонки: входы и их вертикальные шины слева, дальше — уровень элементов и за ним канал под шины его выходов.
    x_in = 0
    rail_x = {s: (3 + k) * G for k, s in enumerate(inputs)}
    col_x, x = {}, (3 + len(inputs) + 2) * G
    track_x = {}
    for L in range(1, n_levels + 1):
        col_x[L] = x
        members = [i for i in order if level[i] == L]
        for k, i in enumerate(members):
            track_x[i] = x + (5 + k) * G
        x += (5 + per_level[L] + 2) * G
    x_out = x

    in_y = {s: (k * 2) * G for k, s in enumerate(inputs)}
    y = (len(inputs) * 2 + 1) * G
    pos, pin_y, out_xy = {}, {}, {}
    for i in order:
        g = gates[i]
        rows = pin_rows(len(g["in"]))
        pos[i] = (col_x[level[i]], y)
        pin_y[i] = [y + r * G for r in rows]
        mid = y if g["type"] == "Not" else y + (max(rows) // 2) * G
        out_xy[i] = (col_x[level[i]] + WIDTH[g["type"]] * G, mid)
        y += (max(rows) + 2) * G

    elements, wires = [], []

    def el(name, x, y, attrs=None):
        elements.append((name, x, y, attrs or []))

    def wire(a, b):
        if a != b:
            wires.append((a, b))

    taps = {s: [] for s in list(inputs) + list(gates)}  # сигнал → точки (y) на его вертикальной шине
    for s in inputs:
        el("In", x_in, in_y[s], [("Label", "string", s)])
        wire((x_in, in_y[s]), (rail_x[s], in_y[s]))
        taps[s].append(in_y[s])
    for i in order:
        g = gates[i]
        attrs = [] if g["type"] == "Not" or len(g["in"]) == 2 else [("Inputs", "int", str(len(g["in"])))]
        el(g["type"], pos[i][0], pos[i][1], attrs)
        for s, py in zip(g["in"], pin_y[i]):
            sx = rail_x[s] if s in inputs else track_x[s]
            wire((sx, py), (pos[i][0], py))
            taps[s].append(py)
    for name, src in outs.items():
        ox, oy = out_xy[src]
        el("Out", x_out, oy, [("Label", "string", name)])
        wire((ox, oy), (x_out, oy))
    for i in gates:
        if taps[i]:
            ox, oy = out_xy[i]
            wire((ox, oy), (track_x[i], oy))
            taps[i].append(oy)
    for s, ys in taps.items():
        sx = rail_x[s] if s in inputs else track_x[s]
        pts = sorted(set(ys))
        for a, b in zip(pts, pts[1:]):  # шина кусками между отводами: Digital соединяет провода только в их концах
            wire((sx, a), (sx, b))

    expect = spec.get("expect") or {}
    if expect:
        rows = 1 << len(inputs)
        for name, col in expect.items():
            if name not in outs:
                fail("expect: нет выхода %r" % name)
            if len(col) != rows:
                fail("expect.%s: нужно %d значений (по числу наборов), дано %d" % (name, rows, len(col)))
        names = list(expect)
        lines = [" ".join(inputs + names)]
        for r in range(rows):
            bits = [(r >> (len(inputs) - 1 - k)) & 1 for k in range(len(inputs))]
            lines.append(" ".join(str(v) for v in bits + [int(expect[nm][r]) for nm in names]))
        el("Testcase", x_in, y + G, [("Testdata", "test", "\n".join(lines) + "\n")])

    out = ['<?xml version="1.0" encoding="utf-8"?>', "<circuit>", "  <version>2</version>", "  <attributes/>", "  <visualElements>"]
    for name, ex, ey, attrs in elements:
        out += ["    <visualElement>", "      <elementName>%s</elementName>" % name]
        if attrs:
            out.append("      <elementAttributes>")
            for key, kind, val in attrs:
                out += ["        <entry>", "          <string>%s</string>" % key]
                if kind == "test":
                    out += ["          <testData>", "            <dataString>%s</dataString>" % escape(val), "          </testData>"]
                else:
                    out.append("          <%s>%s</%s>" % (kind, escape(val), kind))
                out.append("        </entry>")
            out.append("      </elementAttributes>")
        else:
            out.append("      <elementAttributes/>")
        out += ['      <pos x="%d" y="%d"/>' % (ex, ey), "    </visualElement>"]
    out += ["  </visualElements>", "  <wires>"]
    for a, b in wires:
        out += ["    <wire>", '      <p1 x="%d" y="%d"/>' % a, '      <p2 x="%d" y="%d"/>' % b, "    </wire>"]
    out += ["  </wires>", "  <measurementOrdering/>", "</circuit>", ""]
    return "\n".join(out), bool(expect)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dpi", type=int, default=200)
    a = ap.parse_args()
    try:
        spec = json.load(open(a.spec, encoding="utf-8-sig"))
        for k in ("name", "inputs", "gates", "outputs"):
            spec[k]
    except (OSError, ValueError, KeyError) as e:
        fail("описание не читается: %s" % e)
    xml, has_test = build(spec)
    os.makedirs(a.out, exist_ok=True)
    base = os.path.join(os.path.abspath(a.out), spec["name"])
    with open(base + ".dig", "w", encoding="utf-8") as f:
        f.write(xml)

    def cli(*args):
        r = subprocess.run([JAVA, "-Djava.awt.headless=true", "-cp", JAR, "CLI", *args], capture_output=True, timeout=120)
        return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace").strip()

    code, text = cli("svg", "-dig", base + ".dig", "-svg", base + ".svg", "-hideTest")
    if code or not os.path.isfile(base + ".svg"):
        fail("Digital не смог выгрузить рисунок: " + text)
    import fitz  # PyMuPDF: SVG → PNG
    doc = fitz.open(base + ".svg")
    doc[0].get_pixmap(dpi=a.dpi, alpha=False).save(base + ".png")
    made = "%s.dig, %s.svg, %s.png" % ((spec["name"],) * 3)
    if not has_test:
        print("ok (без проверки: в описании нет expect): " + made)
        return
    code, text = cli("test", "-circ", base + ".dig", "-verbose")
    with open(base + "-test.txt", "w", encoding="utf-8") as f:
        f.write("java -cp Digital.jar CLI test -circ %s.dig -verbose\n%s\n" % (spec["name"], text))
    if code:
        fail("Digital: схема НЕ совпала с таблицей истинности (см. %s-test.txt):\n%s" % (spec["name"], text[:1500]), 2)
    print("ok, проверка по таблице истинности пройдена в Digital: " + made + ", %s-test.txt" % spec["name"])


if __name__ == "__main__":
    main()
