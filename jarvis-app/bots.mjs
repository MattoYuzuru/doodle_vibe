// Бот Telegram, через которого работает Doodle: им сервер пишет людям, по его токену проверяется подпись приложения,
// ему ставится кнопка приложения. Токен — bot-token.txt; наружу из этого модуля он не выдаётся: только проверка подписи
// (signedBy) и вызов Bot API (call).
//
// Переезд на нового бота (решение владельца, 5 окт 2026: у бота нельзя сменить @-имя, поэтому заводится новый, а прежний
// прощается и отключается) делает ops\bot-move.mjs: токен нового бота владелец кладёт в bot-token-new.txt, скрипт
// настраивает нового бота и меняет файлы местами (прежний токен — в bot-token-prev.txt), а после перезапуска сервера
// прежний бот рассылает прощальное сообщение и отключается. Для этого call умеет работать токеном из bot-token-new.txt
// (bot: "new") и из bot-token-prev.txt (bot: "prev") — больше нигде они не используются.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(join(DIR, name), "utf8").then((t) => t.replace(/^﻿/, "").trim()).catch(() => "");
const TOKEN = await read("bot-token.txt");

/** Есть ли токен бота. */
export const hasBot = !!TOKEN;
/**
 * Бот целиком принадлежит Doodle: сообщения, написанные боту, получает этот сервер (ответ на /start — welcome.mjs), и
 * запасной путь отправки через OpenClaw не нужен. Включается пустым файлом bot-updates.on или BOT_UPDATES=1 — после
 * переезда; пока ботом пользуется и OpenClaw (чат владельца с агентом), должно быть выключено.
 */
export const ownBot = () => process.env.BOT_UPDATES === "1" || (process.env.BOT_UPDATES !== "0" && existsSync(join(DIR, "bot-updates.on")));

/**
 * Вызов Bot API: body — объект или FormData. bot: "new" — токеном из bot-token-new.txt, "prev" — из bot-token-prev.txt
 * (только для скрипта переезда). Возвращает ответ Telegram { ok, result, description, error_code }; сбой сети —
 * { ok: false, network: true, code? }.
 * code — код ошибки сети (15 окт 2026): «ECONNREFUSED», «ENOTFOUND», «UND_ERR_CONNECT_TIMEOUT»… Раньше любая ошибка
 * fetch выглядела одинаково («fetch failed»), и notify считал её «неизвестно, могло и дойти», хотя при отказе в
 * соединении или ненайденном адресе запрос до Telegram точно не ушёл: утренняя сводка после сна ноутбука (сеть ещё не
 * поднялась) так и терялась. Код лежит в e.cause.code (у «localhost» с двумя адресами — AggregateError, код там же);
 * у таймаута AbortSignal кода-строки нет (DOMException с числовым code) — его не отдаём, это «неизвестно».
 */
const OTHER = { new: "bot-token-new.txt", prev: "bot-token-prev.txt" };
export async function call(method, body, { bot = "main", timeout = 20000 } = {}) {
  const token = OTHER[bot] ? await read(OTHER[bot]) : TOKEN;
  if (!token) return { ok: false, description: `нет ${OTHER[bot] || "bot-token.txt"}` };
  try {
    const form = body instanceof FormData;
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", signal: AbortSignal.timeout(timeout),
      ...(form ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }) });
    // 2xx с недочитанным телом — Telegram сообщение принял, потерялся только ответ: «неизвестно» (network без code), а не
    // «сбой» — иначе повтор слал бы дубли до 6 раз (проверка 15 окт). 4xx/5xx без JSON — как раньше.
    return await r.json().catch(() => (r.ok ? { ok: false, network: true, description: `HTTP ${r.status}: ответ не дочитан` } : { ok: false, description: `HTTP ${r.status}` }));
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    return { ok: false, description: String(e.message || e), network: true, ...(typeof code === "string" ? { code } : {}) };
  }
}

/**
 * Подписаны ли данные приложения (initData) этим ботом. Алгоритм Telegram: HMAC-SHA256 от строки параметров
 * с ключом HMAC("WebAppData", токен бота).
 */
export function signedBy(dataCheck, hash) {
  if (!TOKEN) return false;
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const calc = createHmac("sha256", secret).update(dataCheck).digest("hex");
  return calc.length === hash.length && timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
}
