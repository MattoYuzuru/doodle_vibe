"""
Настоящие снимки окна LTspice: открывает схему .asc в самой программе, запускает симуляцию, выводит кривые и снимает окно.

    python lt_shot.py <схема.asc> --out <папка для рисунков> [--traces "V(out),V(in);I(R1)"] [--size 1400x900] [--timeout 120]

Что получается в папке --out (имя — как у схемы):
    <имя>-ltspice.png    всё окно LTspice: схема и график
    <имя>-schematic.png  окно LTspice со схемой во весь размер
    <имя>-plot.png       окно LTspice с графиком во весь размер (если есть кривые)
Рядом со схемой остаются <имя>.log (в нём результаты .meas) и <имя>.raw.

Кривые: --traces (через запятую — на одной панели, через «;» — следующая панель ниже; узлы V(метка), токи I(R1)) или готовый <имя>.plt рядом со схемой (если его нет, скрипт пишет его сам с автомасштабом).
Вид анализа берётся из директивы в схеме (.tran, .ac, .dc, .noise, .tf, .op).
Окно открывается за пределами экрана и фокус не забирает, но рабочий стол нужен: ПК не спит и не заблокирован.
Одновременно снимается одна схема (замок .ltshot.lock). Код возврата 0 — снимки готовы; иначе причина в stderr.
"""
import argparse
import ctypes
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

import win32con
import win32gui
import win32process
from PIL import ImageChops

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from win_shot import shot  # noqa: E402

EXE = r"C:\Users\User\moodle-work\tools\ltspice\LTspice.exe"
LOCK = r"C:\Users\User\moodle-work\.ltshot.lock"
OFFSCREEN = (-4000, 100)
ANALYSES = [("tran", "Transient Analysis"), ("ac", "AC Analysis"), ("dc", "DC transfer characteristic"), ("noise", "Noise Spectral Density - (V/Hz½ or A/Hz½)"),
            ("tf", "Transfer Function"), ("op", "Operating Point")]


