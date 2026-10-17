24. «Без предмета» у части лаб/тестов: гонка в `init()` — `loadAll()` (CloudStorage) выполнялся параллельно с `syncMoodle()`,
    и если облако отвечало позже, его `set({...data})` затирал свежие `subjects`/`deadlines` Moodle. Теперь профиль и облако
    ждём вместе (`Promise.all`), кладём облако в стор и только потом сливаем Moodle. Pull-to-refresh и так был последовательным.
27. Причина «Без предмета» найдена по diag/945210206.json: в облаке остались ДЕМО-дедлайны из seed (d1–d7, t1, t2,
    source "local", предметы mips/py/os/oksp/ce), а флаг `settings.seedCleared` уже стоял (предметы seed удалились,
    дедлайны вернулись из облака после гонки) — повторная чистка не запускалась. Теперь чистка seed идёт при каждом
    слиянии без флага, плюс убираются предметы `course:*`, которых нет в выдаче и на которые никто не ссылается.
34. «Открыть в Moodle» → приложение Moodle, а не браузер с логином: страница-прокладка `GET /go/moodle?u=<url newlms>`
    (server.mjs, goMoodlePage) делает `location.href = "moodlemobile://https://newlms.misis.ru?redirect=<url>"` (формат
    приложения Moodle ≥ 3.7; docs.moodle.org/dev/Moodle_App_Deep_Linking) и через 1,5 с, если страница не ушла в фон,
    переходит на сайт. Кнопки Telegram принимают только http(s), поэтому и в уведомлениях (notify.buttonsFor), и в карточке
    дедлайна (DeadlineDetails.openMoodle) ссылка идёт через прокладку. Только адреса newlms.misis.ru.
    Возможное продолжение: автовход в браузере через tool_mobile_get_autologin_key (нужен privatetoken из login/token.php;
    ключ живёт 60 с, запрашивать не чаще раза в 6 мин) — по кнопке из мини-приложения (initData), не из ссылки в чате.
