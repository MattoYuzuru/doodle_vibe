@echo off
rem Doodle, step 4: first logon of the lab agent account (doodle-agent). Double-click it while logged on as doodle-agent.
rem Installs OpenClaw and Claude Code for this account, sets up the "files" agent, the Gateway task and the agent guard.
rem Deletes nothing; safe to run again. The work is done by agent-setup.mjs next to this file.
setlocal
chcp 65001 >nul
where node >nul 2>nul || (echo Node.js is not found. Install Node.js "for all users" first. & pause & exit /b 1)
node "%~dp0agent-setup.mjs"
echo.
pause
