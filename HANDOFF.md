# HANDOFF: что уже сделано и как всё устроено (на 2026-09-30)

Этот файл для нового чата / Claude Code. Прочитай его целиком перед работой. Секретов здесь нет, и их нельзя открывать или выводить (токены лежат в `C:\Users\User\.openclaw\openclaw.json` и `moodle-token.txt`).

## Кто и что
- Студент НИТУ МИСИС, группа БИСТ-24-ПО-2, вариант 04. Moodle: https://newlms.misis.ru, доступен только с ПК пользователя (VPN на роутере).
- Цель: автоматизировать учёбу: видеть дедлайны, делать лабораторную вместе с агентом, собирать отчёт по шаблону курса, показывать пользователю на проверку, прикреплять в Moodle только по его явной команде.

## Что готово
- ЛР3 «Нагрузочное испытание и граница пропускной способности» (id 29397) выполнена, отчёт (23 стр.) прикреплён в Moodle. Файлы: `moodle-work\29397\` (`NOTES.md`, `work\out\` сырые замеры, `work\report\build.py|render.py|topdf.py`).
- Навык `misis-moodle-lab-workflow` сохранён в аккаунте (полный текст ниже).
- OpenClaw 2026.9.6: Gateway на 127.0.0.1:18789 (Scheduled Task). Агент `files` (Claude Sonnet, полный доступ) для лабораторных; агент `main` (Haiku) отвечает в Telegram.
- Telegram-бот @Jarvis_kimmm_bot подключён к OpenClaw, спарен с владельцем (telegram:945210206). Inline-кнопка «Дедлайны» и меню-команда `/deadlines` добавлены; секция «Telegram: дедлайны» в `AGENTS.md` агента `main` (запускает `moodle-student deadlines`, отвечает коротким списком на 7 дней, запрещено submit и --final). Результат нажатия кнопки пока не подтверждён.
- Навык Moodle для агента: `C:\Users\User\.openclaw\skills\moodle-student` (команды deadlines, courses, assignments, details, status, submit, submit --final). Активные курсы: `moodle-work\active-courses.txt`.
- Бэкапы конфигов: `openclaw.json.bak-tg`, `SKILL.md.bak-tg`, `AGENTS.md.bak-tg` (не открывать).

## Открытые пункты
- Проверить, что после перезагрузки ПК стартуют Gateway и Docker Desktop (пользователь перезагрузит сам, потом проверить).
- Старую копию токена `C:\Users\User\moodle_token.txt` пользователь решил НЕ удалять (30.09).
- Стенд ЛР3 остановлен 30.09 (`docker compose -p portal-04 ... --profile monitoring down`, без `-v`); том `portal-04_db-data` сохранён. Вкладок cAdvisor в браузере не было.
- Telegram-бот 30.09 ответил: у провайдера модели истекла авторизация (нужен повторный вход Anthropic для OpenClaw). Причина (по логу Gateway `%LOCALAPPDATA%\Temp\openclaw\openclaw-<дата>.log`): OpenClaw запускает модели через Claude CLI и пользуется его обычным входом (`models status`: «Claude CLI native auth», профилей нет). Этот вход живёт несколько часов и продлевается самим `claude`; 30.09 в 09:16 МСК продлить не удалось («OAuth session expired and could not be refreshed»). Команда `openclaw models auth setup-token` профиль НЕ сохранила. Правильно по докам OpenClaw: `claude setup-token` (токен sk-ant-oat01-…, ~1 год), затем `openclaw models auth login --provider anthropic --method setup-token` (вставить токен в терминал, не в чат), `openclaw gateway restart`, в Telegram `/new`. OpenClaw передаёт сохранённый токен процессу claude. Проверка: `openclaw models auth list` (профиль anthropic), `openclaw models status --check` (0 = ок, 2 = скоро истечёт).
- 30.09 сделано: для агента `main` сохранён профиль `anthropic:default [anthropic/token]` (команде нужен `--agent main`), маршрут «anthropic via claude-cli» = usable, `--check` = 0. Срок токена OpenClaw не видит («static»), поэтому сторож ловит ошибки по логу. Модель бота осталась Haiku; на Opus не переключать.
- 30.09: `/deadlines` в Telegram обслуживает свой плагин OpenClaw `jarvis-moodle` (`moodle-work\ops\jarvis-moodle`, установлен `--link`): отвечает без модели и без подтверждений, только чтение, кэш 5 мин; `/deadlines 30` — на 30 дней, `/deadlines обнови` — без кэша. Старая меню-команда (customCommands, шла через модель) удалена, копия в `ops\customCommands.backup.json`. Пользователь хочет подтверждения только для проверки/отправки отчётов. Плагин также даёт агенту инструмент `moodle_read` (deadlines/assignments/details/status, только чтение, без подтверждений); в `~\.openclaw\workspace\AGENTS.md` (секция «Telegram: дедлайны») агенту `main` велено читать Moodle только им, а не Bash/навыком. Права плагина подтверждены `--accept-capabilities`.
- Сторож входа: `moodle-work\ops\auth-watchdog.mjs` (+ `.vbs` для запуска без окна). Работает без модели, пишет владельцу в Telegram через `openclaw message send`. Задача в Планировщике ставится только с согласия пользователя.
- Дедлайны: ОС ЛР01 id 31885 (05.10 00:00, ответа нет), Этап курсовой №1 id 29399 (08.10 23:59, статус new). Дальше: этап 2 id 29405 (16.10), этап 3 id 29406 (08.12), курсовая id 29410 (15.12).
- Claude в десктоп-приложении на этом ПК может сам запускать `node --dns-result-order=ipv4first C:\Users\User\.openclaw\skills\moodle-student\moodle.mjs <команда>` (токен скрипт читает сам, не печатает).
- Mini App для Джарвиса (дедлайны, план, заметки) делается поэтапно в `moodle-work\jarvis-app\`, состояние и этапы в `jarvis-app\NOTES.md`.
  С 30.09 приложение многопользовательское: вход по логину/паролю Moodle (токены шифруются, `users/`, ключ `users.key` — секрет),
  лабы с агентом только по белому списку `lab-allowlist.txt`, группа для расписания берётся из курсов Moodle.
  Экраны готовы, данные из Moodle подключены через `jarvis-app\server.mjs` (читает `moodle-token.txt` сам). Секреты в `jarvis-app\`:
  `bot-token.txt`, `ngrok-token.txt`, `ngrok.yml` — не открывать и не печатать. Адрес приложения — быстрый туннель
  Cloudflare (задача «Jarvis Tunnel»), меняется при перезапуске; текущий в `jarvis-app\current-url.txt`, бот присылает его сам.
  ngrok не подходит (страница-предупреждение ломает WebView Telegram). Сервер — задача «Jarvis App Server»; сторож — «Jarvis App Watchdog». Напоминания о дедлайнах и оценках уходят в Telegram с сервера раз в час (`notify.mjs`), расписание пар —
  с dnevuch.ru (`schedule.mjs`).
- Если создаётся новый бот: он должен работать поверх той же связки (OpenClaw + moodle-student), а не заменять правила ниже.

## Главные правила (не нарушать)
1. Ничего не отправлять и не прикреплять в Moodle без явной команды пользователя в чате. «Прикрепляй» = только черновик, `--final` только по отдельной команде («отправляй»).
2. Не открывать и не печатать токены. Пользователь вводит их сам. Если токен вставлен в чат, считать его скомпрометированным.
3. Пользователь должен понимать содержимое отчёта (устная защита). Всегда показывать отчёт на проверку перед сдачей.
4. Не удалять данные пользователя; Docker-тома сохранять.
5. Цифры в отчёте только из сохранённых файлов вывода, ничего не выдумывать.

---

# Полный текст навыка misis-moodle-lab-workflow


# MISIS Moodle: deadlines, lab, report, submission

The user is a MISIS student. Moodle is https://newlms.misis.ru, reachable only from their Windows PC (router-level VPN). Claude works through the OpenClaw agent on that PC and through the linked computer. Claude's own cloud container cannot reach Moodle.

## Absolute rules
- Never upload or submit anything to Moodle without the user's explicit command in chat.
  - "прикрепляй" means upload the PDF as a draft only, then show `status`.
  - Sending for grading (`--final`) needs its own explicit command such as "отправляй" or "отправь на проверку". After a draft, show the status first.
  - One approval covers one assignment and one file.
- Never open, print or copy secrets: `C:\Users\User\.openclaw\moodle-token.txt`, `.openclaw\openclaw.json` (gateway token), any old token copies. Do not put them in the chat or in files that leave the PC.
- The user must understand what is in the report, because the lab is defended orally. Always show the finished report for review before any submission. Do not present the work as fully automatic.
- Never delete the user's data. Docker volumes must survive: use `docker compose down` without `-v`. File deletion in the connected folder needs a permission request.

## Prerequisites (check first, silently)
1. The session must be linked to the PC. Check that `mcp__remote-devices__*` tools exist and that `device_bash` works. If not, tell the user to open the chat in the Claude desktop app on that PC and send a message.
2. Connected folder: `C:\Users\User\moodle-work` (mounted as `$HOME/mnt/moodle-work` in `device_bash`). If it is missing, use `device_request_folder_access`.
3. `device_bash` is an isolated Linux sandbox. There is no Docker, no k6, no Windows shell, and Moodle is not reachable from it. It has node, python3 with python-docx and PIL, matplotlib, LibreOffice, pandoc and pdftoppm. Use it to read result files and to build the report.
4. The OpenClaw Gateway (127.0.0.1:18789) must be running on the PC. It runs as a Scheduled Task service. If the dashboard does not open, ask the user to run `openclaw gateway restart`. Never assume autostart after a reboot works.
5. Docker Desktop must be running for lab stands.

## How to talk to the OpenClaw agent
The built-in browser pane (tools `mcp__remote-devices__Claude_Browser__*`, load them with ToolSearch by prefix) is the channel.
- Agent `files` (Claude Sonnet, full access) chat: `http://127.0.0.1:18789/chat/files`. Use `/new?agent=files` for a fresh session. The gateway token was entered once and the built-in profile remembers it. If the page asks for the token, ask the user to type it. Do not read it from disk.
- Send a message: `find` the textbox "Поле ввода сообщения", `form_input` the full text, then `computer key Return`.
- Read the answer: `get_page_text` on that tab, or read the result files the agent wrote in `moodle-work`. Files are more reliable than page text.
- Give the agent complete, self-contained instructions each time, step by step, with an explicit "stop here, report with numbers, upload nothing to Moodle". Tell it exactly what files to create, with what names.
- The agent's Moodle skill is `C:\Users\User\.openclaw\skills\moodle-student`. Commands: deadlines, courses, assignments, details, status, submit (draft), submit --final. It reads the token itself. Active course ids are in `moodle-work\active-courses.txt`. Run node with `--dns-result-order=ipv4first`, because IPv6 does not work through the router VPN.
- Agent `main` (Haiku) is for cheap chores such as reminders. Do not use it for labs.
- Reset any emulated viewport you set on browser tabs (`resize_window preset desktop`) and close tabs you opened when done.

