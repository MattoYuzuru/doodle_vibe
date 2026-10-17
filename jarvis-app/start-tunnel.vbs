' Runs the Cloudflare tunnel without a console window (for Task Scheduler).
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\User\moodle-work\jarvis-app\start-tunnel.cmd""", 0, False
