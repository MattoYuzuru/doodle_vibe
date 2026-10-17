# Проверка готового отчёта (команда check): сверяет DOCX и PDF с профилем оформления и ищет «мусор» — служебные пути,
# необновлённое оглавление, незаполненный титул, сырую разметку. Сам ничего не измеряет: измерения берёт у
# assets/report_check.py (docx_facts / pdf_facts с detail=True), здесь — только правила и уровни must / should.
# must — с этим отчёт сдавать нельзя (код выхода 3); should — желательно поправить.
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from collections import Counter

from .common import (KitError, KIT_VERSION, EXIT_MUST, EXIT_OK, STYLE_BODY, STYLE_LISTING, STYLE_CAPTION_FIG,
                     STYLE_CAPTION_TAB, EQ_TABLE_MARK, from_default, load_style)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import report_check as rc  # noqa: E402

SHEETS = {"a4": (210.0, 297.0), "a5": (148.0, 210.0), "a3": (297.0, 420.0), "letter": (215.9, 279.4)}
TOL_MARGIN, TOL_SHEET = 0.5, 1.0   # допуски, мм
SHARE = 0.8                        # какая доля разделов (знаков основного текста) должна совпасть с профилем
SMALL_TEXT_PT = 4.5                # строка текста на рисунке ниже этого в печати — не прочитать
SIDES = {"left": "левое", "right": "правое", "top": "верхнее", "bottom": "нижнее"}
ALIGN_RU = {"left": "по левому краю", "center": "по центру", "right": "по правому краю", "justify": "по ширине"}

# Строки, которых в отчёте быть не должно: (код, шаблон, что сказать). Ищутся вне листингов (правило 3).
STRINGS = [
    ("stub.toc", re.compile(r"Обновите\s+поле", re.I), "оглавление не обновлено — в нём осталась заглушка «Обновите поле»"),
    ("stub.bookmark", re.compile(r"Ошибка!\s*Закладка не определена|Error!\s*Bookmark", re.I), "в тексте сломанная ссылка Word («Закладка не определена»)"),
    ("stub.placeholder", re.compile(r"\{\{[A-ZА-ЯЁ_]{2,}\}\}|\[ Место для"), "остался незаполненный шаблон"),
    ("leak.path", re.compile(r"moodle-work[\\/]users[\\/]\d{5,}|jarvis-app"), "в отчёт попал служебный путь с ПК"),
    ("leak.service", re.compile(r"JOB\.json|MEDIA:"), "в отчёт попали служебные слова программы"),
    ("markup.raw", re.compile(r"@(?:fig|tbl|eq|lst):|\{#|!\[|\$\$|\\frac|\*\*"), "в тексте осталась необработанная разметка"),
]
TITLE_UNFILLED = re.compile(r"Фамилия\s+И\.\s?О\.|ФИО\s+студента|\?\?")


def _norm(name):
    return re.sub(r"\s+", "", str(name or "")).lower()


def _num(v):
    """Число для показа человеку: без лишнего нуля, с запятой."""
    return (f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)).replace(".", ",")


def _cut(s, n=70):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _dominant(counter):
    """Самое частое значение и его доля."""
    total = sum(counter.values())
    if not total:
        return None, 0.0
    v, n = counter.most_common(1)[0]
    return v, n / total


