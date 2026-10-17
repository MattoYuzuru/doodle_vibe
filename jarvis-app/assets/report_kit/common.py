# Общее для всех частей report_kit: ошибки с кодами выхода, чистка текста, пути внутри папки лабы, слияние профиля
# оформления. Договор между частями (mdparse, writer, title, mathconv, topdf, gate) — здесь; менять согласованно.
import json
import os
import re
import difflib

KIT_VERSION = "1"

# Коды выхода команд: 0 — успех; 2 — ошибка во входных данных; 3 — check нашёл отклонения must;
# 4 — сбой Word/конвертации; 5 — собранный файл не прошёл самопроверку (ошибка самой программы).
EXIT_OK, EXIT_INPUT, EXIT_MUST, EXIT_WORD, EXIT_SELF = 0, 2, 3, 4, 5

# Стили, которыми сборщик оформляет тело отчёта (фиксированные id; по ним же проверка узнаёт основной текст и листинги).
STYLE_BODY = "RKBody"
STYLE_LIST = "RKList"
STYLE_CAPTION_FIG = "RKCaptionFig"
STYLE_CAPTION_TAB = "RKCaptionTab"
STYLE_CAPTION_LST = "RKCaptionLst"
STYLE_LISTING = "RKListing"
STYLE_TABLE_TEXT = "RKTableText"
STYLE_FORMULA = "RKFormula"
EQ_TABLE_MARK = "rk-eq"  # tblCaption таблицы-обёртки формулы: проверка не считает её таблицей отчёта

HERE = os.path.dirname(os.path.abspath(__file__))
STYLES_DIR = os.path.normpath(os.path.join(HERE, "..", "styles"))


class KitError(Exception):
    """Ошибка с кодом выхода. line — номер строки report.md (с 1), hint — что исправить."""

    def __init__(self, message, line=None, hint=None, code=EXIT_INPUT):
        super().__init__(message)
        self.message, self.line, self.hint, self.code = message, line, hint, code

    def __str__(self):
        where = f"строка {self.line}: " if self.line else ""
        return f"{where}{self.message}" + (f"\n  Как исправить: {self.hint}" if self.hint else "")


class MathError(KitError):
    """Формула не разобралась: message — причина (название команды), pos — позиция в строке LaTeX."""

    def __init__(self, message, pos=None, line=None):
        super().__init__(message, line=line, hint="упрости формулу (см. список поддерживаемых команд в образце) или вставь её рисунком")
        self.pos = pos


_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean_text(s):
    """Текст для вставки в документ: без цветовых кодов терминала и управляющих символов (кроме \\n и \\t)."""
    return _CTRL.sub("", _ANSI.sub("", str(s))).replace("\r\n", "\n").replace("\r", "\n")


def lab_root(md_path):
    """Корень лабы: папка на два уровня выше report.md, если он лежит в work/report; иначе папка самого файла."""
    d = os.path.dirname(os.path.abspath(md_path))
    if os.path.basename(d).lower() == "report" and os.path.basename(os.path.dirname(d)).lower() == "work":
        return os.path.dirname(os.path.dirname(d))
    return d


def resolve_path(base, p, line=None, must_exist=True):
    """Путь из report.md или аргумента: от корня лабы, любые слеши; наружу нельзя; нет файла — подсказка с похожими."""
    from urllib.parse import unquote
    raw = unquote(str(p).strip().strip('"').strip("'")).replace("\\", "/")
    if not raw:
        raise KitError("пустой путь к файлу", line=line)
    base_abs = os.path.abspath(base)
    full = os.path.abspath(raw if os.path.isabs(raw) else os.path.join(base_abs, raw))
    try:
        inside = os.path.commonpath([os.path.normcase(full), os.path.normcase(base_abs)]) == os.path.normcase(base_abs)
    except ValueError:
        inside = False
    if not inside:
        raise KitError(f"путь «{p}» ведёт за пределы папки лабы", line=line, hint="все файлы отчёта должны лежать в папке лабы; пиши путь от неё, например work/out/p1.png")
    if must_exist and not os.path.isfile(full):
        near = []
        d = os.path.dirname(full)
        if os.path.isdir(d):
            near = difflib.get_close_matches(os.path.basename(full), os.listdir(d), n=3, cutoff=0.4)
        hint = "проверь путь от папки лабы" + (f"; похожие файлы рядом: {', '.join(near)}" if near else "")
        raise KitError(f"файл не найден: {raw}", line=line, hint=hint)
    return full


def _merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def load_style(path=None):
    """Профиль оформления: переданный style.json поверх gost.json (отсутствующие ключи берутся из ГОСТ)."""
    with open(os.path.join(STYLES_DIR, "gost.json"), encoding="utf-8") as f:
        base = json.load(f)
    if not path:
        return base
    try:
        with open(path, encoding="utf-8-sig") as f:
            over = json.load(f)
    except FileNotFoundError:
        raise KitError(f"файл оформления не найден: {path}")
    except json.JSONDecodeError as e:
        raise KitError(f"файл оформления не разобрать: {path} ({e.msg}, строка {e.lineno})")
    if not isinstance(over, dict):
        raise KitError(f"файл оформления должен быть объектом JSON: {path}")
    return _merge(base, over)


def from_default(style, key):
    """Значение профиля взято по умолчанию (в _from нет ключа)? key — путь вида «body.size_pt»."""
    src = (style.get("_from") or {})
    return not any(key == k or key.startswith(k + ".") or k.startswith(key + ".") for k in src)