def fail(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def analysis_of(asc_text):
    """Заголовок раздела .plt по директиве анализа в схеме (директивы — строки TEXT … !.tran …)."""
    for key, title in ANALYSES:
        if re.search(r"[!;\\n]\s*\." + key + r"\b", asc_text, re.I):
            return key, title
    return None, None


def write_plt(path, title, panes, key):
    """Файл настроек графика с автомасштабом: LTspice сам подберёт оси по данным. panes — список панелей (сверху вниз)."""
    body, n = ["[%s]" % title, "{", "   Npanes: %d" % len(panes)], 0
    for traces in panes:
        items = []
        for t in traces:
            items.append('{%d,0,"%s"}' % (524290 + n, t))
            n += 1
        body += ["   {", "      traces: %d %s" % (len(traces), " ".join(items)), "      Log: 1 2 0" if key == "ac" else "      Log: 0 0 0", "      GridStyle: 1"]
        if key == "ac":  # АЧХ и ФЧХ (диаграмма Боде)
            body += ["      PltMag: 1", "      PltPhi: 1 0"]
        body.append("   }")
    body += ["}", ""]
    with open(path, "w", encoding="utf-16-le") as f:
        f.write(chr(0xFEFF) + "\n".join(body))


def tops(pid):
    out = []

    def cb(h, _):
        if win32gui.IsWindowVisible(h) and win32process.GetWindowThreadProcessId(h)[1] == pid:
            out.append(h)
        return True

    win32gui.EnumWindows(cb, None)
    return out


def dialog_text(h):
    parts = [win32gui.GetWindowText(h)]
    win32gui.EnumChildWindows(h, lambda c, _: parts.append(win32gui.GetWindowText(c)) or True, None)
    return " | ".join(p for p in parts if p and p not in ("OK", "Cancel", "Yes", "No"))[:400]


def frame_insets(hwnd):
    """Невидимая рамка окна Windows 10/11 (за неё PrintWindow отдаёт чёрные поля)."""
    r = wintypes.RECT()
    if ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0:
        return 0, 0, 0, 0
    l, t, rr, b = win32gui.GetWindowRect(hwnd)
    return r.left - l, r.top - t, rr - r.right, b - r.bottom


def plot_rect(main_h):
    """Прямоугольник окна графика (*.raw) внутри снимка главного окна."""
    ml, mt, _, _ = win32gui.GetWindowRect(main_h)
    found = []

    def cb(c, _):
        par = win32gui.GetParent(c)
        if win32gui.IsWindowVisible(c) and par and win32gui.GetClassName(par) == "MDIClient" and win32gui.GetWindowText(c).lower().endswith(".raw"):
            l, t, r, b = win32gui.GetWindowRect(c)
            found.append((l - ml, t - mt, r - ml, b - mt))
        return True

    win32gui.EnumChildWindows(main_h, cb, None)
    return found[0] if found else None


def has_curves(img, main_h):
    """Есть ли в окне графика цветные (насыщенные) точки — кривые; сетка и подписи серые."""
    rect = plot_rect(main_h)
    if not rect:
        return False
    part = img.crop(rect).convert("HSV")
    px, cols = part.load(), 0
    # Кривая тянется по ширине графика, а цветная подпись кривой занимает несколько десятков точек: считаем столбцы.
    for x in range(0, part.width, 2):
        for y in range(40, part.height, 2):  # без заголовка окна
            if px[x, y][1] > 220 and px[x, y][2] > 180:
                cols += 1
                break
    return cols > part.width * 0.12


def acquire_lock(timeout=300):
    t0 = time.time()
    while True:
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK) > 600:  # брошенный замок
                    os.remove(LOCK)
                    continue
            except OSError:
                pass
            if time.time() - t0 > timeout:
                fail("LTspice занят снимком другой лабы дольше 5 минут — попробуй позже", 3)
            time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("asc")
    ap.add_argument("--out", required=True)
    ap.add_argument("--traces", default="")
    ap.add_argument("--size", default="1400x900")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()

    asc = os.path.abspath(a.asc)
    if not os.path.isfile(asc):
        fail("нет файла схемы: " + asc)
    if not os.path.isfile(EXE):
        fail("LTspice не найден: " + EXE)
    w, h = (int(x) for x in a.size.lower().split("x"))
    base = os.path.splitext(asc)[0]
    name = os.path.basename(base)
    os.makedirs(a.out, exist_ok=True)
    text = open(asc, encoding="utf-8", errors="replace").read()
    key, title = analysis_of(text)
    if not key:
        fail("в схеме нет директивы анализа (.tran, .ac, .dc, .op …) — добавь строку TEXT … !.tran <время>")
    panes = [[t.strip() for t in pane.split(",") if t.strip()] for pane in a.traces.split(";")]
    panes = [p for p in panes if p]
    traces = [t for p in panes for t in p]
    plt = base + ".plt"
    if traces and key != "op":
        write_plt(plt, title, panes, key)
    has_plot = os.path.isfile(plt) and key != "op"
    for ext in (".raw", ".op.raw", ".log"):
        try:
            os.remove(base + ext)
        except OSError:
            pass

    acquire_lock()
    p = None
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags = subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 4  # SW_SHOWNOACTIVATE: фокус остаётся у владельца ПК
        p = subprocess.Popen([EXE, "-Run", asc], startupinfo=si)
        t0, main_h, moved = time.time(), None, False
        last, stable, img, shown_at = None, 0, None, None
        while time.time() - t0 < a.timeout:
            if p.poll() is not None:
                fail("LTspice закрылся сам (код %s) — проверь схему: python lt_shot.py не смог её открыть" % p.returncode)
            for hw in tops(p.pid):
                cls, ttl = win32gui.GetClassName(hw), win32gui.GetWindowText(hw)
                if cls == "#32770":
                    if "Change Log" in ttl:  # окно «что нового» после обновления — просто закрыть
                        win32gui.PostMessage(hw, win32con.WM_CLOSE, 0, 0)
                    elif "Usage Data" in ttl or "Keyboard Shortcuts" in ttl:
                        # Вопросы первого запуска. Статистику не отправляем («No, do not send»); сочетания клавиш — как предложено.
                        btns = []
                        win32gui.EnumChildWindows(hw, lambda c, _: btns.append((c, win32gui.GetWindowText(c))) or True, None)
                        for c, t in btns:
                            if "Usage Data" in ttl and t.startswith("No,"):
                                win32gui.SendMessage(c, win32con.BM_CLICK, 0, 0)
                        for c, t in btns:
                            if t == "OK":
                                win32gui.PostMessage(c, win32con.BM_CLICK, 0, 0)
                        time.sleep(1)
                    else:  # сообщение программы: ошибка в схеме, нет символа, не сходится расчёт
                        msg = dialog_text(hw)
                        try:
                            shot(hw, os.path.join(a.out, name + "-error.png"))
                        except BaseException:
                            pass
                        fail("LTspice показал сообщение: " + msg, 2)
                elif "LTspice" in ttl:
                    main_h = hw
            if main_h and not moved:
                win32gui.SetWindowPos(main_h, 0, OFFSCREEN[0], OFFSCREEN[1], w, h, win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
                moved = True
            # Расчёт закончен, когда есть .log с итоговой строкой; затем ждём, пока картинка перестанет меняться.
            done = False
            try:
                done = "Total elapsed time" in open(base + ".log", "rb").read().decode("utf-16-le" if open(base + ".log", "rb").read(2) in (b"\xff\xfe",) else "utf-8", "replace")
            except OSError:
                pass
            if main_h and moved and done:
                cur = shot(main_h, os.path.join(a.out, name + "-ltspice.png"))
                if last is not None and ImageChops.difference(cur, last).getbbox() is None:
                    stable += 1
                else:
                    stable = 0
                last = cur
                # Кривые LTspice дорисовывает через несколько секунд после расчёта: ждём цветные точки в окне графика
                # (не дольше 25 с — при неверном имени кривой их не будет вовсе, об этом скажет предупреждение).
                shown_at = shown_at or time.time()
                waited = time.time() - shown_at
                ready = waited >= 3 and (not has_plot or has_curves(cur, main_h) or waited > 25)
                if stable >= 3 and ready:
                    img = cur
                    break
            time.sleep(0.5)
        if img is None:
            fail("LTspice не закончил расчёт за %d с (схема не сходится или слишком долгий анализ) — см. %s.log" % (a.timeout, base), 4)
        if img.convert("L").getextrema()[1] < 30:
            fail("снимок чёрный: экран ПК заблокирован или ПК спит — снимок окна сейчас невозможен", 5)

        # Обрезаем невидимую рамку и вырезаем дочерние окна (схема, график) из того же снимка.
        il, it, ir, ib = frame_insets(main_h)
        ml, mt, mr, mb = win32gui.GetWindowRect(main_h)
        full = img.crop((il, it, img.width - ir, img.height - ib))
        full.save(os.path.join(a.out, name + "-ltspice.png"))
        made = [name + "-ltspice.png"]
        kids = []
        win32gui.EnumChildWindows(main_h, lambda c, _: kids.append(c) or True, None)
        with_curves = has_plot and has_curves(img, main_h)
        for c in kids:
            par = win32gui.GetParent(c)
            if not win32gui.IsWindowVisible(c) or not par or win32gui.GetClassName(par) != "MDIClient":
                continue
            ttl = win32gui.GetWindowText(c).lower()
            kind = "plot" if ttl.endswith(".raw") else "schematic" if ttl.endswith(".asc") else None
            if not kind or (kind == "plot" and not has_plot):
                continue
            # Окно схемы / графика — на всё окно программы: рисунок крупнее, чем вырезка из общего снимка.
            win32gui.SendMessage(par, win32con.WM_MDIACTIVATE, c, 0)
            win32gui.SendMessage(par, win32con.WM_MDIMAXIMIZE, c, 0)
            prev, same, one = None, 0, None
            for _ in range(40):
                time.sleep(0.5)
                one = shot(main_h, os.path.join(a.out, "%s-%s.png" % (name, kind)))
                same = same + 1 if prev is not None and ImageChops.difference(one, prev).getbbox() is None else 0
                prev = one
                if same >= 2 and (kind != "plot" or not with_curves or has_curves(one, main_h)):
                    break
            one.crop((il, it, one.width - ir, one.height - ib)).save(os.path.join(a.out, "%s-%s.png" % (name, kind)))
            made.append("%s-%s.png" % (name, kind))
        print("ok: " + ", ".join(made))
        if has_plot and not has_curves(img, main_h):
            print("предупреждение: на графике нет кривых — проверь имена (%s): узлы — V(имя метки), токи — I(R1)" % (", ".join(traces) or "из .plt"))
    finally:
        if p and p.poll() is None:
            for hw in tops(p.pid):
                win32gui.PostMessage(hw, win32con.WM_CLOSE, 0, 0)
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        try:
            os.remove(LOCK)
        except OSError:
            pass


if __name__ == "__main__":
    main()
