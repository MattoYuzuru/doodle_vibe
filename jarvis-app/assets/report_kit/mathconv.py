# Формулы отчёта: LaTeX-подмножество → MathML (свой разборщик рекурсивным спуском) → OMML (формулы Word) через
# MML2OMML.XSL из поставки Microsoft Office. Наружу — latex_to_omml (для writer) и latex_to_mathml (для тестов).
# Любая неразобранная конструкция — MathError с названием команды и позицией, а не «как-нибудь» в отчёте.
import glob
import os
from xml.sax.saxutils import escape, quoteattr

from lxml import etree

from .common import MathError

MML_NS = "http://www.w3.org/1998/Math/MathML"
OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"

GREEK = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
    "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "omicron": "ο", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "ϕ", "varphi": "φ",
    "chi": "χ", "psi": "ψ", "omega": "ω",
    "Alpha": "Α", "Beta": "Β", "Gamma": "Γ", "Delta": "Δ", "Epsilon": "Ε", "Zeta": "Ζ", "Eta": "Η", "Theta": "Θ",
    "Iota": "Ι", "Kappa": "Κ", "Lambda": "Λ", "Mu": "Μ", "Nu": "Ν", "Xi": "Ξ", "Omicron": "Ο", "Pi": "Π", "Rho": "Ρ",
    "Sigma": "Σ", "Tau": "Τ", "Upsilon": "Υ", "Phi": "Φ", "Chi": "Χ", "Psi": "Ψ", "Omega": "Ω",
}
# Знаки-операторы: команда → (символ, обрывает ли знак операнд суммы/интеграла).
OPS = {
    "cdot": ("⋅", False), "times": ("×", False), "div": ("÷", False), "pm": ("±", True), "mp": ("∓", True),
    "le": ("≤", True), "leq": ("≤", True), "ge": ("≥", True), "geq": ("≥", True), "ne": ("≠", True), "neq": ("≠", True),
    "approx": ("≈", True), "equiv": ("≡", True), "sim": ("∼", True), "propto": ("∝", True), "ll": ("≪", True),
    "gg": ("≫", True), "to": ("→", True), "rightarrow": ("→", True), "leftarrow": ("←", True),
    "Rightarrow": ("⇒", True), "Leftrightarrow": ("⇔", True), "leftrightarrow": ("↔", True),
    "in": ("∈", True), "notin": ("∉", True), "subset": ("⊂", True), "subseteq": ("⊆", True),
    "cup": ("∪", True), "cap": ("∩", True), "forall": ("∀", False), "exists": ("∃", False),
    "neg": ("¬", False), "lnot": ("¬", False), "lor": ("∨", True), "vee": ("∨", True), "land": ("∧", True),
    "wedge": ("∧", True), "oplus": ("⊕", True), "circ": ("∘", False), "ldots": ("…", False), "dots": ("…", False),
    "cdots": ("⋯", False), "mid": ("|", True), "parallel": ("∥", True), "perp": ("⊥", True),
}
# Знаки-«буквы» (не операторы): идут в документ обычным прямым символом.
SYMBOLS = {"infty": "∞", "partial": "∂", "nabla": "∇", "varnothing": "∅", "emptyset": "∅", "angle": "∠", "ell": "ℓ",
           "hbar": "ℏ", "degree": "°", "prime": "′"}
NARY = {"sum": ("∑", True), "prod": ("∏", True), "int": ("∫", False), "oint": ("∮", False)}  # True — пределы сверху и снизу
LIMFUNCS = {"lim", "min", "max", "sup", "inf"}  # индекс пишется под названием
FUNCS = {"sin", "cos", "tan", "tg", "ctg", "cot", "ln", "log", "lg", "exp", "arcsin", "arccos", "arctan", "arctg",
         "sinh", "cosh", "tanh", "sh", "ch", "th", "det", "arg", "sign", "rank", "gcd"} | LIMFUNCS
ACCENTS = {"overline": "¯", "bar": "¯", "hat": "\u0302", "widehat": "\u0302", "vec": "\u20d7", "dot": "\u0307",
           "ddot": "\u0308", "tilde": "\u0303", "widetilde": "\u0303"}
