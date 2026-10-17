# Конвертация DOCX -> PDF через Microsoft Word: обновить оглавление и поля, сохранить DOCX, выгрузить PDF.
# Word работает в отдельном дочернем процессе с пределом времени: зависший Word (окно с вопросом, битый документ)
# не должен вешать сборку отчёта. При зависании завершается только СВОЙ WINWORD — по PID, который дочерний процесс
# узнаёт через окно Word (Hwnd -> GetWindowThreadProcessId); чужие окна Word (открытые владельцем) не трогаются.
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

from .common import KitError, EXIT_INPUT, EXIT_WORD

ASSETS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Дочерний процесс запускается через -c: файл пакета нельзя запустить как скрипт из-за относительных импортов.
_CHILD = "import sys; sys.path.insert(0, sys.argv[1]); from report_kit.topdf import _child; sys.exit(_child(*sys.argv[2:]))"
WD_PDF = 17          # wdExportFormatPDF
PID_WAIT = 30        # сколько секунд после истечения предела ждём, пока дочерний процесс узнает PID своего Word
QUIT_WAIT = 8        #сколько секунд ждём, пока Word сам закроется после Quit, прежде чем завершить его по PID


def _fail(reason, hint=None):
    return KitError(f"не удалось перевести в PDF: {reason}", hint=hint, code=EXIT_WORD)


# ---------- дочерний процесс: вся работа с Word ----------
def _com_text(e):
    """Понятная причина из ошибки COM: описание от Word, если оно есть."""
    info = getattr(e, "excepinfo", None)
    if info and len(info) > 2 and info[2]:
        return str(info[2]).strip().replace("\r", " ").replace("\n", " ")
    return (str(getattr(e, "strerror", "") or e)).strip()


def _word_pid(word):
    """PID своего экземпляра Word: метим заголовок окна, находим окно по метке, по Hwnd узнаём процесс."""
    import uuid
    import win32gui
    import win32process
    tag = "rk-" + uuid.uuid4().hex
    word.Caption = tag
    found = []

    def see(hwnd, _):
        if tag in win32gui.GetWindowText(hwnd):
            found.append(hwnd)
        return True

    win32gui.EnumWindows(see, None)
    if not found:  # окна приложения нет, пока нет документа: открываем пустой и берём Hwnd его окна
        tmp = word.Documents.Add()
        try:
            found.append(int(word.ActiveWindow.Hwnd))
        finally:
            tmp.Close(False)
    return win32process.GetWindowThreadProcessId(found[0])[1]


def _child(docx, pdf, pidfile):
    """Открыть документ в своём Word, обновить оглавление и поля, сохранить, выгрузить PDF. Итог — строка JSON."""
    sys.stdout.reconfigure(encoding="utf-8")

    def say(ok, reason=None):
        print(json.dumps({"ok": ok, "reason": reason}, ensure_ascii=False), flush=True)
        return 0 if ok else 1

    try:
        import pythoncom
        import win32com.client
    except Exception as e:
        return say(False, f"нет pywin32 ({e})")
    word = doc = None
    stage = "Word не найден или не запускается"
    try:
        pythoncom.CoInitialize()
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        try:
            word.AutomationSecurity = 3  # макросы документа не выполнять
        except Exception:
            pass
        try:
            with open(pidfile + ".w", "w", encoding="utf-8") as f:
                f.write(str(_word_pid(word)))
            os.replace(pidfile + ".w", pidfile)  # родитель видит файл только целым
        except Exception:
            pass  # без PID работаем дальше; родитель тогда не сможет добить зависший Word, но конвертация важнее
        stage = "документ не открылся"
        doc = word.Documents.Open(docx, ConfirmConversions=False, ReadOnly=False, AddToRecentFiles=False)
        if doc.ReadOnly:
            return say(False, "документ открылся только для чтения — он занят другой программой (закройте его в Word)")
        stage = "не обновились оглавление и поля"
        for _ in range(2):  # второй проход: после первого номера страниц могли сдвинуться
            for toc in doc.TablesOfContents:
                toc.Update()
            doc.Fields.Update()
        stage = "не сохранился DOCX"
        doc.Save()
        stage = "не сохранился PDF"
        doc.ExportAsFixedFormat(pdf, WD_PDF)
        return say(True)
    except Exception as e:
        return say(False, f"{stage}: {_com_text(e)}")
    finally:
        for close in (lambda: doc is not None and doc.Close(False), lambda: word is not None and word.Quit(False)):
            try:
                close()
            except Exception:
                pass


# ---------- родитель: быстрые отказы, предел времени, уборка ----------
def _is_winword(pid):
    """Процесс с таким PID жив и это WINWORD.EXE? (PID мог достаться другой программе.)"""
    import win32api
    import win32con
    import win32process
    try:
        h = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION | win32con.SYNCHRONIZE, False, pid)
    except Exception:
        return False
    try:
        if win32process.GetExitCodeProcess(h) != 259:  # 259 — STILL_ACTIVE
            return False
        return os.path.basename(win32process.GetModuleFileNameEx(h, 0)).lower() == "winword.exe"
    except Exception:
        return False
    finally:
        win32api.CloseHandle(h)


def _reap_word(pidfile, wait):
    """Убедиться, что свой Word закрылся: подождать wait секунд и завершить его по PID, если он ещё жив."""
    try:
        with open(pidfile, encoding="utf-8") as f:
            pid = int(f.read().strip())
    except Exception:
        return
    end = time.time() + wait
    while time.time() < end and _is_winword(pid):
        time.sleep(0.2)
    if _is_winword(pid):
        import win32api
        import win32con
        import win32event
        try:
            h = win32api.OpenProcess(win32con.PROCESS_TERMINATE | win32con.SYNCHRONIZE, False, pid)
            win32api.TerminateProcess(h, 1)
            win32event.WaitForSingleObject(h, 10000)  # дождаться конца: до него Word держит открытые файлы
            win32api.CloseHandle(h)
        except Exception:
            pass


