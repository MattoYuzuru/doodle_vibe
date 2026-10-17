"""
Сборка схемы LTspice (.asc) из Python: элементы ставятся на сетку, провода тянутся от вывода к выводу — координаты
выводов берутся из библиотеки символов LTspice, вручную их считать не нужно.

    import sys; sys.path.insert(0, r"C:\\Users\\User\\moodle-work\\jarvis-app\\assets")
    from lt_asc import Sheet
    s = Sheet()
    v1 = s.add("voltage", "V1", "PULSE(0 5 0 1n 1n 10m 20m)", at=(96, 80))        # выводы: + (96, 96), − (96, 176)
    r1 = s.add("res", "R1", "1k", at=(304, 80), rot="R90")       # R90 — горизонтально
    c1 = s.add("cap", "C1", "1u", at=(336, 96))
    s.wire(v1.pin(1), r1.pin(2))                                    # от вывода к выводу, с одним изломом
    s.wire(r1.pin(1), c1.pin(1))
    s.wire(c1.pin(2), v1.pin(2), via="hv")
    s.gnd(v1.pin(2)); s.label(c1.pin(1), "out", stub=(48, 0)); s.label(v1.pin(1), "in", stub=(-48, 0))   # метка на отводе
    s.directive(".tran 5m")                                          # .tran / .ac dec 20 10 100k / .dc V1 0 5 0.1 / .op
    s.directive(".meas tran t63 WHEN V(out)=3.16 RISE=1")
    s.save(r"...\\work\\ltspice\\rc.asc")
    print(s.pins_report())                                           # какие выводы где — для самопроверки

Правила: шаг сетки 16 (координаты at кратны 16); pin(n) — по порядку SPICE (у R, C, L, V, I: 1 и 2; у диода 1 — анод;
у npn/pnp: 1 — C, 2 — B, 3 — E; у nmos/pmos: 1 — D, 2 — G, 3 — S), pin("имя") — по имени вывода в символе.
Повороты: R0, R90, R180, R270, с зеркалом — M0, M90, M180, M270. via="vh" — сначала по вертикали, "hv" — сначала по горизонтали.
Символы: res, cap, ind, voltage, current, diode, zener, LED, npn, pnp, nmos, pmos, sw, Opamps\\\\UniversalOpAmp, … —
папка %LOCALAPPDATA%\\LTspice\\lib\\sym (list_symbols() покажет все). Земля обязательна: без неё расчёт не пойдёт.
После save() схему проверяет сам LTspice: python lt_shot.py <схема.asc> … — и по списку цепей <имя>.net видно, что с чем соединено.
"""
import os
import re

SYM = os.path.join(os.environ.get("LOCALAPPDATA", ""), "LTspice", "lib", "sym")
GRID = 16


def list_symbols():
    out = []
    for root, _, files in os.walk(SYM):
        for f in files:
            if f.lower().endswith(".asy"):
                out.append(os.path.relpath(os.path.join(root, f), SYM)[:-4])
    return sorted(out)


