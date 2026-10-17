// Сервер мини-приложения Джарвиса: отдаёт собранное приложение (web/dist) и данные из Moodle для каждого пользователя.
// Пользователь опознаётся по подписанному Telegram initData; его токен Moodle хранится зашифрованным (users.mjs).
// Токен бота (для проверки подписи) читается из bot-token.txt рядом.
// Запуск: node server.mjs (127.0.0.1:8787)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as attendance from "./attendance.mjs";
import * as calendar from "./calendar.mjs";
import { tunnelState, watchCalendarTunnel } from "./cal-tunnel.mjs";
import * as campus from "./campus.mjs";
import * as ej from "./ej.mjs";
import * as lab from "./lab.mjs";
import * as lessons from "./lessons.mjs";
import * as moodle from "./moodle.mjs";
import * as news from "./news.mjs";
import * as notify from "./notify.mjs";
import { groupList, schedule } from "./schedule.mjs";
import { watchGateway } from "./gateway-watch.mjs";
import { watchTunnelUrl } from "./tunnel-url.mjs";
import * as usage from "./usage.mjs";
import * as rate from "./ratelimit.mjs";
import { watchBackup } from "./backup.mjs";
import * as users from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(DIR, "web", "dist");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const BOT_TOKEN = await readFile(join(DIR, "bot-token.txt"), "utf8").then((t) => t.replace(/^﻿/, "").trim()).catch(() => "");

