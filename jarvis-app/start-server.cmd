@echo off
rem Сервер мини-приложения Джарвиса (web\dist + /api из Moodle). Запускается Планировщиком при входе в систему.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server.mjs >> server.log 2>&1
