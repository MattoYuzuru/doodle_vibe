# Сборка отчёта лабы из описания содержания (report.md) и файла оформления (style.json): один проверенный сборщик
# вместо скрипта python-docx, который агент раньше писал заново в каждой лабе.
#   python report_kit.py build          — собрать work/report/report.md в DOCX (с --pdf — сразу и в PDF)
#   python report_kit.py topdf <docx>   — DOCX -> PDF через Word (обновляет оглавление и поля)
#   python report_kit.py check <docx> [<pdf>] --style style.json — сверить отчёт с профилем оформления
#   python report_kit.py title <шаблон.docx> — показать титульную часть шаблона курса
# Подробности — assets/report_kit/ и образец assets/report-sample.md.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report_kit.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