SPACES = {",": "\u2009", ":": "\u2005", ";": "\u2004", "!": "", " ": "\u00a0", "quad": "\u2003", "qquad": "\u2003\u2003"}
ESCAPED = {"{": "{", "}": "}", "%": "%", "_": "_", "#": "#", "&": "&", "$": "$", "|": "‖"}
DELIMS = {"(": "(", ")": ")", "[": "[", "]": "]", "|": "|", ".": "", "/": "/", "\\{": "{", "\\}": "}", "\\|": "‖",
          "\\langle": "⟨", "\\rangle": "⟩", "\\lvert": "|", "\\rvert": "|", "\\lfloor": "⌊", "\\rfloor": "⌋",
          "\\lceil": "⌈", "\\rceil": "⌉"}
# Окружения: имя → (открывающая скобка, закрывающая; None — без скобок).
ENVS = {"matrix": None, "pmatrix": ("(", ")"), "bmatrix": ("[", "]"), "vmatrix": ("|", "|"), "Bmatrix": ("{", "}"),
        "cases": ("{", ""), "aligned": None}
PLAIN_OPS = {"+": ("+", True), "-": ("−", True), "=": ("=", True), "<": ("<", True), ">": (">", True), ",": (",", True),
             ";": (";", True), ":": (":", True), "!": ("!", False), "/": ("/", False), "*": ("∗", False),
             "|": ("|", False), ")": (")", False), "]": ("]", False), ".": (".", False), "?": ("?", False)}


THIN = "<mtext>\u2009</mtext>"  # тонкий пробел между названием функции и соседями


def _is_cyr(ch):
    return "\u0400" <= ch <= "\u04ff"


def _tok(tag, text, attrs=""):
    return f"<{tag}{attrs}>{escape(text)}</{tag}>"


def _mrow(parts):
    return "<mrow>" + "".join(parts) + "</mrow>"