## Deadlines
Ask the agent to run the moodle-student `deadlines` command. Then give the user a short list: course, assignment, due date and time (Moscow), status. Sort by date. Offer to start the nearest one. Do not start it on your own.

## Doing a lab (pattern that worked for LR3)
Work folder: `moodle-work\<assignment id>\` with `tmp\` (metodichka.txt, shablon.txt, scratch), `work\` (cloned stands, `out\` for raw outputs, `report\` for the build) and `NOTES.md` (Claude's running notes: context, variant, rules, results, next steps). Update NOTES.md as you go so a new chat can resume.
1. Get the assignment: `details <id> <course word>` lists the attachments. Download the methodichka and the report template into the assignment folder. Extract text into `tmp\` (python-docx dump).
2. Read the methodichka fully before instructing the agent. Note the variant parameters (`.env`: VARIANT_MARKER, VAR_TARGET, VAR_ACCOUNT, ...), the acceptance criteria and the rules for repeats.
3. Ask at most a few real questions (only the user can answer them). Decide the rest yourself and state the decision.
4. Have the agent set up the stand and verify it. Keep every raw output unedited in `work\out\` with clear names. The agent must record the exact command as the first line of each output that becomes a figure.
5. Measure as the methodichka says. Lessons for load tests:
   - Use strict cooldown between runs: db CPU below 3 percent, six samples in a row.
   - A step whose p95 breaks monotonicity is repeated; the repeat goes into the table with "(повтор)" in the caption.
   - A borderline step stays in the table; the break is the next step with a stable violation.
   - Results beyond the break scatter (p95 sits at the request timeout), so read the break by failures and dropped iterations.
   - Take docker stats and cAdvisor screenshots DURING the break step, not after.
   - Restore any changed setting (for example the DB pool back to 10) and verify from inside the app.
   - In Git Bash on Windows set `MSYS_NO_PATHCONV=1` for docker paths.
6. Never fabricate numbers. Every value in the report comes from a saved output file. If results are odd, report them honestly and explain.

## Building the report
- Start from the course template docx (`Шаблон отчёта. Лабораторная N.docx`). Fill the title page (student Ким А. Е., group БИСТ-24-ПО-2, variant 04), tables and figure placeholders. Remove the grey instruction hints. Keep the table of contents as an automatic field.
- Terminal figures: render images from the real saved output (PIL, DejaVu Sans Mono, dark window). Drop only progress lines and image-pull lines, start k6 output at the `scenarios:` line, and put the real command line on top so that the own target address and account are visible. cAdvisor and other screenshots come from the browser pane: take them at about 760 px width, then move them to the PC folder with SendUserFile and `device_commit_files`.
- Graphs: matplotlib from the tables (for LR3: p95 versus rate with the criterion line).
- Formatting, copied from the user's accepted LR2 report:
  - Letter page; margins left 3 cm, right 1.5 cm, top and bottom 2 cm; page number bottom centre from page 2.
  - Times New Roman 12 pt, line spacing 1.5, first-line indent 1.25 cm, justified.
  - Unnumbered headings (СОДЕРЖАНИЕ, ЗАДАНИЕ И ВАРИАНТ, ПЕРЕЧЕНЬ, ВВЕДЕНИЕ, ЗАКЛЮЧЕНИЕ): centred, capitals, bold. Numbered sections "1. Название": bold, indented 1.25 cm. Each section starts on a new page.
  - Table caption "Таблица N – …" left, above the table. Tables have single black borders, no shading, bold centred header, 12 pt, width 16.5 cm centred. Figure caption "Рисунок N – …" 11 pt centred, below the figure. No frames around screenshots (the user removed them).
  - Code blocks: grey box, Times 12 pt, spacing 1.5.
  - Decimal comma in text and tables.
- Build with python-docx, then convert with LibreOffice through UNO (update all indexes so the table of contents is filled) to docx and PDF. The build scripts of LR3 are in `moodle-work\29397\work\report` (`build.py`, `render.py`, `topdf.py`) and are a good starting point.
- Check: page count and size (file at most 10 MB, formats docx or pdf), the table of contents, the text, numbers against the source files, and the pages visually with a contact sheet.
- Deliver the PDF with SendUserFile for review. The docx stays next to it.

## Submission (only after the user's command)
1. Confirm the file is at most 10 MB and is the approved one.
2. Ask the agent to run `submit <id> "<pdf path>"` (draft), then `status <id>` and show name, size and status.
3. Only with an explicit command to send for grading: `submit <id> --final`, then `status <id>`.
4. Tell the user the result in one or two lines.

## Other known open items (as of 2026-09-30)
Deadlines seen: ОС ЛР01 (05.10), курсовая этап 1 (08.10). Not yet done: Telegram reminder channel and a daily reminder cron on agent `main`, checking that the Gateway and Docker Desktop start after a reboot, deleting the old duplicate token file `C:\Users\User\moodle_token.txt`, stopping the LR3 stand and closing cAdvisor tabs.
