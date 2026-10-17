# Маленький эмулятор терминала: сырой вывод программы (как он пришёл в терминал — с цветами ANSI, \r, движением курсора)
# → итоговый экран: строки из символов с цветом. Нужен, чтобы снимок и текст вывода были ровно такими, какими их видно в
# окне терминала после окончания команды: прогресс-бары docker compose и k6 перерисовываются на месте, а не остаются
# десятком промежуточных строк.
#
# Поддерживается то, что реально встречается в выводе docker, k6, pytest, git, grep, ls: печатные символы с переносом
# по ширине окна, \n \r \b \t, CSI A/B/C/D/E/F/G/H/f/K/J/m, сохранение и восстановление курсора (ESC 7/8, CSI s/u),
# заголовок окна (OSC) и режимы (?25l и т. п.) пропускаются.
import re

CAMPBELL = [(0x0C, 0x0C, 0x0C), (0xC5, 0x0F, 0x1F), (0x13, 0xA1, 0x0E), (0xC1, 0x9C, 0x00), (0x00, 0x37, 0xDA), (0x88, 0x17, 0x98), (0x3A, 0x96, 0xDD), (0xCC, 0xCC, 0xCC),
            (0x76, 0x76, 0x76), (0xE7, 0x48, 0x56), (0x16, 0xC6, 0x0C), (0xF9, 0xF1, 0xA5), (0x3B, 0x78, 0xFF), (0xB4, 0x00, 0x9E), (0x61, 0xD6, 0xD6), (0xF2, 0xF2, 0xF2)]

_ESC = re.compile(r"\x1b(?:\[([0-9;?<>=]*)([@-~])|\]([^\x07\x1b]*)(?:\x07|\x1b\\)|([78])|[()][0-9A-Za-z]|[=>c])")