class _Parser:
    """Разбор одной формулы. Каждый кусок — пара (MathML, вид): atom | open | break | nary | func."""

    def __init__(self, src, display):
        self.s, self.pos, self.display = src, 0, display

    def err(self, msg, pos=None):
        raise MathError(msg, self.pos if pos is None else pos)

    def ws(self):
        while self.pos < len(self.s) and self.s[self.pos] in " \t\r\n":
            self.pos += 1

    def peek_cmd(self):
        """Название команды в текущей позиции (без «\\»), не сдвигая позицию; не команда — None."""
        s, i = self.s, self.pos
        if i >= len(s) or s[i] != "\\":
            return None
        j = i + 1
        while j < len(s) and s[j].isascii() and s[j].isalpha():
            j += 1
        return s[i + 1:j] if j > i + 1 else s[i + 1:i + 2]

    def at_stop(self):
        """Конец последовательности: конец строки, «}», «&», «\\\\», \\right, \\end."""
        self.ws()
        if self.pos >= len(self.s) or self.s[self.pos] in "}&":
            return True
        return self.peek_cmd() in ("\\", "right", "end")

    # --- последовательность ---
    def seq(self):
        items = []
        while not self.at_stop():
            items.append(self.atom())
        return self.join(items)

    def join(self, items):
        """Склейка кусков: операнд суммы/интеграла собирается в mrow сразу за знаком (так его ищет MML2OMML),
        название функции отделяется тонким пробелом от множителя перед ним и от аргумента без скобок."""
        out, i = [], 0
        while i < len(items):
            xml, kind = items[i]
            if kind == "func" and i > 0 and items[i - 1][1] in ("atom", "nary") and items[i - 1][0]:
                out.append(THIN)
            out.append(xml)
            i += 1
            if kind == "nary":
                j = i
                while j < len(items) and items[j][1] != "break":
                    j += 1
                out.append(_mrow([self.join(items[i:j])]))
                i = j
            elif kind == "func" and i < len(items) and items[i][1] != "open":
                out.append(THIN)
        return "".join(out)

    # --- кусок с индексами ---
    def atom(self):
        start = self.pos
        base, kind, limits = self.base()
        sub = sup = None
        while True:
            self.ws()
            ch = self.s[self.pos] if self.pos < len(self.s) else ""
            if ch == "'":
                n = 0
                while self.pos < len(self.s) and self.s[self.pos] == "'":
                    n, self.pos = n + 1, self.pos + 1
                if sup is not None:
                    self.err("штрих после верхнего индекса: поставь штрих раньше «^»")
                sup = _tok("mo", "′" * n)
                self.ws()
                if self.pos < len(self.s) and self.s[self.pos] == "^":
                    self.pos += 1
                    sup = _mrow([sup, self.arg("верхний индекс «^»")])
            elif ch == "^":
                if sup is not None:
                    self.err("два верхних индекса подряд: объедини их в фигурных скобках")
                self.pos += 1
                sup = self.arg("верхний индекс «^»")
            elif ch == "_":
                if sub is not None:
                    self.err("два нижних индекса подряд: объедини их в фигурных скобках")
                self.pos += 1
                sub = self.arg("нижний индекс «_»")
            elif self.peek_cmd() in ("limits", "nolimits"):
                limits = self.peek_cmd() == "limits"
                self.pos += len(self.peek_cmd()) + 1
            else:
                break
        if sub is None and sup is None:
            return base, ("atom" if kind == "nary" else kind)
        if kind in ("break", "open") and base.startswith("<mo"):
            self.err("индекс не к чему отнести: перед «^» или «_» стоит знак операции", start)
        if limits:
            tag = "munderover" if sub and sup else ("munder" if sub else "mover")
        else:
            tag = "msubsup" if sub and sup else ("msub" if sub else "msup")
        return f"<{tag}>{base}{sub or ''}{sup or ''}</{tag}>", kind

    def arg(self, what):
        """Аргумент индекса или команды: группа в фигурных скобках либо один знак (цифра, буква, команда)."""
        self.ws()
        start = self.pos
        if self.pos >= len(self.s) or self.s[self.pos] in "}&^_'" or self.peek_cmd() in ("\\", "right", "end"):
            self.err(f"пустой {what}: после него ничего нет" if "индекс" in what else f"у команды {what} нет аргумента")
        ch = self.s[self.pos]
        if ch == "{":
            if self.s.startswith("{,}", self.pos):
                self.pos += 3
                return _tok("mo", ",")
            self.pos += 1
            inner = self.seq()
            self.expect_close(start)
            if not inner:
                self.err(f"пустой {what}: в скобках {{}} ничего нет" if "индекс" in what else f"у команды {what} пустой аргумент {{}}", start)
            return _mrow([inner])
        if ch.isdigit():
            self.pos += 1
            return _tok("mn", ch)
        return self.base()[0]

    def expect_close(self, start):
        if self.pos >= len(self.s) or self.s[self.pos] != "}":
            self.err("незакрытая скобка «{»: нет парной «}»" if self.pos >= len(self.s) else
                     f"незакрытая скобка «{{»: до парной «}}» встретилось «{self.s[self.pos:self.pos + 8]}»", start)
        self.pos += 1

    def raw_group(self, cmd):
        """Текст в {…} как есть (для \\text, \\mathrm, названий окружений)."""
        self.ws()
        if self.pos >= len(self.s) or self.s[self.pos] != "{":
            self.err(f"у команды \\{cmd} нет аргумента в фигурных скобках")
        start, depth, out = self.pos, 0, []
        while self.pos < len(self.s):
            ch = self.s[self.pos]
            self.pos += 1
            if ch == "\\" and self.pos < len(self.s) and self.s[self.pos] in "{}%_#&$ ":
                out.append(self.s[self.pos])
                self.pos += 1
                continue
            if ch == "{":
                depth += 1
                if depth == 1:
                    continue
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return "".join(out)
            out.append(ch)
        self.err(f"незакрытая скобка «{{» у команды \\{cmd}", start)

    # --- основание: число, буква, знак, группа, команда ---
    def base(self):
        """Возвращает (MathML, вид, пределы над и под знаком)."""
        self.ws()
        s, start = self.s, self.pos
        if start >= len(s):
            self.err("формула обрывается: ожидалось продолжение")
        ch = s[start]
        if ch.isdigit():
            return self.number(), "atom", False
        if ch == "{":
            if s.startswith("{,}", start):
                self.pos += 3
                return _tok("mo", ","), "atom", False
            self.pos += 1
            inner = self.seq()
            self.expect_close(start)
            return _mrow([inner]), "atom", False
        if ch == "\\":
            return self.command()
        if ch in "^_":
            self.err(f"индекс «{ch}» не к чему отнести: перед ним нет основания (для пустого основания напиши {{}}{ch}…)")
        self.pos += 1
        if ch.isascii() and ch.isalpha():
            return _tok("mi", ch), "atom", False
        if _is_cyr(ch):
            while self.pos < len(s) and _is_cyr(s[self.pos]):
                self.pos += 1
            return _tok("mi", s[start:self.pos], ' mathvariant="normal"'), "atom", False
        if ch in "([":
            return _tok("mo", ch), "open", False
        if ch in PLAIN_OPS:
            sym, brk = PLAIN_OPS[ch]
            return _tok("mo", sym), ("break" if brk else "atom"), False
        if ch == "~":
            return "<mtext>\u00a0</mtext>", "atom", False
        if ch == "$":
            self.err("знак «$» внутри формулы: границы формулы в формулу не входят", start)
        if ch == "%" or ch == "#":
            self.err(f"знак «{ch}» в формуле пишется как \\{ch}", start)
        return _tok("mo", ch), "atom", False

    def number(self):
        """Число: цифры, десятичная точка или запятая вида {,} (обычная запятая между цифрами — разделитель)."""
        s, i = self.s, self.pos
        while i < len(s) and s[i].isdigit():
            i += 1
        text = s[self.pos:i]
        for sep, shown in (("{,}", ","), (".", ".")):
            j = i + len(sep)
            if s.startswith(sep, i) and j < len(s) and s[j].isdigit():
                while j < len(s) and s[j].isdigit():
                    j += 1
                text, i = text + shown + s[i + len(sep):j], j
                break
        self.pos = i
        return _tok("mn", text)

    def delim(self, cmd):
        """Скобка после \\left или \\right."""
        self.ws()
        for key in sorted(DELIMS, key=len, reverse=True):
            if self.s.startswith(key, self.pos):
                nxt = self.s[self.pos + len(key):self.pos + len(key) + 1]
                if key[1:].isalpha() and nxt.isascii() and nxt.isalpha():
                    continue
                self.pos += len(key)
                return DELIMS[key]
        self.err(f"после \\{cmd} должна стоять скобка: ( ) [ ] | \\{{ \\}} или точка")

    def command(self):
        start = self.pos
        name = self.peek_cmd()
        if not name:
            self.err("одиночный знак «\\» в конце формулы")
        self.pos += len(name) + 1
        full = "\\" + name
        if name in GREEK:
            up = name[0].isupper()
            return _tok("mi", GREEK[name], ' mathvariant="normal"' if up else ""), "atom", False
        if name in OPS:
            sym, brk = OPS[name]
            return _tok("mo", sym), ("break" if brk else "atom"), False
        if name in SYMBOLS:
            return _tok("mi", SYMBOLS[name], ' mathvariant="normal"'), "atom", False
        if name in SPACES:
            sp = SPACES[name]
            return (f"<mtext>{sp}</mtext>" if sp else ""), ("break" if name in ("quad", "qquad") else "atom"), False
        if name in ESCAPED:
            return _tok("mo", ESCAPED[name]), ("open" if name == "{" else "atom"), False
        if name in ("frac", "dfrac", "tfrac"):
            num = self.arg(full)
            den = self.arg(full)
            return f"<mfrac>{num}{den}</mfrac>", "atom", False
        if name == "sqrt":
            self.ws()
            index = None
            if self.pos < len(self.s) and self.s[self.pos] == "[":
                p0 = self.pos
                self.pos += 1
                index = self.until_bracket(p0)
            body = self.arg(full)
            return (f"<mroot>{body}{index}</mroot>" if index else f"<msqrt>{body}</msqrt>"), "atom", False
        if name in NARY:
            sym, und = NARY[name]
            return _tok("mo", sym), "nary", und and self.display
        if name in FUNCS:
            return _tok("mi", name, ' mathvariant="normal"'), "func", name in LIMFUNCS
        if name in ACCENTS:
            body = self.arg(full)
            # Черта сверху — без accent (так MML2OMML делает растяжимую m:bar), остальные знаки — акцент m:acc.
            acc = "" if ACCENTS[name] == "¯" else ' accent="true"'
            return f"<mover{acc}>{body}<mo>{ACCENTS[name]}</mo></mover>", "atom", False
        if name == "underline":
            body = self.arg(full)
            return f"<munder>{body}<mo>\u0332</mo></munder>", "atom", False
        if name in ("text", "mathrm", "operatorname", "textrm", "mathit", "mathbf", "textbf", "textit"):
            raw = self.raw_group(name)
            if name in ("text", "textrm", "textbf", "textit"):
                return _tok("mtext", raw.replace(" ", "\u00a0")), "atom", False
            variant = {"mathit": "italic", "mathbf": "bold"}.get(name, "normal")
            if not raw.strip():
                self.err(f"у команды {full} пустой аргумент {{}}", start)
            kind = "func" if name == "operatorname" else "atom"
            return _tok("mi", raw.strip(), f' mathvariant="{variant}"'), kind, False
        if name == "left":
            op = self.delim("left")
            inner = self.seq()
            if self.peek_cmd() != "right":
                self.err("у \\left нет парной \\right", start)
            self.pos += len("\\right")
            cl = self.delim("right")
            return (f"<mfenced open={quoteattr(op)} close={quoteattr(cl)} separators=\"\">{_mrow([inner])}</mfenced>",
                    "open", False)
        if name == "right":
            self.err("\\right без парной \\left", start)
        if name == "begin":
            return self.environment(start), "atom", False
        if name == "end":
            self.err("\\end без парной \\begin", start)
        if name in ("displaystyle", "textstyle", "nonumber", "notag"):
            return "", "atom", False
        if name in ("langle", "rangle", "lvert", "rvert", "lfloor", "rfloor", "lceil", "rceil"):
            return _tok("mo", DELIMS[full]), ("open" if name[0] == "l" else "atom"), False
        if name == "\\":
            self.err("перенос строки «\\\\» допустим только внутри окружения (matrix, cases, aligned)", start)
        self.err(f"неизвестная команда {full}", start)

    def until_bracket(self, start):
        """Показатель корня: содержимое [ … ] после \\sqrt."""
        items = []
        while True:
            self.ws()
            if self.pos < len(self.s) and self.s[self.pos] == "]":
                self.pos += 1
                break
            if self.at_stop():
                self.err("незакрытая скобка «[» у команды \\sqrt", start)
            items.append(self.atom())
        if not items:
            self.err("у команды \\sqrt пустой показатель корня []", start)
        return _mrow([self.join(items)])

    def environment(self, start):
        name = self.raw_group("begin").strip()
        if name not in ENVS:
            self.err(f"неизвестное окружение \\begin{{{name}}}", start)
        rows, row = [], []
        while True:
            row.append(self.seq())
            if self.pos < len(self.s) and self.s[self.pos] == "&":
                self.pos += 1
                continue
            cmd = self.peek_cmd()
            if cmd == "\\":
                self.pos += 2
                rows.append(row)
                row = []
                continue
            if cmd == "end":
                p0 = self.pos
                self.pos += len("\\end")
                closing = self.raw_group("end").strip()
                if closing != name:
                    self.err(f"окружение \\begin{{{name}}} закрыто как \\end{{{closing}}}", p0)
                break
            if self.pos < len(self.s) and self.s[self.pos] == "}":
                self.err("лишняя скобка «}»")
            self.err(f"у окружения \\begin{{{name}}} нет парной \\end{{{name}}}", start)
        if any(row):
            rows.append(row)
        if not rows:
            self.err(f"пустое окружение \\begin{{{name}}}", start)
        if name == "aligned":
            # Столбик выражений: одна ячейка на строку, место выравнивания «&» — malignmark (в Word — массив уравнений).
            body = "".join("<mtr><mtd>" + "<malignmark/>".join(_mrow([c]) for c in r) + "</mtd></mtr>" for r in rows)
            table = f"<mtable>{body}</mtable>"
        elif name == "cases" and max(len(r) for r in rows) == 1:
            # Система без условий: таблицу в один столбец MML2OMML делает массивом уравнений и ставит строки по центру;
            # метка выравнивания в начале каждой строки прижимает их к левому краю.
            body = "".join(f"<mtr><mtd><malignmark/>{_mrow([r[0]])}</mtd></mtr>" for r in rows)
            table = f"<mtable>{body}</mtable>"
        else:
            width = max(len(r) for r in rows)
            if name != "cases" and any(len(r) != width for r in rows):
                self.err(f"в окружении {name} в строках разное число ячеек (разделитель «&»)", start)
            body = "".join("<mtr>" + "".join(f"<mtd>{_mrow([c])}</mtd>" for c in r + [""] * (width - len(r))) + "</mtr>"
                           for r in rows)
            table = f'<mtable columnalign="left">{body}</mtable>' if name == "cases" else f"<mtable>{body}</mtable>"
        fence = ENVS[name]
        if not fence:
            return table
        return f'<mfenced open={quoteattr(fence[0])} close={quoteattr(fence[1])} separators="">{table}</mfenced>'


