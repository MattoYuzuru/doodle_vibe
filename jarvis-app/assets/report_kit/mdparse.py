# Разбор report.md в промежуточное представление (список блоков) для writer.
# Свои конструкции диалекта (заголовки, рисунки, «Таблица:», оградные блоки, [TOC], [PAGEBREAK]) разбираются построчно
# своим кодом; всё остальное (абзацы, списки, выделение) — через mistune без плагинов. Файлы не читаются и пути не
# проверяются: это делает writer. Любая нераспознанная конструкция — KitError с номером строки, а не текст в отчёте.
import difflib
import re

from mistune import BlockParser, InlineParser, Markdown

from .common import KitError, clean_text

IMAGE_EXT = ("png", "jpg", "jpeg", "gif", "bmp")
KINDS = {"fig": ("figure", "рисунок"), "tbl": ("table", "таблицу"), "eq": ("formula", "формулу"), "lst": ("listing", "листинг")}

_LABEL = re.compile(r"^(fig|tbl|eq|lst):[A-Za-z0-9_-]+$")
_REF = re.compile(r"@(fig|tbl|eq|lst):[A-Za-z0-9_-]+")
_SUB = re.compile(r"\{\{([A-Za-z_][A-Za-z0-9_]*)(?:\|(\d))?\}\}")
_REF_OR_SUB = re.compile(_REF.pattern + "|" + _SUB.pattern)
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)$")
_HEADING = re.compile(r"^(#{1,6})(?:[ \t]+(.*))?$")
_LEAD_NUM = re.compile(r"^\d+(\.\d+)*\.?\s+")
_NO_NUM = re.compile(r"\s*\{-\}\s*$")
_TABLE_CAP = re.compile(r"^Таблица[ \t]*:(.*)$")
_TAIL = re.compile(r"\s*\{([^{}]*)\}\s*$")
_FIGURE = re.compile(r"^!\[(.*?)\]\((.*)$")
_FIGURE_END = re.compile(r"\)\s*(?:\{([^{}]*)\})?\s*$")
_DELIM = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
_PIPE = re.compile(r"(?<!\\)\|")
_LIST_START = re.compile(r"^ {0,3}([-*+]|\d{1,9}[.)])[ \t]")
_INFO = re.compile(r"""([^\s=“”"']+)=("[^"]*"|'[^']*'|\S+)|\{-\}|\S+""")
_RANGE = re.compile(r"^(\d+)(?:-(\d+))?$")
_WIDTH = re.compile(r"^(\d+(?:\.\d+)?)(?:cm|см)?$")

# Обратный слеш остаётся экранированием только перед этими знаками; перед остальными он обычный символ — иначе
# путь C:\Users\User\.ssh в тексте потерял бы слеши. «\.» действует только после цифры («1998\. Год» — не список).
_ESCAPABLE = "*_`[]<>|#!"
# Экранированные «$» и «{» прячутся в служебные символы, чтобы не стать формулой или подстановкой; в конце возвращаются.
_HIDE = {"$": "\ue000", "{": "\ue001"}
_SHOW = {v: k for k, v in _HIDE.items()}

# Остатки разметки, которым нельзя попасть в текст отчёта (вне кода): что нашли → как исправить.
_LEFTOVERS = [
    ("![", "рисунок пишется отдельной строкой целиком: ![Подпись](work/out/p1.png){#fig:имя}"),
    ("{#", "метка ставится только в хвосте строки рисунка или строки «Таблица: …»; у заголовков и абзацев меток нет"),
    ("$$", "формула на отдельной строке — блок ```math … ```; формула в строке — $`…`$"),
    ("[TOC]", "[TOC] пишется отдельной строкой"),
    ("[PAGEBREAK]", "[PAGEBREAK] пишется отдельной строкой"),
]

_md = None


def _mistune():
    """mistune без плагинов, без HTML, автоссылок и определений ссылок; создаётся один раз."""
    global _md
    if _md is None:
        block, inline = BlockParser(), InlineParser()
        for rules in (block.rules, getattr(block, "list_rules", []), getattr(block, "block_quote_rules", [])):
            for name in ("ref_link", "raw_html"):
                if name in rules:
                    rules.remove(name)
        for name in ("auto_link", "auto_email", "inline_html"):
            if name in inline.rules:
                inline.rules.remove(name)
        _md = Markdown(renderer=None, block=block, inline=inline)
    return _md


