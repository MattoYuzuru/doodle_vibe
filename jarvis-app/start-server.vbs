' Runs the Jarvis app server without a console window (for Task Scheduler).
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\User\moodle-work\jarvis-app\start-server.cmd""", 0, False
