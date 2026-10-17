// Проверка ограничителя обращений к Moodle (moodle-pace.mjs): очередь с паузами, остановка при отказах, счётчик.
// Запуск: node pace-test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "pace-test-"));
Object.assign(process.env, { MOODLE_PACE_DIR: DIR, MOODLE_USER_GAP_MS: "20", MOODLE_BG_GAP_MS: "120", MOODLE_NET_FAILS: "3", MOODLE_NET_SPAN_MS: "400", MOODLE_NET_ALERT_MS: "0",
  MOODLE_NET_STALE_MS: "1500", MOODLE_NET_BURST_GAP_MS: "600", MOODLE_QUEUE_WAIT_MS: "300", MOODLE_QUEUE_WAIT_BG_MS: "3000" });
const pace = await import(pathToFileURL(join(HERE, "..", "..", "moodle-pace.mjs")).href);

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) fails++; console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  | " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = "https://newlms.misis.ru/webservice/rest/server.php", EJ = "https://ej.misis.ru/x";
const alerts = [];
pace.onAlert((t) => { alerts.push(t); });
const go = async (url, { ms = 10, status = 200, error = null, api = true, what = "fn" } = {}) => {
  const turn = await pace.enter(url, what, api);
  const at = Date.now();
  await sleep(ms);
  pace.leave(turn, { status, error });
  return at;
};