def latex_to_mathml(latex, display=False):
    """LaTeX → строка MathML (<math>…</math>). display — формула на отдельной строке (пределы над и под знаком суммы)."""
    src = str(latex)
    if not src.strip():
        raise MathError("пустая формула", 0)
    p = _Parser(src, display)
    body = p.seq()
    if p.pos < len(src):
        ch, cmd = src[p.pos], p.peek_cmd()
        if ch == "}":
            p.err("лишняя скобка «}»: нет парной «{»")
        if ch == "&":
            p.err("знак «&» допустим только внутри окружения (matrix, cases, aligned)")
        if cmd == "\\":
            p.err("перенос строки «\\\\» допустим только внутри окружения (matrix, cases, aligned)")
        p.err("\\right без парной \\left" if cmd == "right" else "\\end без парной \\begin")
    block = ' display="block"' if display else ""
    return f'<math xmlns="{MML_NS}"{block}>{_mrow([body])}</math>'


_XSLT = None


def _xslt():
    """Преобразование MathML → OMML из поставки Office; создаётся один раз на запуск."""
    global _XSLT
    if _XSLT is None:
        found = []
        for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
            root = os.environ.get(var)
            if root:
                found += sorted(glob.glob(os.path.join(root, "Microsoft Office", "root", "Office*", "MML2OMML.XSL")))
                found += sorted(glob.glob(os.path.join(root, "Microsoft Office", "Office*", "MML2OMML.XSL")))
        if not found:
            raise MathError("нет Word: не найден файл MML2OMML.XSL из Microsoft Office, формулы собрать нечем")
        try:
            _XSLT = etree.XSLT(etree.parse(found[0]))
        except (etree.XMLSyntaxError, etree.XSLTParseError, OSError) as e:
            raise MathError(f"нет Word: файл {found[0]} не читается ({e})")
    return _XSLT


