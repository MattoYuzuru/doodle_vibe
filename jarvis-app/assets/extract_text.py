# Текст вложений задания и «материалов курса» — заранее, силами сервера (п. 159 NOTES.md, 16 окт 2026).
# Раньше агент лабы сам писал скрипты извлечения (python-docx, pdftotext) и тратил на это несколько вызовов модели, каждый
# с полным контекстом. Теперь сервер после скачивания задания кладёт текст в tmp\тексты\ рабочей папки, а агент его читает.
# Исходные файлы остаются как есть: оформление шаблона, рисунки и таблицы-картинки агент смотрит в них.
#
# Запуск: python extract_text.py <рабочая папка лабы>
# Берутся .pdf, .docx и .html из самой папки (вложения задания) и из «материалы курса\» (без вложенных папок).
# Готовый текст не пересоздаётся, если он новее исходного файла.
# Печатает JSON: [{"file": "<имя относительно папки>", "txt": "tmp\\тексты\\<имя>.txt", "chars": N, "pages": N|null,
#                  "scan": true|false}] — scan: в PDF почти нет текста (скан), читать придётся страницы-картинки.
import hashlib
import json
import os
import sys

MATERIALS = "материалы курса"
OUT = os.path.join("tmp", "тексты")
MAX_BYTES = 30 * 1024 * 1024


def pdf_text(path):
    import pymupdf
    parts = []
    with pymupdf.open(path) as doc:
        for i, page in enumerate(doc, 1):
            parts.append(f"=== стр. {i} ===\n{page.get_text().strip()}")
        pages = doc.page_count
    text = "\n\n".join(parts)
    body = sum(len(p) for p in parts) - sum(len(f"=== стр. {i} ===\n") for i in range(1, pages + 1))
    return text, pages, pages > 0 and body / pages < 80


def docx_text(path):
    # Абзацы и таблицы в том порядке, как они идут в документе; ячейки таблицы — через « | ».
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    d = docx.Document(path)
    out = []
    for el in d.element.body.iterchildren():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "p":
            t = Paragraph(el, d).text.strip()
            if t:
                out.append(t)
        elif tag == "tbl":
            for row in Table(el, d).rows:
                cells = []
                for c in row.cells:
                    t = " ".join(c.text.split())
                    if not cells or cells[-1] != t:  # объединённые ячейки python-docx повторяет
                        cells.append(t)
                out.append(" | ".join(cells))
            out.append("")
    return "\n".join(out).strip(), None, False


def html_text(path):
    # Страницы курса из Moodle (лекции, «Требования к отчётам»): текст без разметки, абзацы и строки таблиц — с новой строки.
    from html.parser import HTMLParser

    class P(HTMLParser):
        BREAK = {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "pre", "blockquote"}
        SKIP = {"script", "style", "head"}

        def __init__(self):
            super().__init__()
            self.out, self.skip = [], 0

        def handle_starttag(self, tag, attrs):
            if tag in self.SKIP:
                self.skip += 1
            elif tag in self.BREAK:
                self.out.append("\n")
            elif tag in ("td", "th"):
                self.out.append(" | ")

        def handle_endtag(self, tag):
            if tag in self.SKIP and self.skip:
                self.skip -= 1
            elif tag in self.BREAK:
                self.out.append("\n")

        def handle_data(self, data):
            if not self.skip:
                self.out.append(data)

    p = P()
    with open(path, encoding="utf-8", errors="replace") as f:
        p.feed(f.read())
    lines = [" ".join(l.split()).strip(" |") for l in "".join(p.out).split("\n")]
    text, prev = [], ""
    for l in lines:
        if l or prev:
            text.append(l)
        prev = l
    return "\n".join(text).strip(), None, False


READERS = {".pdf": pdf_text, ".docx": docx_text, ".html": html_text, ".htm": html_text}


def long_path(p):
    # Названия лекций в Moodle бывают по 200 знаков: с папкой лабы путь длиннее 260, и без «\\?\» Windows его не откроет.
    return "\\\\?\\" + p if os.name == "nt" and not p.startswith("\\\\?\\") else p


def txt_name(rel):
    # Имя файла текста — короткое (путь к нему агент читает и набирает в командах), с хвостом-хешем, если обрезано.
    name = rel.replace(os.sep, " - ")
    if len(name) > 90:
        name = name[:80].rstrip(" ._-") + " " + hashlib.sha1(name.encode("utf-8")).hexdigest()[:6]
    return name + ".txt"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    root = long_path(os.path.abspath(sys.argv[1]))
    out_dir = os.path.join(root, OUT)
    found = []
    for sub in ("", MATERIALS):
        d = os.path.join(root, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            src = os.path.join(d, name)
            ext = os.path.splitext(name)[1].lower()
            if ext in READERS and os.path.isfile(src) and not name.startswith("~$") and os.path.getsize(src) <= MAX_BYTES:
                found.append((os.path.join(sub, name) if sub else name, src, ext))
    res = []
    for rel, src, ext in found:
        txt_rel = os.path.join(OUT, txt_name(rel))
        txt = os.path.join(root, txt_rel)
        item = {"file": rel, "txt": txt_rel}
        try:
            if os.path.exists(txt) and os.path.getmtime(txt) >= os.path.getmtime(src):
                with open(txt, encoding="utf-8") as f:
                    text = f.read().rstrip("\n")
                meta_path = txt + ".json"
                meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
                pages, scan = meta.get("pages"), meta.get("scan", False)
            else:
                text, pages, scan = READERS[ext](src)
                text = text.rstrip("\n")
                os.makedirs(out_dir, exist_ok=True)
                with open(txt, "w", encoding="utf-8", newline="\n") as f:  # без \r: короче и одинаково при повторном чтении
                    f.write(text + "\n")
                with open(txt + ".json", "w", encoding="utf-8") as f:
                    json.dump({"pages": pages, "scan": scan}, f)
            item.update(chars=len(text), pages=pages, scan=scan)
        except Exception as e:  # битый или защищённый файл — агент разберёт его сам
            item.update(error=f"{type(e).__name__}: {e}"[:200])
        res.append(item)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