{ // Очередь: фон идёт по одному и с паузой, человек — без очереди за фоном.
  const t0 = Date.now(), starts = [];
  const bg = pace.background("обход", () => Promise.all([1, 2, 3, 4].map(() => go(M, { ms: 30 }).then((at) => starts.push(["bg", at - t0])))));
  await sleep(40);
  const user = go(M, { ms: 5 }).then((at) => starts.push(["user", at - t0]));
  await Promise.all([bg, user]);
  const b = starts.filter((s) => s[0] === "bg").map((s) => s[1]).sort((x, y) => x - y), u = starts.find((s) => s[0] === "user")[1];
  const gaps = b.slice(1).map((x, i) => x - b[i]);
  check("очередь: фоновые запросы идут с паузой не меньше заданной, запрос человека не ждёт конца фоновой очереди", gaps.every((g) => g >= 110) && u < b[b.length - 1] && u < 150, `фон ${b.join(", ")} мс; человек ${u} мс`);
  check("очередь: внутри pace.background запрос помечен фоновым, снаружи — нет", pace.background("x", () => pace.isBackground()) === true && pace.isBackground() === false);
}
{ // Отказ веб-сервиса: фон встаёт на паузу, человек проходит, владельцу одно сообщение.
  pace._reset(); alerts.length = 0;
  await go(M, { status: 429 });
  let bgErr = null;
  try { await pace.background("обход", () => go(M)); } catch (e) { bgErr = e; }
  const userOk = await go(M).then(() => true, () => false);
  await sleep(10);
  check("отказ 429: фоновые запросы не уходят в сеть (PausedError), запросы людей проходят, владельцу — одно сообщение", bgErr?.name === "PausedError" && userOk && !!pace.paused("newlms.misis.ru") && pace.paused("newlms.misis.ru").kind === "block" && alerts.length === 1 && /newlms\.misis\.ru/.test(alerts[0]), `${bgErr?.name} ${alerts.length}`);
  check("пауза записана на диск и переживёт перезапуск сервера", (() => { try { return !!JSON.parse(readFileSync(join(DIR, "moodle-load.json"), "utf8")).pause["newlms.misis.ru"]; } catch { return false; } })());
}
{ // 403: на веб-сервисе — признак блокировки; у журнала (истёкшая сессия) и у файлов — нет.
  pace._reset(); alerts.length = 0;
  await go(EJ, { status: 403, api: false });
  const ejFree = !pace.paused("ej.misis.ru");
  await go(M, { status: 403, api: true });
  check("отказ 403: у журнала и файлов паузы не вызывает, на веб-сервисе Moodle — вызывает", ejFree && !!pace.paused("newlms.misis.ru"));
}
{ // Сеть: отдельные сбои паузы не дают; серия без ответов дольше заданного — пауза; первый ответ её снимает.
  pace._reset(); alerts.length = 0;
  const err = new Error("fetch failed");
  for (let i = 0; i < 3; i++) await go(M, { ms: 1, error: err });
  const quick = !pace.paused("newlms.misis.ru");
  await go(M, { ms: 1 }); // ответ — серия обнулилась
  for (let i = 0; i < 2; i++) await go(M, { ms: 1, error: err });
  await sleep(450);
  await go(M, { ms: 1, error: err });
  const tripped = pace.paused("newlms.misis.ru");
  await sleep(10);
  await go(M, { ms: 1 }); // человек получил ответ — пауза по сети снята
  await sleep(10);
  check("сеть: три сбоя подряд за долю секунды паузы не дают; серия без ответов дольше заданного — пауза «net»; первый ответ снимает её и владельцу приходит «снова отвечает»",
    quick && tripped?.kind === "net" && !pace.paused("newlms.misis.ru") && alerts.length === 2 && /снова отвечает/.test(alerts[1]), `${quick} ${tripped?.kind} сообщений ${alerts.length}`);
}
{ // Страница вместо данных три раза подряд — пауза; нормальные данные счёт сбрасывают.
  pace._reset(); alerts.length = 0;
  const H = "newlms.misis.ru";
  pace.dataSeen(H, false, 200); pace.dataSeen(H, false, 200); pace.dataSeen(H, true); pace.dataSeen(H, false, 200); pace.dataSeen(H, false, 200);
  const notYet = !pace.paused(H);
  pace.dataSeen(H, false, 200);
  check("страница вместо данных: два раза и нормальный ответ между ними — без паузы; три раза подряд — пауза", notYet && pace.paused(H)?.kind === "data");
}
{ // Счётчик и отметки.
  pace._reset();
  await pace.background("quick", () => go(M, { what: "mod_quiz_get_quizzes_by_courses" }));
  await go(M, { what: "core_enrol_get_users_courses" });
  await go(M, { what: "core_enrol_get_users_courses", status: 500 });
  const turn = await pace.enter(M, "x", true); pace.cancel(turn); // отменённый до отправки запрос в счёт не идёт
  const s = pace.stats().today;
  check("счётчик: всего, фон и люди, сбои, по функциям и по обходам; отменённый запрос не считается", s.total === 3 && s.bg === 1 && s.user === 2 && s.fail === 1 && s.top.find((x) => x.name === "core_enrol_get_users_courses")?.n === 2 && s.byName.some((x) => x.name === "quick"), JSON.stringify({ total: s.total, bg: s.bg, user: s.user, fail: s.fail }));
  pace.stamp("full:1"); const a = pace.stampAt("full:1"); await sleep(15); pace.stamp("full:1", 60e3);
  check("отметки времени: ставятся, читаются, с минимальным промежутком не обновляются чаще", a > 0 && pace.stampAt("full:1") === a && pace.stampAt("нет") === 0);
}
const H = "newlms.misis.ru", EJH = "ej.misis.ru", minutes = (p) => Math.round((p.until - Date.now()) / 60e3);
{ // Один эпизод отказа — одна пауза: пять отказов подряд на запросы людей уровень не поднимают и сообщений не множат.
  pace._reset(); alerts.length = 0;
  for (let i = 0; i < 5; i++) await go(M, { status: 429 });
  await sleep(10);
  const p = pace.paused(H);
  check("отказ: пять ответов 429 подряд людям — пауза первого уровня (15 мин) и одно сообщение владельцу", p?.kind === "block" && p.level === 0 && minutes(p) === 15 && alerts.length === 1, `уровень ${p?.level}, ${p && minutes(p)} мин, сообщений ${alerts.length}`);
  // Фоновые запросы, уже стоявшие в очереди к моменту отказа, в сеть не уходят.
  pace._reset(); alerts.length = 0;
  const res = await pace.background("обход", () => Promise.allSettled([429, 200, 200, 200, 200, 200].map((status) => go(M, { ms: 30, status }))));
  const rejected = res.filter((r) => r.status === "rejected");
  check("отказ: фоновые запросы из очереди отклоняются (PausedError) и в сеть не идут", res[0].status === "fulfilled" && rejected.length === 5 && rejected.every((r) => r.reason?.name === "PausedError") && pace.stats().today.total === 1, `отклонено ${rejected.length}, ушло в сеть ${pace.stats().today.total}`);
  // Срок паузы вышел, а сайт отказал снова — следующая пауза длиннее, владельцу второе сообщение.
  await sleep(10);
  pace._expire(H);
  await go(M, { status: 429 });
  await sleep(10);
  const p2 = pace.paused(H);
  check("отказ после окончания паузы: второй уровень (30 мин) и второе сообщение", p2?.level === 1 && minutes(p2) === 30 && alerts.length === 2, `уровень ${p2?.level}, ${p2 && minutes(p2)} мин, сообщений ${alerts.length}`);
}
{ // Пауза после отказа сильнее сетевой: серия сбоев её не заменяет, ответ человеку не снимает.
  pace._reset(); alerts.length = 0;
  await go(M, { status: 429 });
  const until = pace.paused(H).until, err = new Error("fetch failed");
  for (let i = 0; i < 2; i++) await go(M, { ms: 1, error: err });
  await sleep(450);
  await go(M, { ms: 1, error: err });
  await go(M);
  await sleep(10);
  const p = pace.paused(H);
  check("пауза после отказа не заменяется паузой по сети и не снимается первым ответом", p?.kind === "block" && p.until === until && alerts.length === 1, `${p?.kind} сообщений ${alerts.length}`);
}
{ // Журнал: пауза после отказа заканчивается (срок вышел, сайт ответил) — «снова отвечает»; новый отказ — новое сообщение.
  pace._reset(); alerts.length = 0;
  await go(EJ, { status: 429, api: false });
  pace._expire(EJH);
  await go(EJ, { api: false });
  await sleep(10);
  const back = alerts.length === 2 && /снова отвечает/.test(alerts[1]);
  await go(EJ, { status: 429, api: false });
  await sleep(10);
  check("журнал: после паузы и нормального ответа — «снова отвечает»; новый отказ в те же сутки — новое сообщение и пауза длиннее", back && alerts.length === 3 && pace.paused(EJH)?.level === 1, `сообщений ${alerts.length}, уровень ${pace.paused(EJH)?.level}`);
}
{ // Давняя серия сетевых сбоев не продолжается одним новым сбоем.
  pace._reset(); alerts.length = 0;
  const err = new Error("fetch failed");
  for (let i = 0; i < 3; i++) await go(M, { ms: 1, error: err });
  await sleep(700);
  await go(M, { ms: 1, error: err });
  check("сеть: короткий обрыв и один сбой спустя время — паузы нет (сбои не идут подряд сейчас)", !pace.paused(H));
  // А вот сбои, идущие пачками без единого ответа (ночью обход раз в 15 минут), копятся и паузу дают.
  pace._reset(); alerts.length = 0;
  for (let k = 0; k < 2; k++) { for (let i = 0; i < 2; i++) await go(M, { ms: 1, error: err }); await sleep(700); }
  const early = !!pace.paused(H);
  for (let i = 0; i < 3; i++) await go(M, { ms: 1, error: err });
  check("сеть: пачки сбоев с перерывами без единого ответа копятся — пауза «net» ставится", !early && pace.paused(H)?.kind === "net", `рано ${early}, ${pace.paused(H)?.kind}`);
}
{ // История отказа не теряется, когда поверх неё записалась пауза по сети: «снова отвечает» приходит, следующий отказ — длиннее.
  pace._reset(); alerts.length = 0;
  const err = new Error("fetch failed");
  await go(M, { status: 429 }); pace._expire(H);
  await go(M, { status: 429 }); pace._expire(H);              // второй уровень, 30 мин
  for (let i = 0; i < 2; i++) await go(M, { ms: 1, error: err });
  await sleep(450);
  await go(M, { ms: 1, error: err });                          // срок отказа вышел, а сеть рвётся — пауза по сети
  const net = pace.paused(H)?.kind;
  await go(M);                                                 // сайт ответил
  await sleep(10);
  const back = alerts.filter((a) => /снова отвечает/.test(a)).length;
  await go(M, { status: 429 });
  await sleep(10);
  const p = pace.paused(H);
  check("отказ → сеть → ответ → отказ: владельцу «снова отвечает», следующий отказ — третьего уровня (60 мин)", net === "net" && back === 1 && p?.kind === "block" && p.level === 2 && minutes(p) === 60 && alerts.length === 4, `${net}, «снова» ${back}, уровень ${p?.level}, сообщений ${alerts.length}`);
}
{ // Веб-сервис Moodle: код 200 ещё не значит «заработал» (страница-заглушка) — паузу после отказа снимают только настоящие данные.
  pace._reset(); alerts.length = 0;
  await go(M, { status: 403 }); pace._expire(H);
  await go(M);
  await sleep(10);
  const early = alerts.length;
  pace.dataSeen(H, true);
  await sleep(10);
  check("Moodle: после отказа «снова отвечает» приходит по настоящим данным, а не по коду 200", early === 1 && alerts.length === 2 && /снова отвечает/.test(alerts[1]), `до данных ${early}, после ${alerts.length}`);
}
{ // Отметка времени с записью на диск сразу — переживает убийство процесса.
  pace._reset();
  pace.stamp("full:9", 0, true);
  const onDisk = (() => { try { return JSON.parse(readFileSync(join(DIR, "moodle-load.json"), "utf8")).marks["full:9"]; } catch { return 0; } })();
  check("отметка чтения записывается на диск сразу", onDisk > 0 && onDisk === pace.stampAt("full:9"));
}
{ // Повторы: несостоявшееся соединение повторяется по обычному счёту; запрос, который мог дойти до сервера, — не больше maxSent.
  const { retry } = await import(pathToFileURL(join(HERE, "..", "..", "users.mjs")).href);
  const failing = (make) => { let n = 0; const fn = async () => { n++; throw make(); }; return { fn, count: () => n }; };
  const noConnect = failing(() => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }));
  await retry(noConnect.fn, { attempts: 4, pause: 1, maxSent: 2 }).catch(() => {});
  const timedOut = failing(() => Object.assign(new Error("истёк срок"), { name: "TimeoutError" }));
  const e = await retry(timedOut.fn, { attempts: 4, pause: 1, maxSent: 2 }).then(() => null, (x) => x);
  check("повторы: соединение не установилось — все 4 попытки; запрос мог дойти (таймаут) — только 2", noConnect.count() === 4 && timedOut.count() === 2 && /Moodle не отвечает/.test(e?.message || ""), `${noConnect.count()} и ${timedOut.count()}`);
}
{ // Запрос человека не ждёт таймер, поставленный под секундную паузу фона.
  pace._reset();
  const t0 = Date.now(), at = {};
  const bg = pace.background("обход", () => Promise.all([go(M, { ms: 5 }), go(M, { ms: 5 })]));
  await sleep(8);
  const u1 = go(M, { ms: 5 }).then((x) => { at.u1 = x - t0; }), u2 = go(M, { ms: 5 }).then((x) => { at.u2 = x - t0; });
  await Promise.all([bg, u1, u2]);
  check("очередь: два запроса человека подряд во время фонового обхода идут с паузой людей, а не фона", at.u1 < 70 && at.u2 < 100, `первый через ${at.u1} мс, второй через ${at.u2} мс`);
}
{ // Все места заняты медленными запросами: ждущий в очереди дольше предела получает отказ и в сеть не идёт.
  pace._reset();
  const long = [1, 2, 3, 4].map(() => go(M, { ms: 500 }));
  await sleep(80);
  const e = await go(M).then(() => null, (x) => x);
  await Promise.all(long);
  check("очередь: запрос, не дождавшийся места, получает «Moodle не отвечает» и в счёт не идёт", e?.name === "QueueError" && /Moodle не отвечает/.test(e.message) && pace.stats().today.total === 4, `${e?.name} всего ${pace.stats().today.total}`);
}
rmSync(DIR, { recursive: true, force: true });
console.log(fails ? `ИТОГ: провалено ${fails}` : "ИТОГ: всё прошло");
process.exit(fails ? 1 : 0);
