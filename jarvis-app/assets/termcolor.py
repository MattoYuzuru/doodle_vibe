# Цвет текста в рисунках терминала: как в настоящем окне, а не «всё белым».
#  1. ANSI-последовательности из файла вывода (ESC[32m …) разбираются и рисуются теми цветами, что дал сам инструмент
#     (k6, pytest, docker compose, git при включённом цвете). Сами символы ESC[…m в рисунок не попадают.
#  2. Первая строка с командой подсвечивается как PSReadLine в Windows PowerShell 5.1 (ps_highlight): команда жёлтая,
#     параметры -x серые, строки "…" голубые, числа и $переменные зелёные, операторы серые.
#  3. Если в файле нет ANSI, привычные маркеры красятся так, как их красит сам терминал/инструмент: ✓ зелёный, ✗ красный,
#     блок ошибки PowerShell (от «имя : …» до FullyQualifiedErrorId) красный, PASSED/passed зелёные, FAILED/failed красные,
#     итоговая строка pytest «=== N passed ===» зелёная, «=== … failed ===» красная.
# Текст не меняется: красятся те же символы, ничего не добавляется и не убирается.
import re
import textwrap

CAMPBELL = [(0x0C, 0x0C, 0x0C), (0xC5, 0x0F, 0x1F), (0x13, 0xA1, 0x0E), (0xC1, 0x9C, 0x00), (0x00, 0x37, 0xDA), (0x88, 0x17, 0x98), (0x3A, 0x96, 0xDD), (0xCC, 0xCC, 0xCC),
            (0x76, 0x76, 0x76), (0xE7, 0x48, 0x56), (0x16, 0xC6, 0x0C), (0xF9, 0xF1, 0xA5), (0x3B, 0x78, 0xFF), (0xB4, 0x00, 0x9E), (0x61, 0xD6, 0xD6), (0xF2, 0xF2, 0xF2)]
MAC_BASIC = [(0, 0, 0), (0xC9, 0x1B, 0x00), (0x00, 0xC2, 0x00), (0xC7, 0xC4, 0x00), (0x02, 0x25, 0xC7), (0xC9, 0x30, 0xC7), (0x00, 0xC5, 0xC7), (0xC7, 0xC7, 0xC7),
             (0x68, 0x68, 0x68), (0xFF, 0x6E, 0x67), (0x5F, 0xFA, 0x68), (0xFF, 0xFC, 0x67), (0x68, 0x71, 0xFF), (0xFF, 0x77, 0xFF), (0x60, 0xFD, 0xFF), (0xFF, 0xFF, 0xFF)]
SGR = re.compile("\x1b\\[([0-9;]*)m")
ANSI_ANY = re.compile("\x1b\\[[0-9;?]*[A-Za-z]|\x1b\\][^\x07]*\x07")