// Раз в час: для каждого вошедшего пользователя свежие данные из Moodle → напоминания и новые оценки в Telegram.
// Каждые 15 минут: внезапно появившийся тест должен быть замечен быстро (см. notify.check — «новые работы»).
const NOTIFY_EVERY = Number(process.env.NOTIFY_EVERY_MS) || 15 * 60 * 1000; // переменная — только для тестов
// Обход всех пользователей может занять больше интервала (много людей, медленный Moodle) — следующий запуск тогда
// пропускаем, а не пускаем второй обход поверх первого.
let notifyBusy = false, quickBusy = false;
async function notifyTick() {
  if (notifyBusy) return;
  notifyBusy = true;
  try {
    const all = await users.allLoggedIn(), fresh = new Map(); // tgId → дедлайны этого обхода
    for (const u of all) {
      try {
        moodle.setOverrides(u.token, u.overrides);
        const d = await moodle.deadlines(u.token, true);
        fresh.set(u.tgId, d);
        const n = await notify.check(u.tgId, d.items, d.courses);
        if (n) console.log(`notify ${u.tgId}: отправлено ${n}`);
        const asked = await notify.askCourses(u.tgId, d.pendingCourses);
        if (asked) console.log(`notify ${u.tgId}: вопросов о курсах ${asked}`);
      } catch (e) { console.log(`notify ${u.tgId}: ` + (e.message || e)); }
    }
    // Вторым проходом — то, что не должно задерживать уведомления о работах: база замечаний, изменения расписания,
    // объявления и материалы курсов, журнал (у каждой проверки свой интервал — она сама решает, пора ли).
    for (const u of all) {
      if (fresh.has(u.tgId)) await watchCourses(u, fresh.get(u.tgId));
      await watchJournal(u.tgId);
      if (fresh.has(u.tgId)) await collectLessons(u.tgId, fresh.get(u.tgId));
      // Оценённая работа без замечаний к оформлению — образец оформления курса для следующих отчётов (lab.noteGrades).
      if (fresh.has(u.tgId)) await lab.noteGrades(u.tgId, fresh.get(u.tgId)).catch((e) => console.log(`styles ${u.tgId}: ${e.message || e}`));
      await watchSchedule(u.tgId);
    }
    await watchUsage();
  } finally { notifyBusy = false; }
}
setTimeout(notifyTick, 30 * 1000);
/** Профиль для приложения: к профилю пользователя — сколько процентов месячного лимита отчётов израсходовано (если лимит есть). */
async function me(tgId) {
  const p = await users.profile(tgId);
  const o = await usage.own(tgId).catch(() => null);
  return { ...p, quota: o && o.limit != null ? { percent: o.percent, level: o.level } : null };
}
/** Число токенов для сообщений: «4,2 млн», «350 тыс.», «900». */
const fmtTok = (x) => (x >= 999500 ? `${(x / 1e6).toFixed(1).replace(".", ",").replace(/,0$/, "")} млн` : x >= 1000 ? `${Math.round(x / 1000)} тыс.` : String(Math.round(x)));
/** Лимит в сообщениях — без округления, тем же числом, что на экране владельца: «5 млн», «1,25 млн», «420 тыс.». */
const fmtLim = (x) => (x >= 1e6 ? `${String(x / 1e6).replace(".", ",")} млн` : x >= 1000 ? `${String(x / 1000).replace(".", ",")} тыс.` : String(x));
/** Месячный лимит отчётов: владельцу — сообщение, когда пользователь израсходовал 80 % и 100 % (по разу на порог и месяц). */
async function watchUsage() {
  try {
    const list = await usage.alerts({ mark: false }); // отметку «сообщено» ставим после отправки
    if (!list.length) return;
    const all = await users.listUsers(), app = await appUrl();
    let done = 0;
    for (const a of list) {
      const u = all.find((x) => x.tgId === a.tgId);
      const who = [u?.fullName || u?.tgName, u?.tgUsername ? "@" + u.tgUsername : null].filter(Boolean).join(" · ") || `id ${a.tgId}`;
      const spent = `Израсходовано ${fmtTok(a.used)} из ${fmtLim(a.limit)} токенов за месяц (${a.percent} %).`;
      const sent = await notify.send(users.OWNER_ID, a.level < 100 ? `⚠️ Лимит отчётов на исходе: ${who}\n${spent}`
        : a.closed ? `⛔ Лимит отчётов исчерпан: ${who}\n${spent} Работа с агентом этому пользователю закрыта до 1-го числа (готовый отчёт он может прикрепить и отправить) — или увеличьте лимит.`
          : `⛔ Лимит отчётов исчерпан: ${who}\n${spent} Новый отчёт, исправление и проверка отчёта этому пользователю закрыты до 1-го числа (начатую работу он может дописать, пока расход не дойдёт до 125 %) — или увеличьте лимит.`,
        undefined, app ? [[{ text: "Расход и лимиты", web_app: { url: `${app}/?open=usage` } }]] : undefined);
      // Не ушло (Telegram недоступен) — отметку не ставим: сообщение повторится на следующем обходе.
      if (sent === true) { await usage.markAlerted([a]); done++; }
    }
    if (done) console.log(`usage: предупреждений владельцу ${done}`);
  } catch (e) { console.log(`usage-watch: ${e.message || e}`); }
}
/** Расписание группы пользователя: изменения (перенос, отмена, новая пара, аудитория) — сообщением (notify.checkSchedule). */
async function watchSchedule(tgId) {
  try {
    const p = await users.profile(tgId);
    if (!p.group) return;
    const s = await schedule(p.group);
    const n = await notify.checkSchedule(tgId, p.group, p.subgroup || "1", s.lessons);
    if (n) console.log(`notify ${tgId}: изменений расписания ${n}`);
  } catch (e) { console.log(`schedule-watch ${tgId}: ${e.message || e}`); }
}
/** Объявления преподавателей и новые материалы активных курсов пользователя (news.mjs) — сообщениями бота. */
async function watchCourses(u, d) {
  try {
    const prefs = await users.notifyPrefs(u.tgId);
    // О заданиях и тестах со сроком уже пишет проверка работ — в «новых материалах» их не повторяем.
    const cmids = new Set(d.items.map((x) => { try { return Number(new URL(x.url).searchParams.get("id")); } catch { return 0; } }).filter(Boolean));
    const n = await news.checkNews(u.tgId, u.token, d.courses, { mute: !prefs.news });
    const m = await news.checkMaterials(u.tgId, u.token, d.courses, { mute: !prefs.news, skipCmids: cmids });
    if (n || m) console.log(`news ${u.tgId}: объявлений ${n}, сообщений о материалах ${m}`);
  } catch (e) { console.log(`news ${u.tgId}: ${e.message || e}`); }
}
/** Пропуски, посещаемость и оценки ниже порога из электронного журнала (attendance.mjs) — сообщением бота. */
async function watchJournal(tgId) {
  try {
    const prefs = await users.notifyPrefs(tgId);
    const n = await attendance.checkJournal(tgId, { mute: !prefs.journal, app: await appUrl() });
    if (n) console.log(`journal-watch ${tgId}: строк о журнале ${n}`);
  } catch (e) { console.log(`journal-watch ${tgId}: ${e.message || e}`); }
}
/** Замечания преподавателя к работам этого пользователя → общая база типичных замечаний (только с его согласия, lessons.mjs). */
async function collectLessons(tgId, d) {
  try {
    const c = await users.remarksConsent(tgId);
    if (!c.share) return;
    const added = await lessons.harvest(tgId, d.items, d.courses, { fullName: c.fullName, agentMade: (id) => lab.agentMade(tgId, id) });
    if (added) console.log(`lessons ${tgId}: +${added}`);
  } catch (e) { console.log(`lessons ${tgId}: ${e.message || e}`); }
}
setInterval(notifyTick, NOTIFY_EVERY);
// Быстрый опрос тестов каждые 2 минуты (один вызов Moodle на пользователя): внезапный короткий тест → уведомление сразу.
const QUICK_EVERY = 2 * 60 * 1000;
async function quickTick() {
  if (quickBusy) return;
  quickBusy = true;
  try {
    for (const u of await users.allLoggedIn()) {
      try { moodle.setOverrides(u.token, u.overrides); const q = await moodle.quizzesQuick(u.token); await notify.checkNew(u.tgId, q.items, q.courses); }
      catch (e) { console.error(`quick ${u.tgId}: ${e.message}`); }
    }
  } finally { quickBusy = false; }
}
// Вход: не больше 5 отклонённых Moodle попыток за 5 минут на пользователя Telegram — сервер открыт всем, а перебор
// паролей через него кончился бы блокировкой учётной записи или адреса этого ПК в Moodle. Сетевые сбои не считаются.
const loginFails = new Map(); // tgId → [время неудачных попыток]
const recentFails = (tgId) => (loginFails.get(tgId) || []).filter((t) => Date.now() - t < 5 * 60e3);
setTimeout(quickTick, 45 * 1000);
setInterval(quickTick, QUICK_EVERY);
watchTunnelUrl();
// Постоянный адрес для подписки на календарь (второй туннель, только путь /cal/) — см. cal-tunnel.mjs.
watchCalendarTunnel(PORT);
// Ежедневная копия данных (пользователи, задания, лимиты…) — backup.mjs; о сбое копии владелец узнаёт от бота (не чаще раза в сутки).
let backupAlertAt = 0;
watchBackup({ onError: (e) => { if (Date.now() - backupAlertAt < 86400e3) return; backupAlertAt = Date.now(); void notify.send(users.OWNER_ID, `⚠️ Ежедневная копия данных Doodle не получилась: ${String(e.message || e).slice(0, 200)}`); } });
// Зависший Gateway OpenClaw (порт открыт, ответа нет) перезапускается сам; владельцу — сообщение от бота.
watchGateway({ notify: (text) => notify.send(users.OWNER_ID, text) });
// После пробуждения ПК быстрый туннель обычно уже мёртв (Cloudflare удаляет его за время долгого сна), а сторож по
// расписанию приходит раз в 30 минут: 1 окт 2026 приложение после пробуждения было недоступно 12 минут, пока туннель
// не перезапустили вручную. Поэтому после сна сторож запускается сразу: через минуту и ещё раз через пять.
lab.onWake(() => {
  for (const ms of [60e3, 5 * 60e3]) setTimeout(() => {
    spawn(process.execPath, [join(DIR, "..", "ops", "app-watchdog.mjs")], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  }, ms);
});

const INIT_MAX_AGE_S = Number(process.env.INIT_MAX_AGE_S) || 2 * 86400;
// Проверка initData по алгоритму Telegram: HMAC-SHA256 с ключом HMAC("WebAppData", BOT_TOKEN). Возвращает Telegram id,
// null (подписи нет или она неверная) или "expired" (подпись верная, но старая).
function telegramId(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length || !timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  // Подпись выдаётся при открытии мини-приложения. Два дня (было семь): перехваченной подписью нельзя пользоваться долго,
  // а приложение, не закрывавшееся дольше, просит открыть его заново.
  if (Date.now() / 1000 - Number(params.get("auth_date")) > INIT_MAX_AGE_S) return "expired";
  try { const id = Number(JSON.parse(params.get("user")).id); return Number.isFinite(id) ? id : null; } catch { return null; }
}

/*
 * Вход без подписи Telegram («это владелец, он на этом же ПК») закрыт, пока явно не включён: переменной LOCAL_OWNER=1
 * (так запускаются стенды) или пустым файлом local-owner.flag рядом с сервером. Раньше владельцем считался любой запрос
 * без подписи и без заголовков Cloudflare/ngrok: сервер слушает 127.0.0.1, туннели работают на этом же ПК, поэтому адрес
 * соединения всегда местный — и с другим туннелем или обратным прокси владельцем стал бы кто угодно из интернета.
 * Даже во включённом режиме: только соединение с этого ПК, обращение по местному адресу и ни одного заголовка пересылки.
 */
const LOCAL_OWNER = process.env.LOCAL_OWNER === "1" || existsSync(join(DIR, "local-owner.flag"));
const FORWARDED = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via"];
const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(ip || "");
/** Кто спрашивает: Telegram id по подписи. Подпись устарела — req.authExpired (приложение попросит открыть его заново). */
function whoIs(req) {
  const initData = req.headers["x-telegram-init-data"];
  const id = telegramId(initData);
  if (id === "expired") { req.authExpired = true; return null; }
  if (id) return id;
  if (initData) return null; // подпись есть, но неверная (подделка или чужой бот) — не подменяем владельцем даже с этого ПК
  if (!LOCAL_OWNER) return null;
  if (FORWARDED.some((h) => req.headers[h]) || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || "")) return null;
  return isLoopback(req.socket.remoteAddress) ? users.OWNER_ID : null;
}

