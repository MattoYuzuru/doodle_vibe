# Разбор учебного плана МИСИС (файл «<код>-<ГРУППА>-<ГГ>.plx.pdf» со страницы misis.ru/sveden/education/eduop/) → JSON.
# Запуск: python curriculum_pdf.py <файл.pdf>   (нужен pymupdf)
#
# Устройство файла (выгрузка из «1С: Университет», одинаковая у всех программ): стр. 1 — титул (программа, институт,
# год начала подготовки, учебный год); стр. 2 — календарный учебный график: строка «Нед | 1 … 52» (неделя 1 — 1–7
# сентября) и по строке на курс (I…IV) с буквой в каждой неделе: Э — экзаменационная сессия, К — каникулы,
# У/П — практика, Д — защита ВКР, Н — НИР; пустая клетка — теоретическое обучение (Т). Дальше по странице на курс:
# таблица дисциплин — «№ | Индекс | Наименование | …», по каждому семестру курса столбец «Контроль» (Эк — экзамен,
# За — зачёт, ЗаО — зачёт с оценкой, КР/КП — курсовая работа/проект), третий такой столбец — итог за курс (не берём).
# Слова читаются с координатами: строка таблицы — слова на одной высоте, столбец — по положению заголовка.
# Многострочное название (ячейка в 2–3 строки) собирается из соседних строк той же колонки.
#
# Вывод: {"program": {code, name, institute, admission, year, approved, form}, "calendar": {"I": "ТТТ…ЭЭЭКК…", …},
#         "subjects": [{course, index, name, kind, controls: {"5": ["Эк", "КР"], "6": []}, semesters: [5]}], "skipped": []}
import json
import re
import sys
import unicodedata

import pymupdf

CONTROL = re.compile(r"^(Эк|За|ЗаО|КР|КП|РГР)$")
INDEX = re.compile(r"^(Б[1-3]|ФТД|К\.М)[\w.()]*\d[\w.()]*$")
LETTERS = "ЭКУПДНСТ"
ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6}
KIND = {"Б1": "discipline", "Б2": "practice", "Б3": "gia", "ФТ": "optional", "К.": "module"}


def words(page):
    # NFC: разложенные «й»/«ё» (буква + значок) приводятся к обычным, иначе не совпадают с шаблонами и названиями из журнала.
    return [(x0, y0, x1, y1, unicodedata.normalize("NFC", t)) for x0, y0, x1, y1, t, *_ in page.get_text("words")]


