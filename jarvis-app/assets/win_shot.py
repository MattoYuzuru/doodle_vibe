"""
Окна процесса: список и снимок (PrintWindow — окно снимается целиком, даже если его перекрывают другие окна;
нужен рабочий стол: ПК не спит и не на экране блокировки).

    python win_shot.py list <имя.exe>
    python win_shot.py shot <hwnd> <рисунок.png>
"""
import ctypes
import sys

import win32con
import win32gui
import win32process
import win32ui
from PIL import Image

ctypes.windll.user32.SetProcessDPIAware()

# Снимать можно только окна программ лабы. Окна владельца ПК (Telegram, браузер, почта…) в папку чьей-то лабы попасть
# не должны, поэтому и список окон, и снимок работают только для процессов из этого списка.
ALLOWED = {"ltspice.exe"}


def exe_of(hwnd):
    import psutil
    try:
        return psutil.Process(win32process.GetWindowThreadProcessId(hwnd)[1]).name().lower()
    except Exception:
        return ""


def windows_of(exe):
    import psutil
    if exe.lower() not in ALLOWED:
        raise SystemExit("окна процесса %s снимать нельзя (разрешены: %s)" % (exe, ", ".join(sorted(ALLOWED))))
    pids = {p.pid for p in psutil.process_iter(["name"]) if (p.info["name"] or "").lower() == exe.lower()}
    out = []

    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and win32process.GetWindowThreadProcessId(hwnd)[1] in pids:
            out.append((hwnd, win32gui.GetClassName(hwnd), win32gui.GetWindowText(hwnd), win32gui.GetWindowRect(hwnd)))
        return True

    win32gui.EnumWindows(cb, None)
    return out


def shot(hwnd, path, client=False):
    if exe_of(hwnd) not in ALLOWED:
        raise SystemExit("это окно не принадлежит программе лабы — снимать нельзя (разрешены: %s)" % ", ".join(sorted(ALLOWED)))
    left, top, right, bottom = win32gui.GetClientRect(hwnd) if client else win32gui.GetWindowRect(hwnd)
    w, h = right - left, bottom - top
    if w <= 0 or h <= 0:
        raise SystemExit("окно свёрнуто или нулевого размера")
    hdc = win32gui.GetWindowDC(hwnd)
    src = win32ui.CreateDCFromHandle(hdc)
    mem = src.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(src, w, h)
    mem.SelectObject(bmp)
    # 2 = PW_RENDERFULLCONTENT (иначе окна с аппаратной отрисовкой выходят чёрными), 1 = только клиентская часть
    ok = ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), 2 | (1 if client else 0))
    info, bits = bmp.GetInfo(), bmp.GetBitmapBits(True)
    img = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1)
    win32gui.DeleteObject(bmp.GetHandle())
    mem.DeleteDC()
    src.DeleteDC()
    win32gui.ReleaseDC(hwnd, hdc)
    if not ok:
        raise SystemExit("PrintWindow не сработал (экран заблокирован?)")
    img.save(path)
    return img


if __name__ == "__main__":
    if sys.argv[1] == "list":
        for hwnd, cls, title, rect in windows_of(sys.argv[2]):
            print(hwnd, cls, repr(title), rect)
    elif sys.argv[1] == "shot":
        im = shot(int(sys.argv[2]), sys.argv[3])
        print("ok", im.size)