def _protect(text):
    """Текст перед mistune: «_» и «<» становятся буквальными, «*» между буквами или цифрами (2*3*4) — тоже;
    содержимое `кода` не трогается."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "`":
            j = i
            while j < n and text[j] == "`":
                j += 1
            close = re.compile(r"(?<!`)`{%d}(?!`)" % (j - i)).search(text, j)
            if close:
                out.append(text[i:close.end()])
                i = close.end()
            else:  # обратные кавычки без пары — обычные знаки
                out.append("\\`" * (j - i))
                i = j
        elif c == "\\":
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt in _HIDE:
                out.append(_HIDE[nxt])
                i += 2
            elif nxt and (nxt in _ESCAPABLE or (nxt == "." and i > 0 and text[i - 1].isdigit())):
                out.append("\\" + nxt)
                i += 2
            else:
                out.append("\\\\")
                i += 1
        elif c in "_<":
            out.append("\\" + c)
            i += 1
        elif c == "*" and 0 < i < n - 1 and text[i - 1].isalnum() and text[i + 1].isalnum():
            out.append("\\*")
            i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _split_cells(line):
    """Строка pipe-таблицы → тексты ячеек. «\\|» — черта внутри ячейки; черта внутри {{имя|2}} ячейки не делит."""
    s = _SUB.sub(lambda m: m.group(0).replace("|", "\ue002"), line.strip())
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.replace("\\|", "|").replace("\ue002", "|").strip() for c in _PIPE.split(s)]


def _info(info, line):
    """Info-строка оградного блока → (язык, {ключ: значение}, признак {-})."""
    lang, attrs, no_num = "", {}, False
    for k, m in enumerate(_INFO.finditer(info)):
        tok = m.group(0)
        if m.group(1):
            val = m.group(2)
            if val[0] in "\"'" and (len(val) < 2 or val[-1] != val[0]):
                raise KitError(f"в строке блока не закрыта кавычка: {tok}", line=line, hint='значение с пробелами пиши в двойных кавычках: caption="Текст подписи"')
            if m.group(1) in attrs:
                raise KitError(f"параметр «{m.group(1)}» в строке блока указан дважды", line=line)
            attrs[m.group(1)] = val[1:-1] if val[0] in "\"'" else val
        elif tok == "{-}":
            no_num = True
        elif k == 0:
            lang = tok
        else:
            raise KitError(f"непонятное слово «{tok}» в строке блока", line=line, hint='параметры пишутся как ключ=значение; значение с пробелами — в двойных кавычках: caption="Текст подписи"')
    return lang, attrs, no_num


def _range(val, name, line):
    """«10-40» или «10» → [10, 40]; нумерация с 1."""
    m = _RANGE.match(val)
    a, b = (int(m.group(1)), int(m.group(2) or m.group(1))) if m else (0, 0)
    if not m or a < 1 or b < a:
        raise KitError(f"параметр {name}=«{val}» не разобрать", line=line, hint=f"пиши диапазон строк так: {name}=10-40 (нумерация с 1)")
    return [a, b]


def _number(val, digits, decimal):
    """Значение подстановки → текст; десятичный знак по профилю."""
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None
    s = str(val) if digits is None else f"{val:.{digits}f}"
    return s.replace(".", ",") if decimal == "comma" else s


class _Parser:
    def __init__(self, text, style, values):
        self.lines = clean_text(text).lstrip("\ufeff").split("\n")
        self.style = style or {}
        self.values = values or {}
        self.decimal = self.style.get("decimal", "comma")
        self.blocks, self.warnings, self.labels, self.refs = [], [], {}, []

    # ---------- общее ----------
    def warn(self, line, msg):
        self.warnings.append(f"строка {line}: {msg}")

    def label(self, raw, kind, line):
        """Проверить и запомнить метку объекта; kind — fig | tbl | eq | lst."""
        word = KINDS[kind][1]
        if not _LABEL.match(raw) or not raw.startswith(kind + ":"):
            raise KitError(f"метка «{raw}» записана неверно", line=line, hint=f"метка на {word} — «{kind}:имя», имя из латинских букв, цифр, «_» и «-»")
        if raw in self.labels:
            raise KitError(f"метка «{raw}» повторяется (первый раз — строка {self.labels[raw]['line']})", line=line, hint="дай объектам разные метки")
        self.labels[raw] = {"type": KINDS[kind][0], "line": line, "index": len(self.blocks), "refs": 0}
        return raw

    def tail(self, inner, kind, line, keys):
        """Хвост {…} рисунка или строки «Таблица:» → {id, <ключ>: значение, row}."""
        out = {"id": None}
        for tok in inner.split():
            if tok.startswith("#"):
                if out["id"]:
                    raise KitError("в хвосте {…} две метки", line=line)
                out["id"] = self.label(tok[1:], kind, line)
            elif "=" in tok and tok.split("=", 1)[0] in keys:
                out[tok.split("=", 1)[0]] = tok.split("=", 1)[1]
            elif tok == "row" and "row" in keys:
                out["row"] = True
            else:
                allowed = ", ".join(["#" + kind + ":имя"] + [k if k == "row" else k + "=…" for k in keys])
                raise KitError(f"непонятное «{tok}» в хвосте {{…}}", line=line, hint=f"в хвосте допустимо: {allowed}; без пробелов вокруг «=» и после запятых")
        return out

    # ---------- строчные элементы ----------
    def runs(self, text, line, src=None):
        """Одна строка текста (подпись, ячейка, заголовок) → прогоны."""
        text = text.strip()
        if not text:
            return []
        return self.inline(_mistune().inline(_protect(text), {"ref_links": {}}), line, src)

    def inline(self, tokens, line, src=None):
        """Узлы mistune → прогоны {t, b, i, code} | {math} | {ref}. src — строки куска [(номер, текст)] для поиска места ошибки."""
        def where(needle):
            for no, s in src or []:
                if needle in s:
                    return no
            return line

        flat = []  # [вид, текст, b, i]

        def walk(toks, b, i):
            for t in toks:
                ty = t["type"]
                if ty == "text":
                    flat.append(["t", t["raw"], b, i])
                elif ty in ("softbreak", "linebreak"):
                    flat.append(["t", " ", b, i])
                elif ty == "codespan":
                    flat.append(["code", t["raw"], b, i])
                elif ty == "strong":
                    walk(t["children"], True, i)
                elif ty == "emphasis":
                    walk(t["children"], b, True)
                elif ty == "link":
                    start = len(flat)
                    walk(t["children"], b, i)
                    url = (t.get("attrs") or {}).get("url", "")
                    shown = "".join(f[1] for f in flat[start:])
                    if url and url != shown:
                        flat.append(["t", f" ({url})", b, i])
                elif ty == "image":
                    raise KitError("рисунок внутри текста не поддерживается", line=where("!["), hint=_LEFTOVERS[0][1])
                else:
                    raise KitError(f"неизвестная конструкция в тексте (узел «{ty}»)", line=line, hint="в тексте допустимы только **полужирный**, *курсив*, `код`, $`формула`$ и [текст](адрес)")

        walk(tokens, False, False)

        # Формула в строке: код, к которому с обеих сторон вплотную прижат «$».
        for k, f in enumerate(flat):
            if f[0] != "code" or k == 0 or k + 1 >= len(flat):
                continue
            prev, nxt = flat[k - 1], flat[k + 1]
            if prev[0] == "t" and nxt[0] == "t" and prev[1].endswith("$") and nxt[1].startswith("$"):
                if not f[1].strip():
                    raise KitError("пустая формула $``$", line=where("$`"))
                prev[1], nxt[1], f[0], f[1] = prev[1][:-1], nxt[1][1:], "math", f[1].strip()

        merged = []
        for f in flat:
            if f[0] == "t" and merged and merged[-1][0] == "t" and merged[-1][2:] == f[2:]:
                merged[-1][1] += f[1]
            elif f[1]:
                merged.append(list(f))

        out = []
        for kind, text, b, i in merged:
            if kind == "math":
                out.append({"math": text})
                continue
            if kind == "code":
                out.append({"t": text, "b": b, "i": i, "code": True})
                continue
            pos = 0
            parts = []
            for m in _REF_OR_SUB.finditer(text):
                parts.append(text[pos:m.start()])
                pos = m.end()
                if m.group(0).startswith("@"):
                    ref = m.group(0)[1:]
                    self.refs.append((ref, where(m.group(0))))
                    parts.append({"ref": ref})
                else:
                    parts.append(self.substitute(m.group(2), m.group(3), where("{{" + m.group(2))))
            parts.append(text[pos:])
            buf = ""
            for p in parts + [None]:
                if isinstance(p, str):
                    buf += p
                    continue
                if buf:
                    self.leftovers(buf, where)
                    out.append({"t": "".join(_SHOW.get(ch, ch) for ch in buf), "b": b, "i": i, "code": False})
                    buf = ""
                if p:
                    out.append(p)
        return out

    def leftovers(self, text, where):
        for mark, hint in _LEFTOVERS:
            if mark in text:
                raise KitError(f"в тексте осталась неразобранная разметка «{mark}»", line=where(mark), hint=hint)
        m = re.search(r"@(fig|tbl|eq|lst):\S*", text)
        if m:
            raise KitError(f"ссылка «{m.group(0)}» записана неверно", line=where(m.group(0)), hint="ссылка — @fig:имя, @tbl:имя, @eq:имя или @lst:имя; имя из латинских букв, цифр, «_» и «-»")

    def substitute(self, name, digits, line):
        if name not in self.values:
            near = difflib.get_close_matches(name, [str(k) for k in self.values], n=3, cutoff=0.5)
            hint = "такого имени нет в values.json" + (f"; похожие: {', '.join(near)}" if near else "; допиши его туда или впиши значение текстом")
            raise KitError(f"неизвестная подстановка {{{{{name}}}}}", line=line, hint=hint)
        val = self.values[name]
        if isinstance(val, (dict, list)) or val is None:
            raise KitError(f"значение «{name}» в values.json должно быть числом или строкой", line=line)
        if digits is None:
            return _number(val, None, self.decimal) or str(val)
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            try:
                val = float(str(val).replace(",", "."))
            except ValueError:
                raise KitError(f"подстановка {{{{{name}|{digits}}}}}: значение «{val}» не число, округлить нельзя", line=line, hint=f"убери «|{digits}» или запиши в values.json число")
        return _number(val, int(digits), self.decimal)

    # ---------- свои конструкции ----------
    def heading(self, m, line):
        level, text = len(m.group(1)), (m.group(2) or "").strip()
        if level > 3:
            raise KitError("заголовок глубже третьего уровня", line=line, hint="допустимы только «# », «## » и «### »")
        text = re.sub(r"\s+#+\s*$", "", text)
        numbered = True
        if _NO_NUM.search(text):
            text, numbered = _NO_NUM.sub("", text), False
        lead = _LEAD_NUM.match(text)
        if lead and text[lead.end():].strip():
            self.warn(line, f"в заголовке снят номер «{lead.group(0).strip()}»: разделы нумерует сборщик")
            text = text[lead.end():]
        runs = self.runs(text, line)
        if not runs:
            raise KitError("пустой заголовок", line=line)
        plain = "".join(r.get("t", "") for r in runs).strip().casefold()
        names = [str(n).casefold() for n in (self.style.get("headings") or {}).get("structural_names") or []]
        structural = level == 1 and plain in names
        self.blocks.append({"type": "heading", "line": line, "level": level, "text_runs": runs, "numbered": numbered and not structural, "structural": structural})

    def figure(self, s, line):
        hint = "рисунок — строка целиком: ![Подпись](work/out/p1.png){#fig:имя width=15cm}; после неё на той же строке ничего быть не должно"
        m = _FIGURE.match(s)
        end = _FIGURE_END.search(m.group(2)) if m else None
        if not end:
            raise KitError("строка рисунка не разобрана", line=line, hint=hint)
        images = [p.strip() for p in m.group(2)[:end.start()].split("|")]
        for p in images:
            if not p:
                raise KitError("у рисунка пустой путь к картинке", line=line, hint=hint)
            if re.match(r"^[a-z]+://", p, re.I):
                raise KitError(f"картинка по адресу из сети не вставляется: {p}", line=line, hint="сохрани картинку в папку лабы и укажи путь к файлу")
            if p.rsplit(".", 1)[-1].lower() not in IMAGE_EXT or "." not in p:
                raise KitError(f"формат картинки не поддерживается: {p}", line=line, hint="допустимы png, jpg, jpeg, gif, bmp — пересохрани картинку в png")
        tail = self.tail(end.group(1) or "", "fig", line, ("width", "row"))
        widths = None
        if "width" in tail:
            parts = [_WIDTH.match(w) for w in tail["width"].split(",")]
            if not all(parts) or len(parts) not in (1, len(images)) or any(float(p.group(1)) <= 0 for p in parts):
                raise KitError(f"ширина рисунка «width={tail['width']}» не разобрана", line=line, hint="ширина в сантиметрах: width=15cm; для нескольких картинок — одна на всех или по одной на каждую: width=7cm,7cm")
            widths = [float(p.group(1)) for p in parts] * (len(images) if len(parts) == 1 else 1)
        caption = self.runs(m.group(1), line)
        if not caption:
            raise KitError("у рисунка нет подписи", line=line, hint="подпись пишется в квадратных скобках: ![Схема стенда](work/out/p1.png)")
        self.blocks.append({"type": "figure", "line": line, "images": images, "caption_runs": caption, "id": tail["id"], "widths": widths, "row": bool(tail.get("row"))})

    def table_caption(self, m, i):
        """Строка «Таблица: …»: разобрать подпись и хвост, затем таблицу после неё. Возвращает индекс следующей строки."""
        line, text, tail = i + 1, m.group(1).strip(), {"id": None}
        t = _TAIL.search(text)
        if t and re.match(r"\s*(#|widths?\b)", t.group(1)):
            text = text[:t.start()]
            # метку записываем после разбора самой таблицы — индекс блока тогда верный
            tail = t.group(1)
        j = i + 1
        while j < len(self.lines) and not self.lines[j].strip():
            j += 1
        nxt = self.lines[j] if j < len(self.lines) else ""
        fence = _FENCE.match(nxt.lstrip(" ")) if len(nxt) - len(nxt.lstrip(" ")) <= 3 else None
        is_pipe = "|" in nxt and j + 1 < len(self.lines) and "|" in self.lines[j + 1] and _DELIM.match(self.lines[j + 1])
        if not is_pipe and not (fence and fence.group(2).split()[:1] == ["table"]):
            raise KitError("после строки «Таблица: …» нет таблицы", line=line, hint="сразу после подписи нужна pipe-таблица (| a | b | и строка |---|---|) или блок ```table file=work/out/t.csv")
        if isinstance(tail, str):
            tail = self.tail(tail, "tbl", line, ("widths",))
        if not text:
            raise KitError("у таблицы пустая подпись", line=line, hint="пиши: Таблица: Результаты измерений {#tbl:имя}")
        widths = None
        if "widths" in tail:
            try:
                widths = [float(w) for w in tail["widths"].split(",")]
                if any(w <= 0 for w in widths):
                    raise ValueError
            except ValueError:
                raise KitError(f"доли ширины «widths={tail['widths']}» не разобраны", line=line, hint="пиши доли через запятую без пробелов: widths=3,2,2")
        cap = {"caption_runs": self.runs(text, line), "id": tail["id"], "widths": widths, "cap_line": line}
        return self.pipe_table(j, cap) if is_pipe else self.fenced(j, fence, len(nxt) - len(nxt.lstrip(" ")), cap)

    def pipe_table(self, i, cap=None):
        """Pipe-таблица со строки i (шапка), i+1 — черта выравнивания. Возвращает индекс следующей строки."""
        line = i + 1
        head = _split_cells(self.lines[i])
        delim = _split_cells(self.lines[i + 1])
        if len(delim) != len(head):
            raise KitError(f"в строке-разделителе таблицы {len(delim)} столбцов, а в шапке {len(head)}", line=i + 2, hint="число ячеек в каждой строке таблицы должно совпадать с шапкой")
        align = ["c" if d.startswith(":") and d.endswith(":") else "r" if d.endswith(":") else "l" for d in delim]
        rows, j = [], i + 2
        while j < len(self.lines) and self.lines[j].strip() and _PIPE.search(self.lines[j]):
            cells = _split_cells(self.lines[j])
            if len(cells) != len(head):
                raise KitError(f"в строке таблицы {len(cells)} ячеек, а в шапке {len(head)}", line=j + 1, hint="число ячеек в каждой строке должно совпадать с шапкой; черта внутри ячейки пишется как \\|")
            rows.append([self.runs(c, j + 1) for c in cells])
            j += 1
        cap = cap or self.no_caption(line)
        self.check_widths(cap["widths"], len(head), cap["cap_line"])
        self.blocks.append({"type": "table", "line": line, "caption_runs": cap["caption_runs"], "id": cap["id"], "widths": cap["widths"],
                            "header": [self.runs(c, line) for c in head], "rows": rows, "align": align})
        return j

    def no_caption(self, line):
        self.warn(line, "таблица без подписи и номера: перед ней нет строки «Таблица: Подпись»")
        return {"caption_runs": None, "id": None, "widths": None, "cap_line": line}

    def check_widths(self, widths, ncols, line):
        if widths and ncols and len(widths) != ncols:
            raise KitError(f"в widths {len(widths)} долей, а столбцов в таблице {ncols}", line=line, hint="в widths должно быть по одной доле на столбец")

    def fenced(self, i, m, indent, cap=None):
        """Оградный блок со строки i: листинг, table или math. Возвращает индекс следующей строки."""
        line, mark = i + 1, m.group(1)
        if m.group(2).rstrip().endswith(mark):  # «```код```» одной строкой
            raise KitError("строка с тремя обратными кавычками не разобрана", line=line, hint="блок кода открывается отдельной строкой ```язык и закрывается отдельной строкой ```")
        lang, attrs, no_num = _info(m.group(2), line)
        body, j = [], i + 1
        closing = re.compile(r"^ {0,3}%s{%d,}\s*$" % (re.escape(mark[0]), len(mark)))
        while j < len(self.lines) and not closing.match(self.lines[j]):
            s = self.lines[j]
            cut = min(indent, len(s) - len(s.lstrip(" ")))
            body.append(s[cut:])
            j += 1
        if j >= len(self.lines):
            raise KitError("блок не закрыт", line=line, hint=f"добавь после блока отдельную строку {mark}")
        if lang == "table":
            self.file_table(attrs, body, no_num, line, cap)
        elif cap:
            raise KitError("после строки «Таблица: …» нет таблицы", line=cap["cap_line"])
        elif lang == "math":
            self.formula(attrs, body, no_num, line)
        else:
            self.listing(lang, attrs, body, no_num, line)
        return j + 1

    def only(self, attrs, allowed, what, line):
        for k in attrs:
            if k not in allowed:
                raise KitError(f"у блока {what} нет параметра «{k}»", line=line, hint="допустимые параметры: " + ", ".join(allowed))

    def formula(self, attrs, body, no_num, line):
        self.only(attrs, ("id",), "math", line)
        latex = "\n".join(body).strip()
        if not latex:
            raise KitError("пустой блок формулы", line=line)
        if no_num and "id" in attrs:
            raise KitError("у формулы без номера ({-}) не может быть метки", line=line, hint="убери либо {-}, либо id=…")
        numbered = bool((self.style.get("formula") or {}).get("numbered", True)) and not no_num
        fid = self.label(attrs["id"], "eq", line) if "id" in attrs else None
        self.blocks.append({"type": "formula", "line": line, "latex": latex, "id": fid, "numbered": numbered})

    def listing(self, lang, attrs, body, no_num, line):
        self.only(attrs, ("caption", "id", "file", "from", "to", "lines"), "кода", line)
        if no_num:
            raise KitError("{-} допустимо только у блока math и у заголовка", line=line, hint="листинг без номера — это блок кода без caption")
        caption = attrs.get("caption", "").strip() or None
        if "id" in attrs and not caption:
            raise KitError("у листинга с меткой нет подписи", line=line, hint='добавь caption="Подпись": номер получает только листинг с подписью')
        block = {"type": "listing", "line": line, "caption": caption, "id": None, "lang": lang, "lines": [ln.replace("\t", "    ") for ln in body]}
        if "file" in attrs:
            if any(ln.strip() for ln in body):
                raise KitError("у листинга задан и file=, и текст внутри блока", line=line, hint="оставь что-то одно: либо file=путь, либо текст кода")
            if "lines" in attrs and ("from" in attrs or "to" in attrs):
                raise KitError("у листинга заданы и lines=, и from=/to=", line=line, hint="оставь что-то одно")
            if not attrs["file"].strip():
                raise KitError("пустой путь file=", line=line)
            block.update({"file": attrs["file"], "from": attrs.get("from"), "to": attrs.get("to"),
                          "lines": _range(attrs["lines"], "lines", line) if "lines" in attrs else None, "attrs": attrs})
        elif "from" in attrs or "to" in attrs or "lines" in attrs:
            raise KitError("from=, to= и lines= работают только вместе с file=", line=line)
        if "id" in attrs:
            block["id"] = self.label(attrs["id"], "lst", line)
        self.blocks.append(block)

    def file_table(self, attrs, body, no_num, line, cap):
        self.only(attrs, ("file", "cols", "rows", "header"), "table", line)
        hint = 'пиши так: ```table file=work/out/t.csv cols=1,3,4 rows=1-20 header="Набор;f;fmin"'
        if no_num:
            raise KitError("{-} допустимо только у блока math и у заголовка", line=line)
        if not attrs.get("file", "").strip():
            raise KitError("у блока table нет file=", line=line, hint=hint)
        if any(ln.strip() for ln in body):
            raise KitError("внутри блока table не должно быть текста", line=line, hint="данные берутся из файла file=; таблицу прямо в тексте пиши pipe-таблицей")
        cols = None
        if "cols" in attrs:
            if not re.match(r"^[1-9]\d*(,[1-9]\d*)*$", attrs["cols"]):
                raise KitError(f"параметр cols=«{attrs['cols']}» не разобрать", line=line, hint="номера столбцов с 1 через запятую без пробелов: cols=1,3,4")
            cols = [int(c) for c in attrs["cols"].split(",")]
        header = None
        if "header" in attrs:
            raw = attrs["header"]
            if ";" not in raw and "\t" not in raw and "," in raw and (cols is None or len(cols) != 1):
                raise KitError("в header названия столбцов разделены запятой", line=line, hint='названия столбцов разделяй точкой с запятой: header="Набор;f;fmin"')
            names = re.split(r"[;\t]", raw)
            if cols and len(names) != len(cols):
                raise KitError(f"в header {len(names)} названий, а в cols {len(cols)} столбцов", line=line, hint="число названий в header должно совпадать с числом столбцов")
            header = [self.runs(n, line) for n in names]
        cap = cap or self.no_caption(line)
        self.check_widths(cap["widths"], len(cols or header or []), cap["cap_line"])
        self.blocks.append({"type": "table", "line": line, "caption_runs": cap["caption_runs"], "id": cap["id"], "widths": cap["widths"],
                            "header": header, "rows": _range(attrs["rows"], "rows", line) if "rows" in attrs else None, "align": [],
                            "file": attrs["file"], "cols": cols, "attrs": attrs})

    # ---------- обычный текст через mistune ----------
    def flush(self, pending):
        """Накопленные строки обычного текста [(номер, текст)] → абзацы и списки."""
        seg, segs = [], []
        for item in pending + [(0, "")]:
            if item[1].strip():
                seg.append(item)
            elif seg:
                # список с пустыми строками между пунктами — один кусок: продолжение начинается с маркера или отступа
                first = seg[0][1]
                if segs and any(_LIST_START.match(s) for _, s in segs[-1]) and (_LIST_START.match(first) or first.startswith("  ")):
                    segs[-1] += [(seg[0][0] - 1, "")] + seg
                else:
                    segs.append(seg)
                seg = []
        del pending[:]
        for seg in segs:
            self.segment(seg)

    def segment(self, seg):
        start = seg[0][0]
        tokens = _mistune()(_protect("\n".join(s for _, s in seg)))
        cursor = start
        for k, tok in enumerate(t for t in tokens if t["type"] != "blank_line"):
            if k:  # место второго и следующих блоков куска ищем по их первым словам
                needle = self.first_text(tok)[:12]
                cursor = next((no for no, s in seg if no > cursor and needle and needle in s), cursor)
            ty = tok["type"]
            if ty == "paragraph":
                runs = self.inline(tok["children"], cursor, seg)
                if runs:
                    self.blocks.append({"type": "para", "line": cursor, "runs": runs})
            elif ty == "list":
                items = []
                self.list_items(tok, 0, items, cursor, seg)
                self.blocks.append({"type": "list", "line": cursor, "ordered": bool(tok["attrs"].get("ordered")), "items": items})
            else:
                self.unknown(ty, tok, cursor, seg)

    def first_text(self, tok):
        if tok.get("type") in ("text", "codespan"):
            return tok.get("raw", "")
        for ch in tok.get("children") or []:
            s = self.first_text(ch)
            if s:
                return s
        return ""

    def unknown(self, ty, tok, line, seg):
        if ty == "heading":
            raise KitError("заголовок записан не по правилам", line=line, hint="заголовок — отдельная строка с начала строки: «# Название», «## Название» или «### Название»; подчёркивание === и --- не используется")
        if ty == "thematic_break":
            at = next((no for no, s in seg if re.match(r"^\s*([-*_]\s*){3,}$", s)), line)
            raise KitError("горизонтальная черта не поддерживается", line=at, hint="разрыв страницы — отдельная строка [PAGEBREAK]")
        if ty == "block_quote":
            at = next((no for no, s in seg if s.lstrip().startswith(">")), line)
            raise KitError("цитата («>» в начале строки) не поддерживается", line=at, hint="убери «>» или напиши «\\>», если нужен сам знак")
        if ty == "block_code":
            at = next((no for no, s in seg if no >= line and s.startswith("    ")), line)
            raise KitError("блок кода внутри списка или текст с отступом в 4 пробела не поддерживается", line=at, hint="блок кода ставь отдельно, без отступа: ```язык … ```; обычный текст пиши с начала строки")
        raise KitError(f"неизвестная конструкция (узел «{ty}»)", line=line, hint="в report.md допустимы только конструкции из образца report-sample.md")

    def list_items(self, tok, level, items, line, seg):
        ordered = bool(tok["attrs"].get("ordered"))
        number = int(tok["attrs"].get("start") or 1)
        if ordered and number > 99:
            self.warn(line, f"строка, начинающаяся с «{number}.», понята как пункт нумерованного списка; если это не список, напиши «{number}\\.»")
        for item in tok["children"]:
            runs, nested = [], []
            for ch in item.get("children") or []:
                if ch["type"] in ("paragraph", "block_text"):
                    more = self.inline(ch["children"], line, seg)
                    if runs and more:  # второй абзац пункта приклеивается к первому через пробел
                        runs.append({"t": " ", "b": False, "i": False, "code": False})
                    runs += more
                elif ch["type"] == "list":
                    nested.append(ch)
                elif ch["type"] != "blank_line":
                    self.unknown(ch["type"], ch, line, seg)
            items.append({"runs": runs, "level": level, "number": number if ordered else None, "ordered": ordered})
            number += 1
            for sub in nested:
                self.list_items(sub, level + 1, items, line, seg)

    # ---------- построчный проход ----------
    def run(self):
        pending, i, n = [], 0, len(self.lines)
        while i < n:
            raw = self.lines[i]
            indent = len(raw) - len(raw.lstrip(" "))
            s = raw.strip() if indent <= 3 else ""  # строка с отступом в 4+ пробела — продолжение списка, не своя конструкция
            line = i + 1
            fence = _FENCE.match(s)
            head = _HEADING.match(s)
            cap = _TABLE_CAP.match(s)
            if fence:
                self.flush(pending)
                i = self.fenced(i, fence, indent)
            elif head:
                self.flush(pending)
                self.heading(head, line)
                i += 1
            elif s.startswith("!["):
                self.flush(pending)
                self.figure(s, line)
                i += 1
            elif cap:
                self.flush(pending)
                i = self.table_caption(cap, i)
            elif s in ("[TOC]", "[PAGEBREAK]"):
                self.flush(pending)
                self.blocks.append({"type": "toc" if s == "[TOC]" else "pagebreak", "line": line})
                i += 1
            elif s and _PIPE.search(s) and i + 1 < n and "|" in self.lines[i + 1] and _DELIM.match(self.lines[i + 1]):
                self.flush(pending)
                i = self.pipe_table(i)
            elif s.startswith("|") or (s and "|" in s and _DELIM.match(s)):
                raise KitError("строка с «|» не стала таблицей", line=line, hint="pipe-таблица: строка шапки | a | b |, сразу под ней строка |---|---|, затем строки данных; черта внутри текста — \\|")
            else:
                pending.append((line, raw))
                i += 1
        self.flush(pending)

        for ref, line in self.refs:
            if ref not in self.labels:
                near = difflib.get_close_matches(ref, list(self.labels), n=3, cutoff=0.5)
                hint = f"объекта с меткой «{ref}» в report.md нет" + (f"; похожие метки: {', '.join(near)}" if near else "; поставь метку у объекта, например {#" + ref + "}")
                raise KitError(f"ссылка на неизвестную метку @{ref}", line=line, hint=hint)
            self.labels[ref]["refs"] += 1
        for name, info in self.labels.items():
            if not info["refs"]:
                self.warn(info["line"], f"на {KINDS[name.split(':')[0]][1]} с меткой «{name}» нет ссылки в тексте (@{name})")
        return {"blocks": self.blocks, "warnings": self.warnings, "labels": self.labels}


def parse(text, style, values=None):
    """report.md → {"blocks": [...], "warnings": [...], "labels": {метка: {type, line, index, refs}}}.

    Блоки — как в задании («Промежуточное представление»). Номера объектам не присваиваются (это делает writer),
    пути не проверяются и файлы не читаются. Ошибка во входе — KitError с номером строки и подсказкой."""
    return _Parser(text, style, values).run()