class _Check:
    """Одна проверка отчёта: накопленные отклонения и сведения о файлах."""

    def __init__(self, style, max_bytes, fix_name):
        self.style, self.max_bytes, self.fix_name = style, max_bytes, fix_name
        self.items = []
        self.kit = False

    def add(self, code, level, where, measured, expected, text):
        self.items.append({"code": code, "level": level, "where": where, "measured": measured, "expected": expected, "text": text})

    def level(self, key):
        """Правило 4: отклонение от значения профиля, взятого по умолчанию, — should; от заданного явно — must."""
        return "should" if from_default(self.style, key) else "must"

    # ---------- файлы ----------
    def files(self, docx, pdf):
        for path in (pdf, docx):
            if path and self.max_bytes is not None and os.path.getsize(path) > self.max_bytes:
                self.add("file.size", "must", os.path.basename(path), os.path.getsize(path), self.max_bytes,
                         f"Файл {os.path.basename(path)} весит {_size(os.path.getsize(path))} — больше допустимых {_size(self.max_bytes)}. Уменьши рисунки.")
        target = pdf or docx
        if self.fix_name and target:
            nfc = lambda s: unicodedata.normalize("NFC", s)
            have, want = nfc(os.path.basename(target)), nfc(self.fix_name)
            if not pdf:  # сдаётся только DOCX: сравниваем имена без расширения
                have, want = os.path.splitext(have)[0], os.path.splitext(want)[0]
            if have != want:
                self.add("file.name", "must", os.path.basename(target), os.path.basename(target), self.fix_name,
                         f"Файл называется «{os.path.basename(target)}», а должен «{self.fix_name}».")
        if not docx:
            self.add("file.no_docx", "should", "файлы", None, "DOCX рядом с PDF", "Нет файла DOCX: оформление проверено только по PDF, поля и стили — приблизительно.")

    def pdf_open(self, pdf, tmp):
        """Измерения PDF или None, если это не PDF (тогда отклонение уже записано)."""
        name = os.path.basename(pdf)
        with open(pdf, "rb") as f:
            head = f.read(1024)
        if b"%PDF-" not in head:
            self.add("file.not_pdf", "must", name, _cut(head[:24].decode("latin-1")), "файл PDF", f"Файл {name} — не PDF (нет заголовка %PDF). Сохрани отчёт в PDF заново.")
            return None
        try:
            facts = _pdf_facts(pdf, tmp)
        except Exception as e:
            try:
                import pymupdf
                with pymupdf.open(pdf) as d:
                    empty = d.page_count == 0
            except Exception:
                empty = False
            if empty:
                self.add("file.pages0", "must", name, 0, "хотя бы одна страница", f"В файле {name} нет ни одной страницы.")
            else:
                self.add("file.not_pdf", "must", name, _cut(str(e)), "файл PDF", f"Файл {name} повреждён и не открывается как PDF. Сохрани отчёт в PDF заново.")
            return None
        if not facts.get("pages"):
            self.add("file.pages0", "must", name, 0, "хотя бы одна страница", f"В файле {name} нет ни одной страницы.")
            return None
        return facts

    # ---------- лист и поля ----------
    def sheet(self, sizes, where):
        """Размер листа: sizes — список [ширина, высота] в мм по разделам (DOCX) или страницам (PDF)."""
        name = str(self.style.get("page", {}).get("size", "A4"))
        want = SHEETS.get(name.lower())
        sizes = [s for s in sizes if s and s[0] and s[1]]
        if not want or not sizes:
            return
        ok = [all(abs(a - b) <= TOL_SHEET for a, b in zip(sorted(s), want)) for s in sizes]  # поворот листа — не отклонение
        if sum(ok) / len(ok) >= SHARE:
            return
        bad = Counter(tuple(s) for s, good in zip(sizes, ok) if not good).most_common(1)[0][0]
        level = "must" if self.kit else self.level("page.size")
        self.add("page.size", level, where, f"{_num(bad[0])}×{_num(bad[1])} мм", f"{name} ({_num(want[0])}×{_num(want[1])} мм)",
                 f"Лист {_num(bad[0])}×{_num(bad[1])} мм, а нужен {name} ({_num(want[0])}×{_num(want[1])} мм).")

    def margins(self, sections):
        want = self.style.get("page", {}).get("margins_mm") or {}
        secs = [s for s in sections if not s["title"]] or sections  # раздел титульного листа свёрстан по-своему
        secs = [s for s in secs if all(s.get(k) is not None for k in SIDES)]
        if not secs or any(k not in want for k in SIDES):
            return
        # Word при повороте листа переносит поля вместе с листом: у альбомного раздела допускаем оба поворота
        turns = [{"top": want["left"], "bottom": want["right"], "left": want["bottom"], "right": want["top"]},
                 {"top": want["right"], "bottom": want["left"], "left": want["top"], "right": want["bottom"]}]
        fits = lambda s, w: all(abs(s[k] - w[k]) <= TOL_MARGIN for k in SIDES)
        turned = [s["page_mm"][0] > s["page_mm"][1] and any(fits(s, t) for t in turns) for s in secs]
        for side, ru in SIDES.items():
            ok = [t or abs(s[side] - want[side]) <= TOL_MARGIN for s, t in zip(secs, turned)]
            if sum(ok) / len(ok) >= SHARE:
                continue
            bad = Counter(s[side] for s, good in zip(secs, ok) if not good).most_common(1)[0][0]
            self.add(f"margins.{side}", self.level(f"page.margins_mm.{side}"), "DOCX, параметры страницы", f"{_num(bad)} мм", f"{_num(float(want[side]))} мм",
                     f"{ru.capitalize()} поле {_num(bad)} мм, а нужно {_num(float(want[side]))} мм.")

    # ---------- основной текст ----------
    def body(self, pars, pdf_detail=None):
        """Правило 1: шрифт, кегль, интервал, отступ и выравнивание — по абзацам RKBody, иначе по длинным не моноширинным."""
        want = self.style.get("body", {})
        body = [p for p in pars if p["style"] == STYLE_BODY] if self.kit else \
               [p for p in pars if len(p["text"]) > 150 and not p["mono"] and not p["table"] and not p["title"]]
        if not body:
            return
        where = "основной текст"
        fonts, sizes = Counter(), Counter()
        for p in body:
            fonts.update(p["fonts"])
            sizes.update(p["sizes"])
        # код в строке набран моноширинным шрифтом — это не шрифт основного текста (если им не набрано всё)
        text_fonts = Counter({f: n for f, n in fonts.items() if not rc.is_mono(f)})
        if sum(text_fonts.values()) >= sum(fonts.values()) / 2:
            fonts = text_fonts
        if not _dominant(fonts)[0] and pdf_detail:  # шрифт задан темой Word — берём то, что получилось в PDF
            fonts = Counter({f["value"]: f["share"] for f in pdf_detail["fonts"]})
        self._font(fonts, want.get("font"), where)
        sizes.pop(0, None)
        self._size(sizes, want.get("size_pt"), where)
        weight = lambda key: Counter({v: sum(len(p["text"]) for p in body if p[key] == v) for v in {p[key] for p in body}})
        sp, _ = _dominant(weight("spacing"))
        if want.get("line_spacing") is not None and (not isinstance(sp, float) or abs(sp - float(want["line_spacing"])) > 0.05):
            self.add("body.spacing", "should", where, sp, want["line_spacing"], f"Межстрочный интервал основного текста {_num(sp)}, а нужен {_num(float(want['line_spacing']))}.")
        ind, _ = _dominant(weight("indent_mm"))
        if want.get("first_indent_cm") is not None and abs(ind - float(want["first_indent_cm"]) * 10) > 1.0:
            self.add("body.indent", "should", where, f"{_num(ind / 10)} см", f"{_num(float(want['first_indent_cm']))} см",
                     f"Красная строка {_num(round(ind / 10, 2))} см, а нужна {_num(float(want['first_indent_cm']))} см.")
        al, _ = _dominant(weight("align"))
        if want.get("align") and al != want["align"]:
            self.add("body.align", "should", where, al, want["align"], f"Основной текст выровнен {ALIGN_RU.get(al, al)}, а нужно {ALIGN_RU.get(want['align'], want['align'])}.")

    def _font(self, fonts, want, where):
        fonts = Counter({k: v for k, v in fonts.items() if k})
        total = sum(fonts.values())
        if not want or not total:
            return
        good = sum(n for f, n in fonts.items() if _norm(f) == _norm(want))
        if good / total >= SHARE:
            return
        other = next(f for f, _ in fonts.most_common() if _norm(f) != _norm(want))
        self.add("body.font", self.level("body.font"), where, other, want, f"Основной текст набран шрифтом {other}, а нужен {want}.")

    def _size(self, sizes, want, where):
        total = sum(sizes.values())
        if want is None or not total:
            return
        good = sum(n for s, n in sizes.items() if abs(float(s) - float(want)) <= 0.25)
        if good / total >= SHARE:
            return
        other = next(s for s, _ in sizes.most_common() if abs(float(s) - float(want)) > 0.25)
        self.add("body.size", self.level("body.size_pt"), where, other, want, f"Кегль основного текста {_num(float(other))} пт, а нужен {_num(float(want))} пт.")

    def body_pdf(self, facts):
        """Только PDF: шрифт и кегль — по не моноширинному тексту, интервал — по оценке шага строк."""
        det, want = facts["detail"], self.style.get("body", {})
        # в PDF шрифты и кегли титула, заголовков и подписей смешаны с текстом: судим по самому частому значению
        top = lambda key: Counter({x["value"]: x["share"] for x in det[key][:1]})
        self._font(top("fonts"), want.get("font"), "PDF, основной текст")
        self._size(top("sizes"), want.get("size_pt"), "PDF, основной текст")
        est = facts.get("line_spacing_estimate")
        if est and want.get("line_spacing") is not None and abs(est - float(want["line_spacing"])) > 0.2:
            self.add("body.spacing", "should", "PDF, основной текст", est, want["line_spacing"],
                     f"Межстрочный интервал по оценке {_num(float(est))}, а нужен {_num(float(want['line_spacing']))}.")

    # ---------- строки, которых быть не должно ----------
    def strings_docx(self, pars):
        hits = {}
        for p in pars:
            full = p["text"].replace("\xa0", " ")
            plain = "" if p["style"] == STYLE_LISTING or p["mono"] else p["plain"].replace("\xa0", " ")
            for code, pat, _ in STRINGS:
                m = pat.search(plain)
                level = "must" if m else "should"
                m = m or (code != "markup.raw" and pat.search(full))  # «**», «$$», «![» в коде — обычное дело
                if m:
                    hits.setdefault((code, level), []).append((m.group(0), full))
            if p["title"]:
                m = TITLE_UNFILLED.search(full)
                if m:
                    hits.setdefault(("title.unfilled", "must"), []).append((m.group(0), full))
        self._hits(hits, "DOCX", lambda ctx: f"абзац «{_cut(ctx, 60)}»")

    def strings_pdf(self, lines):
        hits = {}
        pages = {}
        for l in lines:
            if not l["page_number"]:
                pages.setdefault(l["page"], []).append(l)
        for pno, ls in sorted(pages.items()):
            full = "\n".join(l["text"] for l in ls).replace("\xa0", " ")
            plain = "\n".join(l["plain"] for l in ls if not l["mono"]).replace("\xa0", " ")
            for code, pat, _ in STRINGS:
                # длинный путь Word переносит на следующую строку — ищем его и в склеенном тексте
                glue = code == "leak.path"
                m = pat.search(plain) or (glue and pat.search(plain.replace("\n", "")))
                level = "must" if m else "should"
                m = m or (code != "markup.raw" and (pat.search(full) or (glue and pat.search(full.replace("\n", "")))))
                if m:
                    hits.setdefault((code, level), []).append((m.group(0), pno))
            if pno == 1:
                m = TITLE_UNFILLED.search(full)
                if m:
                    hits.setdefault(("title.unfilled", "must"), []).append((m.group(0), pno))
        self._hits(hits, "PDF", lambda ctx: f"стр. {ctx}")

    def _hits(self, hits, src, place):
        says = {c: t for c, _, t in STRINGS}
        for (code, level), found in hits.items():
            what, ctx = found[0]
            more = f" (и ещё {len(found) - 1})" if len(found) > 1 else ""
            if code == "title.unfilled":
                text = f"Титульный лист не заполнен: осталось «{_cut(what, 30)}»."
            else:
                text = f"{says[code].capitalize()}: «{_cut(what, 40)}», {place(ctx)}{more}."
                if level == "should":
                    text += " Это внутри листинга — проверь, что так и задумано."
            self.add(code, level, f"{src}, {place(ctx)}", _cut(what, 60), "такого текста в отчёте быть не должно", text)

    # ---------- нумерация рисунков и таблиц ----------
    def numbering(self, fig, tab, where):
        for kind, nums, ru, ru2 in (("figure", fig, "рисунков", "Рисунок"), ("table", tab, "таблиц", "Таблица")):
            n = rc.numbering(nums)
            if n["missing"]:
                miss = ", ".join(str(x) for x in n["missing"][:6])
                self.add(f"numbering.{kind}.gap", "must", where, ", ".join(nums[:30]), "номера подряд с 1", f"В нумерации {ru} пропуск: нет номера {miss} (есть: {', '.join(nums[:15])}).")
            if n["duplicates"]:
                dup = ", ".join(n["duplicates"][:6])
                self.add(f"numbering.{kind}.dup", "must", where, ", ".join(nums[:30]), "каждый номер один раз", f"Номер повторяется: «{ru2} {dup}» встречается больше одного раза.")

    def captions_docx(self, pars):
        """Номера подписей: у отчёта сборщика — по стилям подписей, иначе — по виду строки «Рисунок N – …»."""
        fig, tab = [], []
        for p in pars:
            t = p["text"].strip()
            if self.kit:
                m = re.match(r"\D*?(\d+(?:\.\d+)*)", t) if p["style"] in (STYLE_CAPTION_FIG, STYLE_CAPTION_TAB) else None
                if m:
                    (fig if p["style"] == STYLE_CAPTION_FIG else tab).append(m.group(1))
            elif not p["title"] and len(t) < 200:
                for pat, out in ((rc.CAP_FIG, fig), (rc.CAP_TAB, tab)):
                    m = pat.match(t)
                    if m and (m.group(3) or not m.group(4)):  # «Рисунок 3 показывает…» — не подпись
                        out.append(m.group(2))
        return fig, tab

    def captions_form(self, facts, where):
        """Вид подписей и ссылки на них в тексте — желательное."""
        bad, unref, total = [], 0, 0
        for kind, key, pos in (("figure", "figures", "под рисунком"), ("table", "tables", "над таблицей")):
            prof = self.style.get(kind, {})
            for c in facts[key]["captions"]:
                if not (c["separator"] or not c["text"]):
                    continue
                total += 1
                unref += c.get("mentions_in_text") == 0
                sep = str(prof.get("sep", " – ")).strip()
                if c["word"] != prof.get("word", c["word"]) or (c["text"] and c["separator"] != sep) or c.get("position", pos) != pos:
                    bad.append(f"{c['word']} {c['number']}")
        if bad:
            f, t = self.style.get("figure", {}), self.style.get("table", {})
            self.add("caption.form", "should", where, len(bad), f"«{f.get('word', 'Рисунок')} N{f.get('sep', ' – ')}Название» под рисунком, «{t.get('word', 'Таблица')} N{t.get('sep', ' – ')}Название» над таблицей",
                     f"Подписи не по образцу ({len(bad)}): {', '.join(bad[:5])}{'…' if len(bad) > 5 else ''}.")
        if unref:
            self.add("ref.missing", "should", where, unref, 0, f"На {unref} из {total} рисунков и таблиц нет ссылки в тексте.")

    # ---------- прочее ----------
    def page_numbers(self, has, where):
        pn = self.style.get("page_number", {})
        if pn.get("required") and pn.get("position", "") != "none" and not has:
            self.add("page_number.missing", self.level("page_number.required"), where, "номеров нет", "номера страниц", "В отчёте нет номеров страниц.")

    def tables(self, tables):
        real = [t for t in tables if t["caption"] != EQ_TABLE_MARK and not t["title"]]  # правило 5: обёртки формул — не таблицы
        dec = sum(t["decimal_point"] for t in real)
        if dec and self.style.get("decimal") == "comma":
            ex = [e for t in real for e in t["decimal_point_examples"]][:4]
            self.add("decimal.point", "should", "таблицы", dec, "десятичная запятая", f"В таблицах {dec} чисел с точкой вместо запятой (например {', '.join(ex)}).")
        empty = sum(t["empty"] for t in real)
        if empty:
            self.add("table.empty_cell", "should", "таблицы", empty, 0, f"В таблицах {empty} пустых ячеек — поставь значение или прочерк.")

    def images(self, images):
        small = []
        for i, im in enumerate(images, 1):
            if im["text_px"] and im["px"][0] and im["width_mm"]:
                pt = im["text_px"] / im["px"][0] * im["width_mm"] / 25.4 * 72
                if pt < SMALL_TEXT_PT:
                    small.append((i, pt))
        if small:
            self.add("figure.small_text", "should", "рисунки", len(small), f"строка текста не ниже {_num(SMALL_TEXT_PT)} пт",
                     f"Слишком мелкий текст на рисунках ({len(small)} шт.; по счёту в документе: {', '.join(str(i) for i, _ in small[:8])}) — обрежь или раздели снимок.")

    def orphans(self, facts):
        """Заголовок последней строкой страницы (текст раздела ушёл на следующую)."""
        last = {}
        for l in facts["detail"]["lines"]:
            if not l["page_number"] and (l["page"] not in last or l["y"] >= last[l["page"]]["y"]):
                last[l["page"]] = l
        bad = [h for h in facts.get("headings", []) if h["page"] < facts["pages"] and last.get(h["page"], {}).get("text") == h["text"]]
        if bad:
            self.add("heading.orphan", "should", f"PDF, стр. {bad[0]['page']}", len(bad), 0,
                     f"Заголовок «{_cut(bad[0]['text'], 50)}» остался внизу страницы {bad[0]['page']}, а текст ушёл на следующую.")


