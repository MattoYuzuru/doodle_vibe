' Restarts the OpenClaw Gateway of the lab agent account (doodle-agent) without a console window.
' Run by the Task Scheduler task "Doodle Gateway Restart" (created by 1-prava.ps1) as doodle-agent;
' the app server (owner account) may only start that task, see gateway-watch.mjs.
Set sh = CreateObject("WScript.Shell")
oc = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\openclaw\openclaw.mjs"
sh.Run "node """ & oc & """ gateway restart", 0, True