/*
 * Пределы частоты запросов (ratelimit.mjs). Значения с запасом для обычной работы: приложение опрашивает сервер раз
 * в 3–15 секунд (до ~50 запросов в минуту на человека), а за одним адресом может сидеть целая аудитория на вузовском
 * Wi-Fi. Переменные окружения — для стенда.
 */
const RL = {
  ip: Number(process.env.RATE_IP_PER_MIN) || 1500,            // все запросы с одного адреса, в минуту
  user: Number(process.env.RATE_USER_PER_MIN) || 300,         // запросы API одного пользователя Telegram, в минуту
  refresh: Number(process.env.RATE_REFRESH_PER_MIN) || 10,    // принудительное обновление из Moodle и журнала, в минуту
  upload: Number(process.env.RATE_UPLOAD_PER_10MIN) || 15,    // загрузки файлов одного пользователя, за 10 минут
  miss: Number(process.env.RATE_MISS_PER_10MIN) || 30,        // промахи с одного адреса: неверная подпись, чужой секрет ссылки
  diag: 6,                                                    // записи диагностики одного пользователя, за 10 минут
};

// Тело запроса — JSON не больше 1 МБ: сервер открыт всем, кто вошёл в бота, без предела один клиент мог бы занять всю память.
// Лишнее дочитываем и выбрасываем, а запрос отклоняем (413) — обработчик дальше не идёт и ничего не перезаписывает пустым телом.
const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
  let b = "", tooBig = false;
  req.on("data", (d) => { if (tooBig) return; b += d; if (b.length > limit) { tooBig = true; b = ""; } });
  req.on("end", () => {
    if (tooBig) return reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 }));
    try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
  });
  req.on("error", (e) => reject(e));
});

// Тело запроса как есть (файл, который студент прикрепляет из приложения), не больше limit. Лишнее дочитывается и
// выбрасывается, запрос отклоняется с 413.
const MAX_UPLOAD = 20 << 20;
const readRaw = (req, limit = MAX_UPLOAD) => new Promise((resolve, reject) => {
  const parts = []; let size = 0, tooBig = false;
  req.on("data", (d) => { if (tooBig) return; size += d.length; if (size > limit) { tooBig = true; parts.length = 0; } else parts.push(d); });
  req.on("end", () => (tooBig ? reject(Object.assign(new Error(`Файл слишком большой (больше ${limit >> 20} МБ)`), { status: 413 })) : resolve(Buffer.concat(parts))));
  req.on("error", (e) => reject(e));
});
// Имя прикрепляемого файла из заголовка: без путей и служебных символов, всегда .pdf.
function uploadName(header) {
  let n = "";
  try { n = decodeURIComponent(String(header || "")); } catch { n = ""; }
  n = n.split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, "_").trim().slice(0, 120);
  if (!n || n === ".pdf") n = "Отчёт.pdf";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

// Страница-прокладка «в Moodle»: кнопки Telegram принимают только http(s), а приложение Moodle открывается по
// moodlemobile://<wwwroot>?redirect=<url> (формат с версии 3.7). Пробуем приложение; если через 1,5 с всё ещё здесь (приложения нет) — идём на сайт.
const esc = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// Строка для встроенного <script>: JSON.stringify не экранирует «<», а «</script>» внутри адреса оборвал бы скрипт (XSS).
const js = (t) => JSON.stringify(t).replace(/</g, "\\u003c").replace(new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16));
const goMoodlePage = (u) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Открываю Moodle…</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}
a{display:block;margin:10px auto;max-width:320px;padding:14px 18px;border-radius:14px;background:#2f7bf6;color:#fff;text-decoration:none;font-weight:600}a.web{background:#1c1c1e}</style></head>
<body><div><p>Открываю Moodle…</p><a href="moodlemobile://https://newlms.misis.ru?redirect=${esc(u)}">Открыть в приложении Moodle</a><a class="web" href="${esc(u)}">Открыть на сайте</a></div>
<script>(function(){var app="moodlemobile://https://newlms.misis.ru?redirect="+${js(u)},web=${js(u)},left=false;
function hide(){if(document.visibilityState==="hidden")left=true}document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",function(){left=true});
setTimeout(function(){if(!left&&document.visibilityState==="visible")location.replace(web)},1500);location.href=app;})();</script></body></html>`;

/** Текущий адрес приложения (быстрый туннель; пишет tunnel-url.mjs). */
const appUrl = () => readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim().replace(/[/]+$/, ""), () => "");
// Страница-переходник для подписки на календарь: открывается в браузере телефона и сразу ведёт в календарь (iPhone —
// по ссылке webcal://, Google — на страницу «Добавить календарь по URL»); ниже — та же ссылка кнопкой и текстом.
const goCalendarPage = (to, l) => {
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(l.webcal)}`;
  const target = to === "google" ? google : l.webcal;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Календарь Doodle</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}
