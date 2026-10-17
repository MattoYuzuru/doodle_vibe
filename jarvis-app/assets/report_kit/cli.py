# Команды сборщика: build (report.md → DOCX, с --pdf — и PDF), title (показать титульную часть шаблона),
# topdf и check (функции соседних модулей). Каждая команда дописывает строку в kit.log папки результата.
import argparse
import datetime
import json
import os
import shutil
import sys
import time
import traceback

from .common import EXIT_OK, EXIT_SELF, STYLES_DIR, KitError, lab_root, load_style, resolve_path

DEFAULT_MD = "work/report/report.md"
DEFAULT_OUT = "work/report/Отчёт.docx"
DEFAULT_VARS = "work/out/values.json"


def _rel(path, base):
    """Путь для сообщений: от папки лабы и с прямыми слешами (в Git Bash обратные теряются)."""
    try:
        path = os.path.relpath(path, base)
    except ValueError:
        pass
    return path.replace("\\", "/")


def _load_json(path, what):
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise KitError(f"{what} не разобрать: {e.msg} (строка {e.lineno})", hint=f"исправь JSON в файле {os.path.basename(path)}")
    except UnicodeDecodeError:
        raise KitError(f"{what} не в UTF-8: {path}", hint="сохрани файл в кодировке UTF-8")
    if not isinstance(data, dict):
        raise KitError(f"{what} должен быть объектом JSON {{…}}: {path}")
    return data


def _style_file(arg, base):
    """--style: имя готового профиля (gost, misis-12) или путь к style.json от папки лабы; без параметра — style.json лабы."""
    if arg:
        name = arg if arg.lower().endswith(".json") else arg + ".json"
        if os.path.basename(name) == name and os.path.isfile(os.path.join(STYLES_DIR, name)) and not os.path.isfile(os.path.join(base, name)):
            return os.path.join(STYLES_DIR, name)
        return resolve_path(base, arg)
    own = os.path.join(base, "style.json")
    return own if os.path.isfile(own) else None


def _snapshot(out, files):
    """Снимок исходников рядом с результатом: <имя>.src/ с report.md, style.json, title.json, values.json."""
    src_dir = os.path.splitext(out)[0] + ".src"
    os.makedirs(src_dir, exist_ok=True)
    for name, path in files.items():
        target = os.path.join(src_dir, name)
        if path and os.path.isfile(path):
            shutil.copyfile(path, target)
        elif os.path.exists(target):
            os.remove(target)  # в этот раз файла не было — старая копия ввела бы в заблуждение
    return src_dir