def bands(ws, tol=3.0):
    """Слова, сгруппированные по строкам (по середине высоты): [(yc, [слова слева направо])]."""
    out = []
    for w in sorted(ws, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        yc = (w[1] + w[3]) / 2
        if out and abs(out[-1][0] - yc) <= tol:
            out[-1][1].append(w)
        else:
            out.append([yc, [w]])
    return [(yc, sorted(ws_, key=lambda w: w[0])) for yc, ws_ in out]


def header(page):
    t = unicodedata.normalize("NFC", page.get_text())
    g = lambda rx, flags=0: (re.search(rx, t, flags) or [None, None])[1]
    code_name = re.search(r"\n(\d\d\.\d\d\.\d\d)\s+([^\n]+)\n", t)
    inst = re.search(r"Институт:\s*\n([\s\S]*?)\n(?:Выпускающее|Квалификация)", t)
    return {
        "code": code_name.group(1) if code_name else None,
        "name": code_name.group(2).strip() if code_name else None,
        "institute": re.sub(r"\s+", " ", inst.group(1)).strip() if inst else None,
        "admission": int(g(r"Год начала подготовки[\s\S]{0,60}?(\d{4})") or 0) or None,
        "year": g(r"Учебный год\s*\n?\s*(\d{4}-\d{4})"),
        "approved": g(r"УТВЕРЖДАЮ[\s\S]{0,200}?(\d\d\.\d\d\.\d{4})"),
        "form": g(r"Форма обучения:\s*([^\n]+)"),
        "level": g(r"по программе\s+([^\n]+)"),
    }


def calendar(page):
    """Строки графика по курсам: буква на каждую из 52 недель."""
    ws = words(page)
    ned = [w for w in ws if w[4] == "Нед"]
    if not ned:
        return {}
    y = (ned[0][1] + ned[0][3]) / 2
    cols = sorted((w[0] + w[2]) / 2 for w in ws if abs((w[1] + w[3]) / 2 - y) < 3 and w[4].isdigit())
    if len(cols) < 40:
        return {}
    col = lambda x: min(range(len(cols)), key=lambda i: abs(cols[i] - x))
    out = {}
    for w in ws:
        if w[4] in ROMAN and w[0] < cols[0] - 10:
            yc = (w[1] + w[3]) / 2
            line = ["Т"] * len(cols)
            for v in ws:
                if abs((v[1] + v[3]) / 2 - yc) < 3 and len(v[4]) == 1 and v[4] in LETTERS and v[0] > cols[0] - 10:
                    line[col((v[0] + v[2]) / 2)] = v[4]
            out[w[4]] = "".join(line)
    return out


def course_page(page):
    """Дисциплины одной страницы «КУРС N»: [(course, index, name, controls{sem: [...]}, semesters)] или None."""
    ws = words(page)
    rows = bands(ws)
    course = None
    for _, row in rows[:3]:
        for i, w in enumerate(row):
            if w[4] == "КУРС" and i + 1 < len(row) and row[i + 1][4].isdigit():
                course = int(row[i + 1][4])
    if course is None:
        return None
    # Семестры курса — пары «Семестр | N» в шапке; столбцы «Контроль» — по положению заголовков (третий — итог за курс).
    sems = []
    for _, row in rows[:8]:
        for i, w in enumerate(row):
            if w[4] == "Семестр" and i + 1 < len(row) and row[i + 1][4].isdigit():
                sems.append(int(row[i + 1][4]))
        if sems:
            break
    ctrl_x = sorted((w[0] + w[2]) / 2 for w in ws if w[4] == "Контроль" and (w[1] + w[3]) / 2 < 70)
    if not sems or len(ctrl_x) < len(sems):
        return []
    sem_x = ctrl_x[: len(sems)]
    total_x = ctrl_x[len(sems)] if len(ctrl_x) > len(sems) else None
    name_max = sem_x[0] - 4

    def sem_of(x):
        best = min(range(len(sem_x)), key=lambda i: abs(sem_x[i] - x))
        if total_x is not None and abs(total_x - x) < abs(sem_x[best] - x):
            return None
        return sems[best]

    out = []
    for yc, row in rows:
        idx = next((w for w in row if INDEX.match(w[4]) and w[0] < name_max), None)
        if not idx or yc < 60:
            continue
        # Название: слова колонки «Наименование» на этой строке и соседних (многострочная ячейка), сверху вниз.
        # Метка контроля («ЗаО») стоит под заголовком «Контроль», но её левый край бывает левее границы колонки — отсеиваем по виду.
        parts = [w for w in ws if idx[2] + 1 < w[0] < name_max and abs((w[1] + w[3]) / 2 - yc) <= 6.5 and not INDEX.match(w[4]) and not w[4].isdigit() and not CONTROL.match(w[4])]
        parts.sort(key=lambda w: (round((w[1] + w[3]) / 2), w[0]))
        name = re.sub(r"\s+", " ", " ".join(w[4] for w in parts)).strip()
        controls = {str(s): [] for s in sems}
        for w in row:
            if CONTROL.match(w[4]):
                s = sem_of((w[0] + w[2]) / 2)
                if s is not None and w[4] not in controls[str(s)]:
                    controls[str(s)].append(w[4])
        digits = [w[4] for w in row if w[4].isdigit() and w[0] > (total_x or sem_x[-1]) + 40]
        semesters = sorted({int(ch) for ch in digits[-1]} if digits and len(digits[-1]) <= 12 else set()) if digits else []
        out.append({"course": course, "index": idx[4], "name": name, "kind": KIND.get(idx[4][:2], "discipline"), "controls": controls, "semesters": semesters})
    return out


def main(path):
    doc = pymupdf.open(path)
    out = {"program": header(doc[0]), "calendar": calendar(doc[1]) if doc.page_count > 1 else {}, "subjects": [], "skipped": []}
    for i in range(2, doc.page_count):
        r = course_page(doc[i])
        if r is None:
            out["skipped"].append(f"стр. {i + 1}: не таблица курса")
        else:
            out["subjects"].extend(r)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