div{max-width:340px;padding:0 20px}a{display:block;margin:12px auto;padding:14px 18px;border-radius:14px;background:#2f7bf6;color:#fff;text-decoration:none;font-weight:600}
p.s{color:#9a9aa0;font-size:13px;word-break:break-all}</style></head>
<body><div><p>${to === "google" ? "Открываю Google Календарь…" : "Открываю календарь…"}</p><a href="${esc(target)}">${to === "google" ? "Добавить в Google Календарь" : "Подписаться на календарь"}</a>
<p class="s">${to === "google" ? "Если страница Google не открылась: на компьютере откройте calendar.google.com → «Другие календари» → «Добавить по URL» и вставьте ссылку:" : "Если календарь не открылся, добавьте подписку вручную по ссылке:"}<br>${esc(l.url)}</p></div>
<script>setTimeout(function(){location.href=${js(target)}},300);</script></body></html>`;
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff" };
// Сжатые копии файлов сборки (имена с хешем → можно кэшировать надолго); index.html и API — без кэша.
const gzCache = new Map();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const send = (code, body, type = "application/json; charset=utf-8", extra = {}) => {
    const headers = { "content-type": type, "cache-control": "no-store", ...extra };
    let out = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (acceptsGzip && code === 200 && !extra["content-encoding"] && Buffer.byteLength(out) > 1024 && /json|text|javascript|svg/.test(type)) {
      out = gzipSync(out); headers["content-encoding"] = "gzip";
    }
    res.writeHead(code, headers);
    res.end(out);
    // Журнал только для API (статика не нужна): время, кто, метод, путь, код — чтобы с телефона было понятно, что дошло до сервера.
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") console.log(`${new Date().toISOString()} ${req.tgId ?? "-"} ${req.method} ${url.pathname} ${code}${code >= 400 ? " " + String(typeof body === "object" && body?.error || "").slice(0, 80) : ""}`);
  };
  // Ограничение частоты (ratelimit.mjs). ip — адрес клиента по заголовку туннеля; «local» — запрос с этого же ПК.
  const ip = rate.clientIp(req);
  const tooMany = (r, what) => {
    if (r.first) console.log(`${new Date().toISOString()} rate: ${what} — предел превышен, отказы следующие ${r.wait} с`); // одна строка на окно, а не на каждый отказ
    res.writeHead(429, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(r.wait) });
    res.end(JSON.stringify({ error: "Слишком много запросов — подождите немного" }));
  };
  // Промах — неверная подпись Telegram или чужой секрет в ссылке (календарь, отчёт). Много промахов с одного адреса —
  // это перебор: дальше такие запросы с этого адреса отклоняются сразу, без чтения диска.
  const missKey = `miss:${ip}`;
  const missBlocked = () => ip !== "local" && rate.count(missKey) >= RL.miss;
  const miss = () => { if (ip !== "local") rate.hit(missKey, RL.miss, 600e3); };
  try {
    if (ip !== "local") { const r = rate.hit(`ip:${ip}`, RL.ip, 60e3); if (r) return tooMany(r, `адрес ${ip}`); }
    if (url.pathname === "/go/moodle") {
      const u = url.searchParams.get("u") || "";
      if (!u.startsWith("https://newlms.misis.ru/")) return send(400, "Неверная ссылка", "text/plain; charset=utf-8");
      return send(200, goMoodlePage(u), "text/html; charset=utf-8");
    }
    // Календарь в телефоне (calendar.mjs): лента подписки по секрету из ссылки — подписи Telegram у календарных программ нет.
    const cal = url.pathname.match(/^\/cal\/([\w-]{20,40})\.ics$/);
    if (cal) {
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const who = await users.byCalToken(cal[1]);
      if (!who) { miss(); return send(404, "not found", "text/plain"); }
      const body = await calendar.feed(who);
      console.log(`${new Date().toISOString()} ${who} GET /cal/….ics 200 (${Buffer.byteLength(body)} б; ${String(req.headers["user-agent"] || "-").slice(0, 50)})`);
      return send(200, body, "text/calendar; charset=utf-8", url.searchParams.has("download") ? { "content-disposition": 'attachment; filename="doodle.ics"' } : {});
    }
    if (url.pathname.startsWith("/cal/")) return send(404, "not found", "text/plain");
    // Страница-переходник «подписаться на календарь»: ссылку webcal:// Telegram сам не открывает, а обычную страницу — да.
    if (url.pathname === "/go/calendar") {
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const who = await users.byCalToken(url.searchParams.get("t") || "");
      if (!who) { miss(); return send(404, "Ссылка устарела — откройте «Календарь в телефоне» в Doodle ещё раз", "text/plain; charset=utf-8"); }
      const l = await calendar.links(who, await appUrl());
      return send(200, goCalendarPage(url.searchParams.get("to") === "google" ? "google" : "apple", l), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/health") return send(200, { ok: true, botToken: !!BOT_TOKEN, moodle: users.moodleRoute() });
      // «Открыть PDF» уходит в системный браузер (openLink), где нет подписи Telegram, — поэтому отчёт отдаётся до общей
      // проверки, по секрету работы ?t= (случайный, его знает только тот, кому сервер отдал состояние этой лабы).
      const rep = url.pathname.match(/^\/api\/lab\/(\d+)\/report$/);
      if (rep) {
        if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
        const f = await lab.reportFile(rep[1], url.searchParams.get("t"));
        if (f) console.log(`${new Date().toISOString()} - GET ${url.pathname} 200 pdf`); // 403 запишет send()
        if (!f) { miss(); return send(403, { error: "Ссылка на отчёт устарела — откройте отчёт из приложения ещё раз" }); }
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(f.name)}`, "cache-control": "no-store" });
        return res.end(await readFile(f.path));
      }
      if (missBlocked()) return tooMany({ wait: 600, first: false }, `адрес ${ip}`);
      const tgId = whoIs(req); req.tgId = tgId;
      if (!tgId) {
        if (!req.authExpired) miss();
        return send(403, { error: req.authExpired ? "Вход устарел — закройте приложение и откройте его из Telegram заново" : BOT_TOKEN ? "forbidden" : "На сервере нет bot-token.txt, доступ из Telegram закрыт" });
      }
      const path = url.pathname.slice(5);
      { const r = rate.hit(`u:${tgId}`, RL.user, 60e3); if (r) return tooMany(r, `пользователь ${tgId}`); }
      // Принудительное обновление (?refresh) заставляет сервер идти в Moodle и журнал с домашнего адреса: чаще предела
      // запрос выполняется как обычный, из уже загруженного.
      if (url.searchParams.has("refresh") && rate.hit(`rf:${tgId}`, RL.refresh, 60e3)) url.searchParams.delete("refresh");
      // Загрузки файлов (до 20 МБ каждая): свой PDF в Moodle, файл в чат лабы, отчёт на проверку.
      if (req.method === "POST" && /^(upload\/\d+|lab\/\d+\/upload|check\/\d+)$/.test(path)) {
        const r = rate.hit(`up:${tgId}`, RL.upload, 600e3);
        if (r) { req.resume(); return tooMany(r, `загрузки пользователя ${tgId}`); }
      }

      // Профиль и вход.
      if (path === "me") {
        try { const u = JSON.parse(new URLSearchParams(req.headers["x-telegram-init-data"] || "").get("user") || "null"); if (u && Number(u.id) === tgId) await users.touchTelegram(tgId, u); } catch { /* без имени */ }
        return send(200, await me(tgId));
      }
      // Запрос доступа к отчётам: пользователь нажал кнопку в карточке работы → владельцу сообщение с кнопкой «Открыть запросы».
      if (path === "lab/request" && req.method === "POST") {
        const p = await users.profile(tgId);
        if (p.labsAllowed) return send(200, { ok: true, allowed: true });
        // Повторное нажатие (или повтор запроса в обход приложения) владельцу второе сообщение не шлёт — не чаще раза в сутки.
        if (p.labRequest && Date.now() - Number(p.labRequest) < 86400e3) return send(200, { ok: true, allowed: false });
        await users.requestLabAccess(tgId);
        const me = (await users.listUsers()).find((x) => x.tgId === tgId);
        const who = [me?.tgName, me?.tgUsername ? "@" + me.tgUsername : null, me?.fullName, me?.group].filter(Boolean).join(" · ");
        const app = await readFile(join(DIR, "current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
        void notify.send(users.OWNER_ID, `👤 Просит доступ к отчётам с агентом:
${who || "без имени"} · id ${tgId}
Откройте Doodle → Профиль → «Доступ к отчётам» и включите переключатель.`,
          undefined, app ? [[{ text: "Открыть запросы", web_app: { url: `${app}/?open=access` } }]] : undefined);
        return send(200, { ok: true, allowed: false });
      }
      // Экран владельца «Запросы на установку»: что агент окружения не стал ставить без подтверждения (lab.mjs envRequests/decideEnv).
      if (path === "env-requests") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          const b = await readBody(req);
          await lab.decideEnv(Number(b.tgId), String(b.id || ""), Array.isArray(b.approve) ? b.approve.map(String) : []);
        }
        return send(200, { requests: await lab.envRequests() });
      }
      // Экран владельца «Расход и лимиты»: расход агента по пользователям и работам, месячные лимиты (usage.mjs).
      // Лимит — в токенах с весом (usage.WEIGHTS); доллары в ответе — справочная оценка по ценам API.
      if (path === "usage") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          const b = await readBody(req);
          const target = b.tgId == null ? null : Number(b.tgId);
          if (target !== null && (!target || target === users.OWNER_ID)) return send(400, { error: "Неверный пользователь" });
          try { await usage.setLimit(target, b.limit); } catch (e) { return send(400, { error: String(e.message || e) }); }
        }
        const [s, labs, all] = [await usage.summary(), await usage.byLab(), await users.listUsers()];
        const name = (id) => { const u = all.find((x) => x.tgId === id); return { name: u?.fullName || u?.tgName || null, username: u?.tgUsername || null, group: u?.group || null }; };
        const titles = new Map((await lab.titles().catch(() => [])).map((x) => [`${x.tgId}:${x.id}`, x]));
        return send(200, {
          ...s,
          labsCount: labs.length, avgLab: labs.length ? Math.round((labs.reduce((a, l) => a + l.usd, 0) / labs.length) * 100) / 100 : null,
          avgLabTok: labs.length ? Math.round(labs.reduce((a, l) => a + l.tok, 0) / labs.length) : null,
          users: s.users.map((u) => ({ ...u, ...name(u.tgId), isOwner: u.tgId === users.OWNER_ID })),
          labs: labs.slice(0, 40).map((l) => ({ tgId: l.tgId, id: l.id, tok: l.tok, raw: l.raw, usd: l.usd, calls: l.calls, kinds: l.kinds, kindsTok: l.kindsTok, last: l.days.at(-1) || null, title: titles.get(`${l.tgId}:${l.id}`)?.title || null, course: titles.get(`${l.tgId}:${l.id}`)?.course || null, name: name(l.tgId).name })),
        });
      }
      // Экран владельца «Доступ к отчётам»: список пользователей и переключатели.
      if (path === "access") {
        if (tgId !== users.OWNER_ID) return send(403, { error: "owner_only" });
        if (req.method === "POST") {
          const b = await readBody(req);
          const target = Number(b.tgId);
          if (!target || target === users.OWNER_ID) return send(400, { error: "Неверный пользователь" });
          await users.setLabAccess(target, !!b.allowed);
          void notify.send(target, b.allowed ? "✅ Вам открыты отчёты с агентом в Doodle: в карточке лабораторной появилась кнопка «Сделать отчёт»." : "🚫 Доступ к отчётам с агентом в Doodle закрыт.");
        }
        return send(200, { users: await users.listUsers() });
      }
      if (path === "login" && req.method === "POST") {
        const { username, password } = await readBody(req);
        if (!username || !password) return send(400, { error: "Введите логин и пароль" });
        if (recentFails(tgId).length >= 5) return send(429, { error: "Слишком много неудачных попыток входа. Подождите 5 минут." });
        try {
          const p = await users.login(tgId, String(username).trim(), String(password)); loginFails.delete(tgId);
          // Тот же логин и пароль подходят к электронному журналу (MISIS ID): подключаем его сразу, в фоне — вход в бот
          // этим не задерживается, а пароль после этого нигде не остаётся.
          void ej.connect(tgId, String(username).trim(), String(password)).then(() => { ej.forget(tgId); console.log(`ej ${tgId}: журнал подключён`); }, (e) => console.log(`ej ${tgId}: ${e.message}`));
          return send(200, p);
        }
        catch (e) {
          const msg = String(e.message || e), network = /Moodle не отвечает/.test(msg);
          if (!network) loginFails.set(tgId, [...recentFails(tgId), Date.now()]);
          return send(network ? 503 : 401, { error: msg });
        }
      }
      if (path === "logout" && req.method === "POST") { ej.forget(tgId); return send(200, await users.logout(tgId)); }

      const token = await users.moodleToken(tgId);
      const needLogin = () => send(401, { error: "login_required" });
      if (token) moodle.setOverrides(token, await users.courseOverrides(tgId));

      // «Делиться замечаниями преподавателя»: включить — замечания к работам попадут в общую базу (сразу, из уже загруженных
      // дедлайнов, и дальше при каждой проверке); выключить — замечания этого человека из базы удаляются.
      if (path === "share-remarks" && req.method === "POST") {
        const b = await readBody(req);
        await users.setShareRemarks(tgId, !!b.on);
        if (!b.on) await lessons.purge(tgId);
        else if (token) void moodle.deadlines(token).then((d) => collectLessons(tgId, d)).catch(() => {});
        return send(200, await me(tgId));
      }

      // «Уведомления бота» в профиле: объявления и материалы курсов (news), пропуски и посещаемость (journal).
      if (path === "notify-prefs" && req.method === "POST") {
        const b = await readBody(req);
        try { await users.setNotifyPref(tgId, String(b.key || ""), !!b.on); } catch (e) { return send(400, { error: String(e.message || e) }); }
        return send(200, await me(tgId));
      }

      // Курсы пользователя: автоматическое решение «актуален/нет» + ручной выбор (Профиль → Курсы).
      if (path === "courses") {
        if (!token) return needLogin();
        if (req.method === "POST") {
          const b = await readBody(req);
          const id = Number(b.id);
          if (!id) return send(400, { error: "Нужен id курса" });
          moodle.setOverrides(token, await users.setCourse(tgId, id, b.active));
          calendar.forget(tgId); // список курсов изменился — ленту календаря собрать заново
          // Работы включённого курса — не «новые»: запоминаем их молча, чтобы не пришла пачка уведомлений.
          try { const [d, q] = await Promise.all([moodle.deadlines(token, true), moodle.quizzesQuick(token)]); await notify.reseed(tgId, [...d.items, ...q.items]); } catch { /* уведомим позже */ }
        }
        return send(200, { semester: moodle.currentSemester(), courses: await moodle.allCourses(token) });
      }

      // Работает ли Moodle (для плашки «Moodle сейчас не работает»): сервер знает это по своим же запросам, Moodle тут не опрашивается.
      if (path === "status") return send(200, { moodle: moodle.health() });

      // «Календарь в телефоне»: ссылки подписки этого пользователя; POST { reset: true } — выдать новую ссылку (старая отключается).
      // stable — постоянный адрес есть и отвечает: подписка будет обновляться сама; иначе только разовый файл.
      if (path === "calendar") {
        const b = req.method === "POST" ? await readBody(req) : {};
        const l = await calendar.links(tgId, await appUrl(), { reset: !!b.reset });
        return send(200, { ...l, stable: l.stable && tunnelState().ok });
      }

      if (path === "deadlines") {
        if (!token) return needLogin();
        // Moodle не отвечает (сеть МИСИС, техработы): отдаём последние загруженные данные с пометкой, а не ошибку —
        // приложение работает как раньше и показывает плашку «это сбой у МИСИС».
        let d;
        try { d = await moodle.deadlines(token, url.searchParams.has("refresh")); }
        catch (e) {
          const stale = moodle.isOutage(e) ? moodle.staleDeadlines(token) : null;
          if (!stale) throw e;
          const h = moodle.health();
          d = { ...stale, stale: true, moodle: h.down ? h : { down: true, since: null, reason: /не данными/.test(e.message) ? "maintenance" : "network", okAt: h.okAt } };
        }
        // Пометки замечаний («новое» / «у агента» / «учтено») — по лабе этого пользователя. Кэш Moodle общий, поэтому копия.
        const items = await Promise.all(d.items.map(async (x) => (x.remarks?.length && x.id.startsWith("moodle:assign:")
          ? { ...x, remarks: await lab.markRemarks(tgId, x.id.slice(14), x.remarks) } : x)));
        return send(200, { ...d, items });
      }
      // Диагностика с телефона: клиент присылает, что у него в сторе не сходится (например, дедлайны без предмета).
      if (path === "diag" && req.method === "POST") {
        // Пишет на диск по запросу любого, кто открыл бота (даже без входа в Moodle), — поэтому редко и понемногу.
        { const r = rate.hit(`diag:${tgId}`, RL.diag, 600e3); if (r) { req.resume(); return tooMany(r, `диагностика пользователя ${tgId}`); } }
        const body = await readBody(req, 64 << 10);
        await mkdir(join(DIR, "diag"), { recursive: true });
        await writeFile(join(DIR, "diag", `${tgId}.json`), JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2));
        return send(200, { ok: true });
      }
      // Преподаватели курса (контакты курса в Moodle): ?course=<id>.
      if (path === "teachers") {
        if (!token) return needLogin();
        const courseId = Number(url.searchParams.get("course"));
        if (!courseId) return send(400, { error: "Нужен course" });
        const { teachers: list, course } = await moodle.courseInfo(token, courseId);
        // К каждому — оценка из «Кампуса» (публичная), если преподаватель там есть. course — описание курса для экрана «Курс».
        const campusData = await Promise.all(list.map((t) => campus.teacher(t.name)));
        return send(200, { teachers: list.map((t, i) => ({ ...t, campus: campusData[i] })), course });
      }
      // Настройки напоминаний: { "<deadlineId>": "day" | "3h" | "none" }.
      if (path === "reminders") {
        if (req.method === "GET") return send(200, await notify.loadPrefs(tgId));
        if (req.method === "POST") {
          const body = await readBody(req);
          const prefs = Object.fromEntries(Object.entries(body).filter(([k, v]) => /^moodle:/.test(k) && ["day", "3h", "none"].includes(v)));
          await notify.savePrefs(tgId, prefs);
          return send(200, prefs);
        }
        return send(405, { error: "method" });
      }
      // Группа для расписания: автоопределение по группам курсов Moodle; POST { group, subgroup } — выбор вручную.
      if (path === "group") {
        if (req.method === "POST") {
          const b = await readBody(req);
          calendar.forget(tgId);
          try { return send(200, await users.setGroup(tgId, b.group, b.subgroup, b.variant)); } catch (e) { return send(400, { error: String(e.message || e) }); }
        }
        const prof = await users.profile(tgId);
        if (prof.group || !token) return send(200, { group: prof.group, candidates: prof.groupCandidates, subgroup: prof.subgroup });
        const [names, all] = await Promise.all([moodle.userGroupNames(token), groupList()]);
        const det = await users.detectGroup(tgId, names, all);
        return send(200, { ...det, subgroup: prof.subgroup, moodleGroups: names });
      }
      if (path === "groups") return send(200, await groupList(url.searchParams.has("refresh")));
      // Расписание пар группы пользователя (dnevuch.ru).
      if (path === "schedule") {
        const prof = await users.profile(tgId);
        const group = url.searchParams.get("group") || prof.group;
        if (!group) return send(200, { at: Date.now(), group: null, lessons: [], needGroup: true });
        return send(200, { ...(await schedule(group, url.searchParams.has("refresh"))), subgroup: prof.subgroup });
      }

      // Отзыв преподавателя по работе (замечания, состояние ответа, файлы) — свежим запросом в Moodle; доступен всем вошедшим.
      const fbm = path.match(/^feedback\/(\d+)$/);
      if (fbm) {
        if (!token) return needLogin();
        const f = await moodle.assignFeedback(token, fbm[1]);
        return send(200, { ...f, remarks: await lab.markRemarks(tgId, fbm[1], f.remarks) });
      }

      // «Прикрепить PDF» в карточке работы: свой файл студента → в его ответ Moodle (доступно всем вошедшим: агент тут
      // не участвует). Только по нажатию и подтверждению в приложении; тело запроса — сам PDF, имя — в X-File-Name.
      const upm = path.match(/^upload\/(\d+)$/);
      if (upm && req.method === "POST") {
        if (!token) return needLogin();
        const data = await readRaw(req);
        if (!data.length) return send(400, { error: "Пустой файл" });
        if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return send(400, { error: "Это не PDF-файл" });
        try { return send(200, await moodle.attachOwnFile(token, upm[1], { name: uploadName(req.headers["x-file-name"]), data })); }
        catch (e) { if (/invalidtoken/.test(e.message)) throw e; return send(e.status || 400, { error: String(e.message || e) }); }
      }
      // «Отправить на проверку» в карточке работы (у заданий с черновиком) — отдельным нажатием и подтверждением.
      const sbm = path.match(/^submit\/(\d+)$/);
      if (sbm && req.method === "POST") {
        if (!token) return needLogin();
        try { return send(200, await moodle.submitOwn(token, sbm[1])); }
        catch (e) { if (/invalidtoken/.test(e.message)) throw e; return send(e.status || 400, { error: String(e.message || e) }); }
      }
      // Электронный журнал (ej.misis.ru): посещаемость и успеваемость за текущий семестр (ej.mjs); ?refresh — мимо 10-минутного запаса.
      // Владельцу рядом пишется снимок сырых данных (ej-debug/, только его записи) — сверять разбор с журналом.
      if (path === "ej" && req.method === "GET") {
        if (!token) return needLogin();
        const st = await users.ejState(tgId);
        if (!st.connected) return send(200, { ...st, data: null });
        try {
          const data = await ej.journal(tgId, { force: url.searchParams.has("refresh"), ...(tgId === users.OWNER_ID ? { debugDir: join(DIR, "ej-debug") } : {}) });
          return send(200, { ...(await users.ejState(tgId)), data });
        } catch (e) {
          if (e.code === "need_password" || e.code === "need_connect") return send(200, { ...(await users.ejState(tgId)), connected: false, needPassword: true, data: null });
          console.log(`ej ${tgId}: ${e.message}`);
          // Журнал не ответил — прошлые данные и причина, ответом 200: код 502 Cloudflare подменяет своей страницей,
          // и в приложении вместо причины было «ошибка 502» (2 окт).
          return send(200, { ...(await users.ejState(tgId)), data: ej.lastGood(tgId), loadError: String(e.message || e) });
        }
      }
      // Подключить журнал вручную (кто вошёл в бот раньше, чем появился журнал, или когда вход MISIS ID истёк):
      // пароль от Moodle/MISIS ID, почта — из входа в Moodle. Пароль не хранится.
      if (path === "ej/connect" && req.method === "POST") {
        if (!token) return needLogin();
        const b = await readBody(req);
        const email = String(b.email || (await users.profile(tgId)).moodle?.username || "").trim();
        if (!email || !b.password) return send(400, { error: "Введите пароль" });
        if (recentFails(tgId).length >= 5) return send(429, { error: "Слишком много неудачных попыток. Подождите 5 минут." });
        try { await ej.connect(tgId, email, String(b.password)); ej.forget(tgId); loginFails.delete(tgId); }
        catch (e) {
          if (e.code === "bad_credentials") { loginFails.set(tgId, [...recentFails(tgId), Date.now()]); return send(401, { error: e.message }); }
          return send(424, { error: String(e.message || e) }); // не 502: его Cloudflare подменяет своей страницей
        }
        return send(200, await users.ejState(tgId));
      }
      // Лабы пользователя, где что-то идёт или ждут его ответа, — для плашки на Главной (без доступа к отчётам — пусто).
      if (path === "labs") return send(200, (await users.labsAllowed(tgId)) ? await lab.list(tgId) : []);
      // Лабораторная с агентом: только по белому списку, /api/lab/<assignId>[/start|/message|/attach|/submit|/fix] (report — выше)
      const m = path.match(/^lab\/(\d+)(?:\/(start|message|approve|attach|submit|fix|upload|explain|dismiss))?$/);
      if (m) {
        const [, id, action] = m;
        if (!(await users.labsAllowed(tgId))) return send(403, { error: "labs_not_allowed" });
        // Лаба — своя у каждого пользователя по каждой работе (lab.mjs: ключ <tgId>-<id>): чужую переписку не увидеть и чужой отчёт не прикрепить.
        if (req.method === "GET") return send(200, (await lab.get(tgId, id)) ?? { id, status: "idle", messages: [], report: null, moodle: null, agent: null });
        if (req.method !== "POST") return send(405, { error: "method" });
        // Скрепка в чате лабы: файл студента (снимок экрана, вывод программы) — тело запроса как есть, имя в X-File-Name.
        if (action === "upload") {
          try { return send(200, await lab.fromStudent(tgId, id, req.headers["x-file-name"], await readRaw(req))); }
          catch (e) { return send(e.status || 400, { error: String(e.message || e) }); }
        }
        const body = await readBody(req);
        try {
          if (action === "start") {
            const p = await users.profile(tgId);
            if (!token) return needLogin();
            // token — только чтобы сервер скачал условие и вложения от имени этого пользователя; в задание и к агенту он не попадает.
            return send(200, await lab.start(id, { ...body, tgId, token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }));
          }
          if (action === "fix") {
            // «Исправить отчёт»: замечания преподавателя сервер сам берёт из Moodle и передаёт агенту; в Moodle ничего не меняется.
            if (!token) return needLogin();
            const p = await users.profile(tgId);
            return send(200, await lab.fix(id, { ...body, tgId, token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }));
          }
          if (action === "message") return send(200, await lab.message(tgId, id, body.text));
          // «Всё хорошо» под отчётом: только после этого отчёт можно прикрепить в Moodle.
          if (action === "approve") return send(200, await lab.approve(tgId, id));
          // «Кратко о работе» под готовым отчётом: короткое объяснение сути работы (состояние лабы не меняется).
          if (action === "explain") return send(200, await lab.explain(tgId, id));
          // «Убрать с Главной»: плашка лабы скрывается; сама лаба и отчёт остаются, в Moodle ничего не меняется.
          if (action === "dismiss") return send(200, await lab.dismiss(tgId, id));
          if (action === "attach") return send(200, await lab.attach(tgId, id, token));
          if (action === "submit") return send(200, await lab.submit(tgId, id, token));
        } catch (e) { return send(400, { error: String(e.message || e) }); }
        return send(404, { error: "unknown action" });
      }
      // Проверка своего отчёта (lab.mjs checkReport): GET — состояние; POST — файл отчёта (тело запроса как есть, имя в X-File-Name).
      const ck = path.match(/^check\/(\d+)$/);
      if (ck) {
        if (!(await users.labsAllowed(tgId))) return send(403, { error: "labs_not_allowed" });
        if (req.method === "GET") return send(200, (await lab.checkState(tgId, ck[1])) ?? { id: ck[1], status: "idle" });
        if (req.method !== "POST") return send(405, { error: "method" });
        if (!token) return needLogin();
        try {
          const data = await readRaw(req);
          const p = await users.profile(tgId);
          return send(200, await lab.checkReport(tgId, ck[1], { token, student: { fullName: p.moodle?.fullName, group: p.group, variant: p.variant } }, req.headers["x-file-name"], data));
        } catch (e) { return send(e.status || 400, { error: String(e.message || e) }); }
      }
      return send(404, { error: "unknown api" });
    }

    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return send(400, "bad path", "text/plain");
    const hashed = /^assets\/.+-[\w-]{8,}\.\w+$/.test(file);
    if (hashed && acceptsGzip && /\.(js|css|svg)$/.test(file)) {
      // Файлы сборки с хешем в имени: сжимаем один раз, кэшируем в браузере на год.
      let gz = gzCache.get(file);
      if (!gz) { const raw = await readFile(join(DIST, file)).catch(() => null); if (raw) { gz = gzipSync(raw, { level: 9 }); gzCache.set(file, gz); } }
      if (gz) return send(200, gz, TYPES[extname(file)], { "content-encoding": "gzip", "cache-control": "public, max-age=31536000, immutable" });
    }
    let body = await readFile(join(DIST, file)).catch(() => null);
    if (!body && !extname(file)) { file = "index.html"; body = await readFile(join(DIST, file)).catch(() => null); }
    // Кэш клиента просит файл прежней сборки (index-<старый хеш>.js/.css), которого уже нет: отдаём текущий того же типа.
    if (!body && /^assets\/index-[\w-]+\.(js|css)$/.test(file)) {
      const ext = extname(file);
      const current = (await readdir(join(DIST, "assets")).catch(() => [])).find((f) => f.startsWith("index-") && f.endsWith(ext));
      if (current) { file = `assets/${current}`; body = await readFile(join(DIST, file)).catch(() => null); }
    }
    if (!body) return send(404, "not found", "text/plain");
    const isHtml = extname(file) === ".html";
    send(200, body, TYPES[extname(file)] || "application/octet-stream",
      isHtml ? { "cache-control": "no-cache, no-store, must-revalidate", pragma: "no-cache", expires: "0" } : hashed ? { "cache-control": "public, max-age=31536000, immutable" } : {});
  } catch (e) {
    const msg = String(e.message || e);
    // Токен Moodle перестал действовать (смена пароля, отзыв админом): снимаем вход, приложение покажет форму входа.
    // Без этого пользователь оставался «вошедшим», а каждый запрос падал с «invalidtoken».
    if (/^invalidtoken\b/.test(msg) && req.tgId) { await users.logout(req.tgId).catch(() => {}); return send(401, { error: "login_required" }); }
    // Сбой внешнего сервиса — 424, не 502: ответ 502 Cloudflare (туннель) подменяет своей страницей, и вместо причины
    // («Moodle не отвечает…») приложение показывало «ошибка 502».
    send(e.status && e.status !== 502 && e.status !== 504 ? e.status : 424, { error: msg });
  }
}).listen(PORT, HOST, () => console.log(`Jarvis app: http://${HOST}:${PORT}  (bot-token: ${BOT_TOKEN ? "есть" : "нет"})`));