def cmd_build(a, ctx):
    from . import mdparse, writer
    cwd = os.getcwd()
    base_arg = os.path.abspath(a.base) if a.base else None
    if base_arg and not os.path.isdir(base_arg):
        raise KitError(f"папка лабы не найдена: {a.base}", hint="--base — папка, где лежит ЗАДАНИЕ.md")
    if a.md:
        md = os.path.abspath(a.md)
        if not os.path.isfile(md) and base_arg and not os.path.isabs(a.md):
            md = os.path.join(base_arg, a.md)
    else:
        md = os.path.join(base_arg or cwd, DEFAULT_MD)
    if not os.path.isfile(md):
        raise KitError(f"report.md не найден: {_rel(md, base_arg or cwd)}", hint=f"запускай из папки лабы (файл {DEFAULT_MD}) или укажи --md и --base")
    base = base_arg or lab_root(md)
    out = resolve_path(base, a.out or DEFAULT_OUT, must_exist=False)
    if not out.lower().endswith(".docx"):
        raise KitError(f"имя результата должно кончаться на .docx: {a.out}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ctx["log_dir"] = os.path.dirname(out)

    style_path = _style_file(a.style, base)
    style = load_style(style_path)
    title_path = resolve_path(base, a.title) if a.title else os.path.join(base, "title.json")
    title = _load_json(title_path, "title.json") if os.path.isfile(title_path) else None
    vars_path = resolve_path(base, a.vars) if a.vars else os.path.join(base, *DEFAULT_VARS.split("/"))
    values = _load_json(vars_path, "values.json") if os.path.isfile(vars_path) else None
    try:
        with open(md, encoding="utf-8-sig") as f:
            text = f.read()
    except UnicodeDecodeError:
        raise KitError("report.md не в UTF-8", hint="сохрани report.md в кодировке UTF-8")

    parsed = mdparse.parse(text, style, values)
    warnings = ctx["warnings"] = list(parsed.get("warnings") or [])
    res = writer.build_docx(parsed["blocks"], style, title, base, out, template=a.template, post=a.post)
    warnings += res["warnings"]
    c = ctx["counts"] = res["counts"]
    _snapshot(out, {"report.md": md, "style.json": style_path or os.path.join(STYLES_DIR, "gost.json"),
                    "title.json": title_path if title is not None else None, "values.json": vars_path if values is not None else None})
    print(f"Собрано: {_rel(out, base)}")
    print(f"разделов {c['sections']}, рисунков {c['figures']}, таблиц {c['tables']}, формул {c['formulas']}, листингов {c['listings']}; "
          + (f"предупреждения: {len(warnings)}" if warnings else "предупреждений нет"))
    for w in warnings:
        print(f"  - {w}")
    if a.pdf:
        from .topdf import convert
        info = convert(out)
        print(json.dumps(info, ensure_ascii=False))
    return EXIT_OK


def cmd_title(a, ctx):
    from . import title
    path = os.path.abspath(a.template)
    if not os.path.isfile(path):
        raise KitError(f"шаблон не найден: {a.template}", hint="путь пиши в кавычках и с прямыми слешами, например \"Шаблон отчёта.docx\"")
    report_dir = os.path.join(os.getcwd(), "work", "report")
    ctx["log_dir"] = report_dir if os.path.isdir(report_dir) else None
    for line in title.describe(path):
        print(line)
    return EXIT_OK


def cmd_topdf(a, ctx):
    from .topdf import convert
    ctx["log_dir"] = os.path.dirname(os.path.abspath(a.docx))
    info = convert(a.docx, a.pdf)
    print(json.dumps(info, ensure_ascii=False))
    return EXIT_OK


def cmd_check(a, ctx):
    from . import gate
    if len(a.files) > 2:
        raise KitError("check принимает не больше двух файлов: DOCX и PDF")
    docx = next((f for f in a.files if f.lower().endswith(".docx")), None)
    pdf = next((f for f in a.files if f != docx), None)
    out_dir = os.path.abspath(a.out) if a.out else os.path.dirname(os.path.abspath(docx or pdf))
    ctx["log_dir"] = out_dir
    style_path = _style_file(a.style, os.getcwd())  # без --style — style.json текущей папки (лабы), как у build; нет его — ГОСТ
    result = gate.check_report(docx, pdf, load_style(style_path), out_dir=out_dir, no_word=a.no_word, max_bytes=a.max_bytes, fix_name=a.fix_name)
    ctx["counts"] = {"must": sum(1 for it in result["items"] if it["level"] == "must"),
                     "should": sum(1 for it in result["items"] if it["level"] == "should")}
    return gate.exit_code(result)


def _parser():
    ap = argparse.ArgumentParser(prog="report_kit.py", description="Сборка отчёта лабы из report.md и style.json")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="собрать report.md в DOCX")
    b.add_argument("--md", help=f"описание содержания (по умолчанию {DEFAULT_MD})")
    b.add_argument("--style", help="style.json лабы или имя готового профиля: gost, misis-12")
    b.add_argument("--title", help="title.json (по умолчанию из папки лабы)")
    b.add_argument("--vars", help=f"значения для подстановок (по умолчанию {DEFAULT_VARS})")
    b.add_argument("--template", help="шаблон отчёта курса: его титульная часть станет началом отчёта")
    b.add_argument("--out", help=f"результат (по умолчанию {DEFAULT_OUT})")
    b.add_argument("--pdf", action="store_true", help="сразу перевести в PDF через Word")
    b.add_argument("--base", help="папка лабы (по умолчанию определяется по месту report.md)")
    b.add_argument("--post", help="post.py с функцией post(doc) — правка готового документа перед сохранением")
    b.set_defaults(fn=cmd_build)
    t = sub.add_parser("title", help="показать абзацы титульной части шаблона")
    t.add_argument("template")
    t.set_defaults(fn=cmd_title)
    p = sub.add_parser("topdf", help="DOCX → PDF через Word")
    p.add_argument("docx")
    p.add_argument("pdf", nargs="?")
    p.set_defaults(fn=cmd_topdf)
    c = sub.add_parser("check", help="сверить отчёт с профилем оформления")
    c.add_argument("files", nargs="+", help="отчёт.docx и/или отчёт.pdf")
    c.add_argument("--style")
    c.add_argument("--out")
    c.add_argument("--no-word", action="store_true")
    c.add_argument("--max-bytes", type=int)
    c.add_argument("--fix-name")
    c.set_defaults(fn=cmd_check)
    return ap


def _log(ctx, cmd, code, t0):
    """Строка JSON в kit.log папки результата; сбой записи журнала команду не ломает."""
    if not ctx.get("log_dir"):
        return
    rec = {"at": datetime.datetime.now().isoformat(timespec="seconds"), "cmd": cmd, "code": code, "ms": int((time.time() - t0) * 1000),
           "counts": ctx.get("counts") or {}, "warnings": ctx.get("warnings") or []}
    if ctx.get("error"):
        rec["error"] = ctx["error"]
    try:
        with open(os.path.join(ctx["log_dir"], "kit.log"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        a = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    ctx, t0 = {}, time.time()
    try:
        code = a.fn(a, ctx)
    except KitError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        code, ctx["error"] = e.code, str(e)
    except Exception as e:  # не ошибка входа, а сбой самой программы — код 5, чтобы агент не «чинил» report.md
        tail = traceback.format_exc().strip().splitlines()[-3:]
        print(f"Ошибка сборщика (не report.md): {type(e).__name__}: {e}\n" + "\n".join(tail), file=sys.stderr)
        code, ctx["error"] = EXIT_SELF, f"{type(e).__name__}: {e}"
    _log(ctx, a.cmd, code, t0)
    return code
