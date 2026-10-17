# Разбор официального расписания МИСИС (файлы Excel с misis.ru/students/schedule/, по одному на институт) → JSON.
# Запуск: python schedule_xls.py <файл.xls|.xlsx>   (нужны xlrd для .xls и openpyxl для .xlsx)
#
# Устройство листа (так у большинства институтов): строка 1 — «Дата | Номер | Время | <группа> …», каждая группа
# занимает по 2 колонки на подгруппу (предмет, аудитория); строка 2 — номера подгрупп. Дальше дни недели, в каждом 7 пар,
# у каждой пары две строки: первая — верхняя (нечётная) неделя, вторая — нижняя (чётная). Пара на обе недели записана
# в обеих строках. В ячейке: «[N п.г.] Предмет (Лекционные|Лабораторные|…)», со 2-й строки — преподаватель, иногда
# «с 01.09.2026 по 18.09.2026» (пара идёт только в эти даты). Листы другого вида пропускаются (их группам остаётся
# только «Дневач»).
#
# Вывод: {"groups": {"<группа>": [{"wd": 0-6, "week": 0|1, "start": "09:00", "end": "10:35", "name", "type",
#          "typeLabel", "teacher", "place", "subgroup": ""|"1"|"2"…, "from": "YYYY-MM-DD"?, "to"?, "dates": []?}]},
#         "skipped": ["<лист>: причина"]}
import json
import re
import sys

DAYS = {"понедельник": 0, "вторник": 1, "среда": 2, "четверг": 3, "пятница": 4, "суббота": 5, "воскресенье": 6}
TYPES = {"Лекционные": "lecture", "Лабораторные": "lab", "Практические": "practice", "Семинарские": "practice"}
SUB_PREFIX = re.compile(r"^\s*(\d+(?:\s*,\s*\d+)*)\s*п\.?\s*г\.?\s*", re.I)
DATE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")


def text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def sheets(path):
    if path.lower().endswith(".xlsx"):
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        for ws in wb.worksheets:
            yield ws.title, [[text(v) for v in row] for row in ws.iter_rows(values_only=True)]
    else:
        import xlrd
        bk = xlrd.open_workbook(path)
        for sh in bk.sheets():
            yield sh.name, [[text(v) for v in sh.row_values(r)] for r in range(sh.nrows)]


def iso(m):
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f"{y:04d}-{mo:02d}-{d:02d}"


def lesson_of(cell, place):
    """Ячейка предмета → поля пары (без дня, недели и подгруппы)."""
    lines = [l.strip() for l in cell.replace("\r", "").split("\n") if l.strip()]
    if not lines:
        return None
    first = lines[0]
    subs = ""
    m = SUB_PREFIX.match(first)
    if m:
        subs = re.sub(r"\s+", "", m.group(1))
        first = first[m.end():].strip()
    tm = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", first)
    name, label = (tm.group(1).strip(), tm.group(2).strip()) if tm else (first, "")
    out = {"name": name, "typeLabel": label, "type": TYPES.get(label, "other"), "teacher": "", "place": place.strip(), "subs": subs}
    for l in lines[1:]:
        dates = list(DATE.finditer(l))
        if dates:
            low = l.lower()
            if re.search(r"(^|\s)с\s*\d", low) or re.search(r"(^|\s)по\s*\d", low):
                fm = re.search(r"(?:^|\s)с\s*(\d{1,2}\.\d{1,2}\.\d{4})", low)
                tm2 = re.search(r"(?:^|\s)по\s*(\d{1,2}\.\d{1,2}\.\d{4})", low)
                if fm:
                    out["from"] = iso(DATE.search(fm.group(1)))
                if tm2:
                    out["to"] = iso(DATE.search(tm2.group(1)))
            else:
                out["dates"] = sorted({iso(d) for d in dates})
        elif not out["teacher"]:
            out["teacher"] = l
    return out


def parse_sheet(rows):
    if len(rows) < 4:
        return {}, "мало строк"
    head = rows[0] + [""] * 3
    if head[1] != "Номер" or head[2] != "Время":
        return {}, "другой вид листа"
    starts = [(c, head[c]) for c in range(3, len(rows[0])) if head[c]]
    width = max(len(r) for r in rows)
    sub_row = rows[1] + [""] * width
    groups = []
    for i, (c, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else width
        subs = [(p, sub_row[p]) for p in range(c, end) if sub_row[p]] or [(c, "1")]
        groups.append((name, subs))
    out = {name: [] for name, _ in groups}
    day, start, finish, week = None, None, None, 0
    for r in range(2, len(rows)):
        row = rows[r] + [""] * (width - len(rows[r]))
        d = row[0].lower().replace(" ", "")
        if d in DAYS:
            day = DAYS[d]
        if row[1] and row[2]:
            t = re.findall(r"(\d{1,2}):(\d{2})", row[2])
            if len(t) >= 2:
                start, finish = f"{int(t[0][0]):02d}:{t[0][1]}", f"{int(t[1][0]):02d}:{t[1][1]}"
                week = 0
            else:
                start = None
        elif start:
            week += 1
        if day is None or not start or week > 1:
            continue
        for name, subs in groups:
            entries = []
            for p, label in subs:
                cell = row[p] if p < len(row) else ""
                if cell:
                    entries.append((label, cell, row[p + 1] if p + 1 < len(row) else ""))
            if not entries:
                continue
            # Одинаково во всех колонках подгрупп — пара для всей группы.
            if len(subs) > 1 and len(entries) == len(subs) and len({(e[1], e[2]) for e in entries}) == 1:
                entries = [("", entries[0][1], entries[0][2])]
            elif len(subs) == 1:
                entries = [("", entries[0][1], entries[0][2])]
            for label, cell, place in entries:
                les = lesson_of(cell, place)
                if not les:
                    continue
                subs_in_text = les.pop("subs")
                sub = label
                if not sub and subs_in_text and "," not in subs_in_text:
                    sub = subs_in_text  # у группы одна колонка, а в ячейке «2 п.г.»
                out[name].append({"wd": day, "week": week, "start": start, "end": finish, "subgroup": sub, **les})
    return {k: v for k, v in out.items() if v}, None


def main():
    path = sys.argv[1]
    result = {"groups": {}, "skipped": []}
    for title, rows in sheets(path):
        groups, why = parse_sheet(rows)
        if why:
            result["skipped"].append(f"{title}: {why}")
        for g, lessons in groups.items():
            result["groups"].setdefault(g, []).extend(lessons)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
