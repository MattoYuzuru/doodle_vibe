' Runs the app watchdog without a console window (for Task Scheduler).
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\User\moodle-work\ops\app-watchdog.mjs""", 0, False