def _xterm256(n, pal):
    if n < 16:
        return pal[n]
    if n < 232:
        n -= 16
        return tuple(0 if v == 0 else 55 + 40 * v for v in (n // 36, (n // 6) % 6, n % 6))
    v = 8 + 10 * (n - 232)
    return (v, v, v)


class Screen:
    def __init__(self, cols=120, pal=CAMPBELL, bold_bright=True):
        self.cols, self.pal, self.bold_bright = cols, pal, bold_bright
        self.rows = [[]]  # строка — список [символ, цвет|None]
        self.r = self.c = 0
        self.fg = None  # None — цвет по умолчанию
        self.base = None  # номер основного цвета 0–7 (для «жирный = яркий»)
        self.bold = False
        self.saved = (0, 0)
        self.pending_wrap = False

    def _row(self, r):
        while len(self.rows) <= r:
            self.rows.append([])
        return self.rows[r]

    def _color(self):
        if self.base is not None:
            return self.pal[self.base + (8 if self.bold and self.bold_bright else 0)]
        return self.fg

    def _put(self, ch):
        if self.pending_wrap:
            self.r += 1
            self.c = 0
            self.pending_wrap = False
        row = self._row(self.r)
        while len(row) < self.c:
            row.append([" ", None])
        cell = [ch, self._color()]
        if self.c < len(row):
            row[self.c] = cell
        else:
            row.append(cell)
        if self.c == self.cols - 1:
            self.pending_wrap = True  # как настоящий терминал: перенос — только когда придёт следующий символ
        else:
            self.c += 1

    def _sgr(self, params):
        p = [int(x) if x.isdigit() else 0 for x in (params or "0").split(";")]
        i = 0
        while i < len(p):
            v = p[i]
            if v == 0:
                self.fg, self.base, self.bold = None, None, False
            elif v == 1:
                self.bold = True
            elif v == 22:
                self.bold = False
            elif 30 <= v <= 37:
                self.base, self.fg = v - 30, None
            elif 90 <= v <= 97:
                self.base, self.fg = None, self.pal[v - 90 + 8]
            elif v == 39:
                self.base, self.fg = None, None
            elif v == 38 and i + 1 < len(p):
                if p[i + 1] == 5 and i + 2 < len(p):
                    self.base, self.fg = None, _xterm256(p[i + 2], self.pal)
                    i += 2
                elif p[i + 1] == 2 and i + 4 < len(p):
                    self.base, self.fg = None, (p[i + 2], p[i + 3], p[i + 4])
                    i += 4
            elif v == 48 and i + 1 < len(p):
                i += 2 if p[i + 1] == 5 else 4 if p[i + 1] == 2 else 0
            i += 1

    def _csi(self, params, final):
        if params.startswith("?") or params.startswith(">") or params.startswith("<") or params.startswith("="):
            return  # режимы терминала (курсор, альтернативный экран и т. п.)
        nums = [int(x) if x.isdigit() else 0 for x in params.split(";")] if params else []
        n = nums[0] if nums and nums[0] > 0 else 1
        self.pending_wrap = False
        if final == "m":
            self._sgr(params)
        elif final == "A":
            self.r = max(0, self.r - n)
        elif final == "B":
            self.r += n
        elif final == "C":
            self.c = min(self.cols - 1, self.c + n)
        elif final == "D":
            self.c = max(0, self.c - n)
        elif final == "E":
            self.r += n
            self.c = 0
        elif final == "F":
            self.r = max(0, self.r - n)
            self.c = 0
        elif final == "G":
            self.c = min(self.cols - 1, max(0, n - 1))
        elif final in "Hf":
            # Абсолютная позиция: считаем от начала вывода (снимок всё равно показывает только эту команду).
            row = nums[0] if nums and nums[0] > 0 else 1
            col = nums[1] if len(nums) > 1 and nums[1] > 0 else 1
            self.r, self.c = row - 1, min(self.cols - 1, col - 1)
        elif final == "K":
            row = self._row(self.r)
            mode = nums[0] if nums else 0
            if mode == 0:
                del row[self.c:]
            elif mode == 1:
                for k in range(min(self.c + 1, len(row))):
                    row[k] = [" ", None]
            else:
                row.clear()
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                del self._row(self.r)[self.c:]
                del self.rows[self.r + 1:]
            elif mode in (2, 3):
                self.rows = [[]]
                self.r = self.c = 0
        elif final == "s":
            self.saved = (self.r, self.c)
        elif final == "u":
            self.r, self.c = self.saved

    def feed(self, text):
        pos = 0
        for m in _ESC.finditer(text):
            self._plain(text[pos:m.start()])
            pos = m.end()
            if m.group(2):
                self._csi(m.group(1) or "", m.group(2))
            elif m.group(4) == "7":
                self.saved = (self.r, self.c)
            elif m.group(4) == "8":
                self.r, self.c = self.saved
        self._plain(text[pos:])
        return self

    def _plain(self, s):
        for ch in s:
            if ch == "\n":
                self.r += 1
                self.c = 0
                self.pending_wrap = False
            elif ch == "\r":
                self.c = 0
                self.pending_wrap = False
            elif ch == "\b":
                self.c = max(0, self.c - 1)
                self.pending_wrap = False
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch == "\x07" or ch < " " and ch != "\x1b":
                continue
            else:
                self._put(ch)

    def lines(self):
        """Итоговый экран: [[(символ, цвет|None), …], …] без пустых строк в конце и пробелов в конце строк."""
        out = []
        for row in self.rows:
            cells = [(ch, col) for ch, col in row]
            while cells and cells[-1][0] == " ":
                cells.pop()
            out.append(cells)
        while out and not out[-1]:
            out.pop()
        return out

    def text(self):
        return "\n".join("".join(ch for ch, _ in row) for row in self.lines())


def render_text(raw, cols=120):
    """Сырой вывод → итоговый текст экрана (без цветов): для файла вывода, который читает агент."""
    return Screen(cols).feed(raw).text()


def has_color(raw):
    return bool(re.search(r"\x1b\[[0-9;]*m", raw))