def _xterm256(n, pal):
    if n < 16:
        return pal[n]
    if n < 232:
        n -= 16
        return tuple(0 if v == 0 else 55 + 40 * v for v in (n // 36, (n // 6) % 6, n % 6))
    v = 8 + 10 * (n - 232)
    return (v, v, v)


def parse_ansi(text, pal, state):
    """Строка с ANSI → [(символ, цвет|None)]; state переносится на следующую строку: [цвет|None, bold]."""
    out = []
    pos = 0
    for m in SGR.finditer(text):
        for ch in ANSI_ANY.sub("", text[pos:m.start()]):
            out.append((ch, state[0]))
        pos = m.end()
        p = [int(x) if x else 0 for x in (m.group(1) or "0").split(";")]
        i = 0
        while i < len(p):
            c = p[i]
            if c == 0:
                state[0], state[1] = None, False
            elif c == 1:
                state[1] = True
            elif c == 22:
                state[1] = False
            elif 30 <= c <= 37:
                state[0] = pal[c - 30 + (8 if state[1] else 0)]
            elif 90 <= c <= 97:
                state[0] = pal[c - 90 + 8]
            elif c == 39:
                state[0] = None
            elif c in (38, 48) and i + 1 < len(p):
                if p[i + 1] == 5 and i + 2 < len(p):
                    if c == 38:
                        state[0] = _xterm256(p[i + 2], pal)
                    i += 2
                elif p[i + 1] == 2 and i + 4 < len(p):
                    if c == 38:
                        state[0] = (p[i + 2], p[i + 3], p[i + 4])
                    i += 4
            i += 1
    for ch in ANSI_ANY.sub("", text[pos:]):
        out.append((ch, state[0]))
    return out


_TOK = re.compile(r"""("(?:[^"`]|`.)*"|'[^']*')|(\$[\w:{}.]+)|(\|\||&&|\||;|2>&1|\*>&1|[<>]+)|(\s+)|(\S+)""")


def highlight_ps(cmd, pal):
    """Подсветка командной строки как в PSReadLine (Windows PowerShell 5.1): цвет каждого символа строки cmd."""
    COMMAND, PARAM, STRING, NUMBER = pal[11], pal[8], pal[6], pal[10]
    cols = [None] * len(cmd)
    new_cmd = True
    for m in _TOK.finditer(cmd):
        s, e = m.span()
        if m.group(1):
            c = STRING
        elif m.group(2):
            c = NUMBER
        elif m.group(3):
            c = PARAM
            new_cmd = m.group(3) in ("|", ";", "||", "&&")
        elif m.group(4):
            continue
        else:
            w = m.group(5)
            if new_cmd:
                c, new_cmd = COMMAND, False
            elif w.startswith("-") and len(w) > 1 and not w[1].isdigit():
                c = PARAM
            elif re.fullmatch(r"\d+(\.\d+)?", w):
                c = NUMBER
            else:
                c = None
        for k in range(s, e):
            cols[k] = c
    return cols


def semantic(lines, pal):
    """Краски по привычным маркерам — только для строк без ANSI. Для каждой строки — список цветов по символам."""
    RED, GREEN = pal[9], pal[10]
    res = [[None] * len(l) for l in lines]
    for i, l in enumerate(lines):
        s = l.lstrip()
        off = len(l) - len(s)
        if s[:1] and s[0] in "✓✔√":
            res[i][off] = GREEN
        elif s[:1] and s[0] in "✗✘×":
            res[i][off] = RED
        for m in re.finditer(r"\b(PASSED|passed)\b", l):
            for k in range(*m.span()):
                res[i][k] = GREEN
        for m in re.finditer(r"\b(FAILED|failed|ERROR)\b", l):
            for k in range(*m.span()):
                res[i][k] = RED
        if re.match(r"^=+ .*\b(passed|failed|error)", l):
            col = RED if re.search(r"\b(failed|error)", l) else GREEN
            res[i] = [col if ch != " " else None for ch in l]
    # блок ошибки PowerShell: от «имя : текст» до строки с FullyQualifiedErrorId
    for i, l in enumerate(lines):
        if "FullyQualifiedErrorId" in l:
            j = i
            while j > 0 and not re.match(r"^\S.* : ", lines[j]) and i - j < 12:
                j -= 1
            if re.match(r"^\S.* : ", lines[j]):
                for r in range(j, i + 1):
                    res[r] = [RED if ch != " " else None for ch in lines[r]]
    return res


def layout(raw_lines, cols, pal, default, ps_highlight=False):
    """raw_lines → строки рисунка: [[(текст, цвет), …], …] с переносом по cols символов (как в терминале)."""
    colored, plain_lines = [], []
    state = [None, False]
    any_ansi = any("\x1b[" in l for l in raw_lines)
    for l in raw_lines:
        cs = parse_ansi(l.rstrip("\r").expandtabs(8), pal, state)
        colored.append(cs)
        plain_lines.append("".join(ch for ch, _ in cs))
    sem = [[None] * len(p) for p in plain_lines] if any_ansi else semantic(plain_lines, pal)
    rows = []
    for i, cs in enumerate(colored):
        chars = [(ch, c if c is not None else sem[i][k]) for k, (ch, c) in enumerate(cs)]
        if i == 0 and ps_highlight and not any_ansi:
            m = re.match(r"^(PS [^>]*> )(.*)$", plain_lines[0])
            if m:
                hl = highlight_ps(m.group(2), pal)
                n = len(m.group(1))
                chars = [(ch, (hl[k - n] if k >= n else None)) for k, (ch, _) in enumerate(chars)]
        plain = "".join(ch for ch, _ in chars)
        k = 0
        for piece in (textwrap.wrap(plain, cols, drop_whitespace=False, replace_whitespace=False) or [""]):
            runs = []
            for ch, c in chars[k:k + len(piece)]:
                c = c if c is not None else default
                if runs and runs[-1][1] == c:
                    runs[-1][0] += ch
                else:
                    runs.append([ch, c])
            k += len(piece)
            rows.append([(t, c) for t, c in runs])
    return rows