def _read(path):
    raw = open(path, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff") or (len(raw) > 1 and raw[1] == 0):
        return raw.decode("utf-16", "replace")
    return raw.decode("utf-8", "replace")


def _load_pins(symbol):
    path = os.path.join(SYM, symbol + ".asy")
    if not os.path.isfile(path):
        raise ValueError("нет символа «%s» в %s — смотри list_symbols()" % (symbol, SYM))
    pins, cur = [], None
    for line in _read(path).splitlines():
        m = re.match(r"\s*PIN\s+(-?\d+)\s+(-?\d+)", line)
        if m:
            cur = {"x": int(m.group(1)), "y": int(m.group(2)), "name": "", "order": len(pins) + 1}
            pins.append(cur)
            continue
        m = re.match(r"\s*PINATTR\s+(\w+)\s+(.*)", line)
        if m and cur is not None:
            if m.group(1) == "PinName":
                cur["name"] = m.group(2).strip()
            elif m.group(1) == "SpiceOrder":
                cur["order"] = int(m.group(2))
    return pins


def _turn(x, y, rot):
    if rot.startswith("M"):
        x = -x
    a = int(rot[1:])
    return {0: (x, y), 90: (-y, x), 180: (-x, -y), 270: (y, -x)}[a]


class Part:
    def __init__(self, symbol, name, value, at, rot):
        self.symbol, self.name, self.value, self.at, self.rot = symbol, name, value, at, rot
        self._pins = _load_pins(symbol)

    def pin(self, which):
        for p in self._pins:
            if p["order"] == which or (isinstance(which, str) and p["name"].lower() == which.lower()):
                dx, dy = _turn(p["x"], p["y"], self.rot)
                return (self.at[0] + dx, self.at[1] + dy)
        raise ValueError("у %s (%s) нет вывода %r; есть: %s" % (self.name, self.symbol, which, ", ".join("%d=%s" % (p["order"], p["name"] or "?") for p in self._pins)))

    def pins(self):
        return {p["order"]: self.pin(p["order"]) for p in self._pins}


class Sheet:
    def __init__(self, width=1200, height=800):
        self.size, self.parts, self.wires, self.flags, self.texts = (width, height), [], [], [], []

    def add(self, symbol, name, value="", at=(0, 0), rot="R0", extra=None):
        """extra — доп. атрибуты, напр. {"Value2": "AC 1"} или {"SpiceLine": "Rser=1"}."""
        if at[0] % GRID or at[1] % GRID:
            raise ValueError("%s: координаты at должны быть кратны %d" % (name, GRID))
        if rot not in ("R0", "R90", "R180", "R270", "M0", "M90", "M180", "M270"):
            raise ValueError("%s: поворот %r" % (name, rot))
        if any(p.name == name for p in self.parts):
            raise ValueError("элемент %s уже есть" % name)
        part = Part(symbol, name, value, at, rot)
        part.extra = extra or {}
        self.parts.append(part)
        return part

    def wire(self, a, b, via="vh"):
        """Провод от точки a к точке b (обычно part.pin(n)); если не на одной линии — с одним изломом."""
        if a[0] == b[0] or a[1] == b[1]:
            if a != b:
                self.wires.append((a, b))
            return
        corner = (a[0], b[1]) if via == "vh" else (b[0], a[1])
        self.wires.append((a, corner))
        self.wires.append((corner, b))

    def path(self, *points):
        """Провод через несколько точек подряд (каждый отрезок — горизонтальный или вертикальный)."""
        for a, b in zip(points, points[1:]):
            if a[0] != b[0] and a[1] != b[1]:
                raise ValueError("отрезок %s → %s не горизонтальный и не вертикальный" % (a, b))
            self.wires.append((a, b))

    def gnd(self, at, stub=32):
        """Земля: короткий отвод вниз и значок земли на его конце (stub=0 — прямо в точке)."""
        end = (at[0], at[1] + stub)
        if stub:
            self.wires.append((at, end))
        self.flags.append((end, "0"))

    def label(self, at, name, stub=None):
        """Метка цепи: на графике она будет V(name). stub=(dx, dy) — вынести метку на отводе, чтобы не легла на элемент."""
        if stub:
            end = (at[0] + stub[0], at[1] + stub[1])
            self.wire(at, end)
            at = end
        self.flags.append((at, name))

    def directive(self, text, at=None):
        self.texts.append((at, "!" + text))

    def comment(self, text, at=None):
        self.texts.append((at, ";" + text))

    def text(self):
        out = ["Version 4", "SHEET 1 %d %d" % self.size]
        out += ["WIRE %d %d %d %d" % (a[0], a[1], b[0], b[1]) for a, b in self.wires]
        out += ["FLAG %d %d %s" % (at[0], at[1], name) for at, name in self.flags]
        for p in self.parts:
            out.append("SYMBOL %s %d %d %s" % (p.symbol, p.at[0], p.at[1], p.rot))
            out.append("SYMATTR InstName %s" % p.name)
            if p.value:
                out.append("SYMATTR Value %s" % p.value)
            out += ["SYMATTR %s %s" % kv for kv in p.extra.items()]
        # Директивы — столбиком под схемой.
        ys = [w[i][1] for w in self.wires for i in (0, 1)] + [p.at[1] + 96 for p in self.parts] + [0]
        xs = [w[i][0] for w in self.wires for i in (0, 1)] + [p.at[0] for p in self.parts] or [0]
        y, x0 = max(ys) + 48, min(xs)
        for at, t in self.texts:
            if at is None:
                at, y = (x0, y), y + 32
            out.append("TEXT %d %d Left 2 %s" % (at[0], at[1], t))
        return "\n".join(out) + "\n"

    def save(self, path):
        if not any(name == "0" for _, name in self.flags):
            raise ValueError("в схеме нет земли: добавь s.gnd(<точка>)")
        if not any(t.startswith("!.") for _, t in self.texts):
            raise ValueError("нет директивы анализа: s.directive('.tran 5m') и т. п.")
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.text())
        return path

    def pins_report(self):
        return "\n".join("%s (%s %s): %s" % (p.name, p.symbol, p.rot, ", ".join("%d%s=%s" % (o, "/" + n if n else "", xy) for o, n, xy in
                         ((q["order"], q["name"], p.pin(q["order"])) for q in p._pins))) for p in self.parts)