def _busy(path):
    """Файл нельзя открыть на запись (держит другая программа)?"""
    try:
        with open(path, "r+b"):
            return False
    except PermissionError:
        return True
    except OSError:
        return False


def _rm(path):
    try:
        os.remove(path)
    except OSError:
        pass


def convert(docx_path: str, pdf_path: str | None = None, timeout: int = 180) -> dict:
    """DOCX -> PDF через Word. Возвращает {"ok": True, "pages": N, "sec": …}; сбой — KitError с кодом 4 и причиной."""
    t0 = time.time()
    docx = os.path.abspath(docx_path)
    if not os.path.isfile(docx):
        raise KitError(f"файл не найден: {docx_path}", code=EXIT_INPUT)
    pdf = os.path.abspath(pdf_path) if pdf_path else os.path.splitext(docx)[0] + ".pdf"
    # Отказы, которые видны без Word: не тратим на них 5–10 секунд запуска.
    try:
        with zipfile.ZipFile(docx) as z:
            good = "word/document.xml" in z.namelist() and z.testzip() is None
    except Exception:
        good = False
    if not good:
        raise _fail("документ не открылся — файл повреждён или это не DOCX", "собери отчёт заново командой build")
    if _busy(docx):
        raise _fail("документ занят другой программой", "закрой его в Word и повтори")
    if os.path.isdir(pdf):
        raise _fail(f"на месте выходного файла папка: {pdf}")
    if os.path.exists(pdf) and _busy(pdf):
        raise _fail(f"занят выходной файл {os.path.basename(pdf)}", "закрой PDF в программе просмотра или укажи другое имя")
    os.makedirs(os.path.dirname(pdf), exist_ok=True)
    # Word работает с копией документа под неповторимым именем и пишет PDF во временный файл; на свои места оба
    # встают только целыми. Копия нужна ещё и потому, что документ, на котором Word был остановлен, он потом
    # открывает с вопросом «в прошлый раз произошла ошибка…» — то есть виснет на том же пути снова и снова.
    mark = f".rk{os.getpid()}-{time.time_ns() % 10**9}"
    work = f"{os.path.splitext(docx)[0]}{mark}.docx"
    tmp = f"{os.path.splitext(pdf)[0]}{mark}.pdf"
    pidfile = tmp + ".pid"
    wd, wn = os.path.split(work)
    try:
        shutil.copyfile(docx, work)
        proc = subprocess.Popen([sys.executable, "-c", _CHILD, ASSETS, work, tmp, pidfile], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(os.environ, PYTHONIOENCODING="utf-8"), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Word мог ещё только запускаться, и его PID неизвестен: убить сейчас дочерний процесс — значит оставить
            # Word сиротой. Даём дочернему процессу время дойти до записи PID, затем останавливаем обоих.
            end = time.time() + PID_WAIT
            while not os.path.exists(pidfile) and proc.poll() is None and time.time() < end:
                time.sleep(0.2)
            proc.kill()
            proc.communicate()
            _reap_word(pidfile, 0)
            raise _fail(f"Word не уложился в {timeout} с и был остановлен", "повтори; если повторяется — упрости документ (большие рисунки, оглавление)")
        _reap_word(pidfile, QUIT_WAIT)
        res = None
        for line in reversed(out.decode("utf-8", "replace").splitlines()):
            try:
                res = json.loads(line)
                break
            except ValueError:
                continue
        if not res or not res.get("ok"):
            raise _fail((res or {}).get("reason") or (err.decode("utf-8", "replace").strip().splitlines() or ["дочерний процесс ничего не сообщил"])[-1])
        if not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
            raise _fail("Word не создал PDF")
        try:
            import pymupdf
            with pymupdf.open(tmp) as d:
                pages = d.page_count
        except Exception as e:
            raise _fail(f"Word создал нечитаемый PDF ({e})")
        try:
            os.replace(tmp, pdf)
        except OSError:
            raise _fail(f"занят выходной файл {os.path.basename(pdf)}", "закрой PDF в программе просмотра или укажи другое имя")
        try:
            os.replace(work, docx)  # итоговый DOCX — после Word: с обновлённым оглавлением
        except OSError:
            raise _fail("PDF готов, но обновлённый DOCX не записался — документ занят другой программой", "закрой его в Word и повтори")
    finally:
        # временные файлы и файл-замок Word (остаётся рядом с документом, если Word пришлось остановить)
        for path in (pidfile, pidfile + ".w", tmp, work, os.path.join(wd, "~$" + wn[2:])):
            _rm(path)
    return {"ok": True, "pages": pages, "sec": round(time.time() - t0, 1)}


def main(argv=None):
    """topdf <docx> [<pdf>] — печатает строку JSON с итогом."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    argv = sys.argv[1:] if argv is None else argv
    if not 1 <= len(argv) <= 2:
        print("Использование: topdf <отчёт.docx> [<отчёт.pdf>]", file=sys.stderr)
        return EXIT_INPUT
    try:
        res = convert(argv[0], argv[1] if len(argv) > 1 else None)
    except KitError as e:
        print(str(e), file=sys.stderr)
        return e.code
    print(json.dumps(res, ensure_ascii=False))
    return 0