def latex_to_omml(latex, display):
    """LaTeX → элемент OMML: m:oMath (формула в строке) или m:oMathPara (на отдельной строке)."""
    mathml = latex_to_mathml(latex, display)
    try:
        root = _xslt()(etree.fromstring(mathml)).getroot()
    except (etree.XMLSyntaxError, etree.XSLTApplyError) as e:
        raise MathError(f"формула не переводится в формат Word ({e})")
    want = "oMathPara" if display else "oMath"
    if root is None or root.tag != f"{{{OMML_NS}}}{want}":
        raise MathError("формула не переводится в формат Word (пустой результат преобразования)")
    # Система (cases) выходит матрицей в фигурной скобке; MML2OMML ставит колонки по центру — прижимаем их влево.
    m = "{%s}" % OMML_NS
    for d in root.iter(m + "d"):
        beg, end = d.find(f"{m}dPr/{m}begChr"), d.find(f"{m}dPr/{m}endChr")
        if beg is not None and end is not None and beg.get(m + "val") == "{" and end.get(m + "val") == "":
            for jc in d.iterfind(f"{m}e/{m}m/{m}mPr/{m}mcs/{m}mc/{m}mcPr/{m}mcJc"):
                jc.set(m + "val", "left")
    etree.cleanup_namespaces(root)
    return root
