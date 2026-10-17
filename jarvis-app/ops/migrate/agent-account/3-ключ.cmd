@echo off
rem Doodle, after 2-agent: run as the PC OWNER (your normal account, not as administrator).
rem Copies the Gateway key of the doodle-agent account into your OpenClaw settings (the key is not shown),
rem checks that the app server can reach the agent's Gateway and removes the hand-over file. See owner-key.mjs.
setlocal
chcp 65001 >nul
where node >nul 2>nul || (echo Node.js is not found. & pause & exit /b 1)
node "%~dp0owner-key.mjs"
echo.
pause