def _pdf_facts(pdf, tmp):
    """Измерения PDF. PyMuPDF при поиске таблиц печатает в stdout совет поставить пакет — в итог команды он не нужен."""
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()):
        return rc.pdf_facts(pdf, tmp, render=False, detail=True)


def _size(n):
    return f"{n / 1024 / 1024:.1f} МБ".replace(".", ",") if n >= 1024 * 1024 else f"{max(1, round(n / 1024))} КБ"


def check_report(docx_path: str | None, pdf_path: str | None, style: dict, out_dir: str | None = None, no_word: bool = True,
                 max_bytes: int | None = None, fix_name: str | None = None) -> dict:
    """Сверить отчёт с профилем. Возвращает содержимое check.json (и пишет его в out_dir), печатает список простыми словами."""
    if not docx_path and not pdf_path:
        raise KitError("нечего проверять: не указан ни DOCX, ни PDF")
    for p in (docx_path, pdf_path):
        if p and not os.path.isfile(p):
            raise KitError(f"файл не найден: {p}")
    if isinstance(style, str):
        style = load_style(style)
    docx = os.path.abspath(docx_path) if docx_path else None
    pdf = os.path.abspath(pdf_path) if pdf_path else None
    out_dir = os.path.abspath(out_dir) if out_dir else os.path.dirname(pdf or docx)
    ch = _Check(style, max_bytes, fix_name)
    tmp = tempfile.mkdtemp(prefix="rk-check-")  # report_check пишет рядом report.txt — в папку отчёта он не нужен
    try:
        ch.files(docx, pdf)
        df = pf = None
        if docx:
            try:
                df = rc.docx_facts(docx, tmp, detail=True)
            except Exception as e:
                raise KitError(f"DOCX не открывается: {os.path.basename(docx)} ({_cut(str(e), 80)})", hint="собери отчёт заново командой build")
        if pdf:
            pf = ch.pdf_open(pdf, tmp)
        elif docx and not no_word:
            # PDF не дали, а Word разрешён: переводим копию (исходный DOCX не трогаем) ради числа страниц и вида в PDF
            from . import topdf
            copy = os.path.join(tmp, "copy.docx")
            shutil.copyfile(docx, copy)
            try:
                topdf.convert(copy)
                pf = _pdf_facts(os.path.splitext(copy)[0] + ".pdf", tmp)
            except Exception as e:
                print(f"check: перевести DOCX в PDF не удалось, проверка только по DOCX ({_cut(str(e), 120)})", file=sys.stderr)
        if df:
            dd = df["detail"]
            ch.kit = any(p["style"] == STYLE_BODY for p in dd["pars"])
            ch.sheet([s["page_mm"] for s in dd["sections"] if not s["title"]] or [s["page_mm"] for s in dd["sections"]], "DOCX, параметры страницы")
            ch.margins(dd["sections"])
            ch.body(dd["pars"], pf["detail"] if pf else None)
            ch.strings_docx(dd["pars"])
            ch.numbering(*ch.captions_docx(dd["pars"]), "DOCX")
            ch.captions_form(df, "DOCX")
            ch.page_numbers(df.get("page_number_field"), "DOCX, колонтитулы")
            # отчёт от четырёх страниц без оглавления возвращали на доработку — требуем его всегда, если профиль прямо не отменил
            if not df.get("has_auto_toc") and (pf["pages"] if pf else 0) >= 4 and (style.get("toc") or {}).get("required", True):
                ch.add("toc.missing", "must", "DOCX", "оглавления нет", "оглавление", "В отчёте нет оглавления. Добавь строку [TOC] в начало report.md (после титула) и собери заново.")
            ch.tables(dd["tables"])
            ch.images(dd["images"])
        if pf:
            ch.strings_pdf(pf["detail"]["lines"])
            ch.orphans(pf)
            if not df:
                ch.sheet(pf["detail"]["page_sizes_mm"], "PDF")
                ch.body_pdf(pf)
                caps = lambda key: [c["number"] for c in pf[key]["captions"] if c["separator"] or not c["text"]]
                ch.numbering(caps("figures"), caps("tables"), "PDF")
                ch.captions_form(pf, "PDF")
                ch.page_numbers(pf["page_numbers"]["pages_with_number"] >= max(1, (pf["pages"] - 1) // 2) or pf["pages"] == 1, "PDF")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ch.items.sort(key=lambda it: it["level"] != "must")
    result = {"kit_version": KIT_VERSION, "pages": pf["pages"] if pf else (df or {}).get("pages_in_file_properties"),
              "size": os.path.getsize(pdf or docx), "built_by_kit": ch.kit, "items": ch.items}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "check.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(render(result))
    return result


def render(result):
    """Список отклонений простыми словами."""
    must = [it for it in result["items"] if it["level"] == "must"]
    should = [it for it in result["items"] if it["level"] == "should"]
    pages = f"страниц {result['pages']}" if result["pages"] else "число страниц неизвестно"
    out = [f"Проверка отчёта: {pages}, размер {_size(result['size'])}."]
    for title, group in (("Обязательно исправить", must), ("Желательно поправить", should)):
        if group:
            out.append(f"{title} ({len(group)}):")
            out += [f"  {i}. {it['text']} [{it['code']}]" for i, it in enumerate(group, 1)]
    out.append("Итог: " + ("отчёт сдавать нельзя, пока не исправлено обязательное." if must else "обязательных замечаний нет." if should else "замечаний нет."))
    return "\n".join(out)


def exit_code(result):
    return EXIT_MUST if any(it["level"] == "must" for it in result["items"]) else EXIT_OK


def main(argv=None):
    """check <docx> [<pdf>] --style <style.json> [--out <папка>] [--no-word] [--max-bytes N] [--fix-name "<имя>.pdf"]"""
    import argparse
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="check")
    ap.add_argument("files", nargs="+", help="отчёт.docx и/или отчёт.pdf")
    ap.add_argument("--style")
    ap.add_argument("--out")
    ap.add_argument("--no-word", action="store_true")
    ap.add_argument("--max-bytes", type=int)
    ap.add_argument("--fix-name")
    a = ap.parse_args(argv)
    try:
        if len(a.files) > 2:
            raise KitError("check принимает не больше двух файлов: DOCX и PDF")
        docx = next((f for f in a.files if f.lower().endswith(".docx")), None)
        pdf = next((f for f in a.files if f != docx), None)
        result = check_report(docx, pdf, load_style(a.style), out_dir=a.out, no_word=a.no_word, max_bytes=a.max_bytes, fix_name=a.fix_name)
    except KitError as e:
        print(str(e), file=sys.stderr)
        return e.code
    return exit_code(result)
