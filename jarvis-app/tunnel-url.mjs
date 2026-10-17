// Следит за tunnel.log: когда быстрый туннель Cloudflare получает новый адрес, записывает его в current-url.txt,
// САМ переписывает адрес мини-приложения у бота (Bot API setChatMenuButton — то же, что Menu Button в BotFather)
// и коротко сообщает владельцу. Запускается вместе с сервером (server.mjs импортирует и вызывает watchTunnelUrl()).
// На VPS туннеля нет: адрес задаёт переменная APP_URL (ops/vps/doodle.service), остальное работает так же.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bots from "./bots.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG = join(DIR, "tunnel.log");
const CURRENT = join(DIR, "current-url.txt");
const OPENCLAW = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "openclaw", "openclaw.mjs");
const OWNER = "945210206";
const MENU_TEXT = "Doodle";
const BOT_TOKEN = bots.hasBot; // есть ли токен основного бота (сам токен — только в bots.mjs)
// Telegram хранит адрес со слэшем на конце — сравниваем без него.
const norm = (u) => (u || "").replace(/[/]+$/, "");
// Постоянный адрес (VPS со своим доменом, 17 окт 2026): задан — tunnel.log не читается, кнопки держатся на нём.
const FIXED = norm(process.env.APP_URL || "");

/** Сообщение владельцу: самим ботом; пока ботом пользуется и OpenClaw (до переезда) — запасной путь через него. */
async function notify(text) {
  const r = await bots.call("sendMessage", { chat_id: Number(OWNER), text, disable_web_page_preview: true });
  if (r.ok || bots.ownBot()) return;
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [OPENCLAW, "message", "send", "--channel", "telegram", "--target", OWNER, "-m", text], { windowsHide: true });
    const t = setTimeout(() => p.kill(), 60e3);
    p.on("close", () => { clearTimeout(t); resolve(); });
    p.on("error", () => { clearTimeout(t); resolve(); });
  });
}

/** Вызов Bot API. Отказ Telegram — исключение с его текстом; сбой сети — «fetch failed» (повторяется на следующем тике). */
async function botApi(method, body) {
  const j = await bots.call(method, body);
  if (!j.ok) throw new Error(j.network ? "fetch failed" : j.description || "нет ответа");
  return j.result;
}

/** Адрес мини-приложения по умолчанию у бота (кнопка меню для всех), или "" если это не web_app. */
export async function menuButtonUrl() {
  if (!BOT_TOKEN) return "";
  const b = await botApi("getChatMenuButton");
  return b?.type === "web_app" ? (b.web_app?.url || "") : "";
}

/**
 * Ставит адрес мини-приложения у бота. Умолчание (для всех, кто ещё не открывал бота) Telegram меняет через API только
 * если кнопка меню НЕ настроена в BotFather — пока она там стоит, API отвечает ok, но значение не меняется (проверено).
 * Поэтому дополнительно ставим кнопку каждому известному пользователю по chat_id — это работает всегда и сразу.
 * Возвращает { defaultOk, chats } — применилось ли умолчание и скольким чатам поставили лично.
 */
export async function setMenuButton(url) {
  if (!BOT_TOKEN) return { defaultOk: false, chats: 0 };
  const menu_button = { type: "web_app", text: MENU_TEXT, web_app: { url } };
  await botApi("setChatMenuButton", { menu_button }).catch((e) => console.error("menu default:", e.message));
  const defaultOk = norm(await menuButtonUrl()) === norm(url);
  let chats = 0;
  const ids = (await readdir(join(DIR, "users")).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  if (!ids.includes(OWNER)) ids.push(OWNER);
  for (const id of ids) {
    try { await botApi("setChatMenuButton", { chat_id: Number(id), menu_button }); chats++; }
    catch (e) { console.error(`menu chat ${id}:`, e.message); } // например, пользователь заблокировал бота
  }
  return { defaultOk, chats };
}

/**
 * Включено ли у бота главное мини-приложение (BotFather → Configure Mini App). На него ведут ярлык на экране телефона и
 * ссылка t.me/<бот>?startapp, а его адрес Bot API не меняет — только вручную в BotFather (19 окт 2026).
 */
export async function hasMainApp() {
  if (!BOT_TOKEN) return false;
  const r = await bots.call("getMe");
  return !!r.ok && !!r.result?.has_main_web_app;
}
const MAIN_APP_HINT = "\n\n📱 Ярлык на экране телефона открывает главное мини-приложение бота, а его адрес Telegram даёт менять только вручную. " +
  "Обновите в @BotFather: /mybots → бот → Bot Settings → Configure Mini App → Edit Mini App URL → вставьте адрес выше.";

export async function currentUrl() { return readFile(CURRENT, "utf8").then((t) => t.trim()).catch(() => ""); }

/** Быстрый туннель Cloudflare иногда «протухает»: cloudflared бесконечно повторяет «Tunnel not found», а адрес пропадает из DNS. */
export async function tunnelLooksDead() {
  const log = await readFile(LOG, "utf8").catch(() => "");
  const tail = log.slice(-4000);
  return (tail.match(/Tunnel not found/g) || []).length >= 3;
}

const isNetworkError = (e) => e?.message === "fetch failed" || e?.name === "TimeoutError" || e?.name === "AbortError";
const menuFor = (url) => ({ type: "web_app", text: MENU_TEXT, web_app: { url } });

/** Адрес кнопки меню у конкретного чата ("" — кнопка не web_app). */
export async function chatMenuUrl(chatId) {
  const b = await botApi("getChatMenuButton", { chat_id: Number(chatId) });
  return b?.type === "web_app" ? (b.web_app?.url || "") : "";
}
/** Все, кому кнопку ставим лично: вошедшие в приложение (users/*.json) и владелец. */
async function knownChats() {
  const ids = (await readdir(join(DIR, "users")).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  if (!ids.includes(OWNER)) ids.push(OWNER);
  return ids;
}

/*
 * Следит за адресом туннеля и держит кнопку меню бота на нём — у бота по умолчанию и у каждого известного чата.
 * Кнопка сверяется у КАЖДОГО чата (раньше смотрели только владельца: если у него уже стояло верно, остальным отставшую
 * кнопку не чинили), а неудача из-за сети повторяется каждый тик, пока не получится (раньше попытка была одна: 1 окт 2026
 * при моргающей связи второй пользователь остался с кнопкой на мёртвый адрес — «бот не работает» при живом туннеле).
 * Отказ самого Telegram (бот заблокирован, чат не найден) не повторяем.
 */
export function watchTunnelUrl() {
  const TICK = Number(process.env.TUNNEL_TICK_MS) || 30 * 1000;
  let last = null;            // адрес, под который идёт синхронизация
  let pending = new Set();    // чаты, которым кнопку на этот адрес ещё не удалось проверить или поставить
  let defaultPending = false; // то же для кнопки бота по умолчанию
  let announce = null;        // что написать владельцу о новом адресе, когда кнопки обновлены
  let changed = 0, defaultOk = false, warned = false, busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const log = FIXED ? "" : await readFile(LOG, "utf8").catch(() => "");
      // Адрес туннеля — только из рамки «Your quick Tunnel has been created» («|  https://….trycloudflare.com  |»).
      // Раньше брался любой адрес trycloudflare из лога, и при неудачном создании туннеля в приложение и в кнопку меню
      // бота попал служебный https://api.trycloudflare.com из текста ошибки (1 окт 2026).
      const urls = [...log.matchAll(/\|\s+(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s+\|/g)].map((m) => m[1]).filter((u) => !/\/\/api\./.test(u));
      const url = FIXED || urls[urls.length - 1];
      if (!url) return;
      if (url !== last) {
        const prev = await currentUrl();
        last = url;
        if (url !== prev) await writeFile(CURRENT, url + "\n");
        // Адрес тот же (перезапуск сервера) — всё равно сверяем кнопки: вдруг у кого-то отстала.
        pending = new Set(await knownChats());
        defaultPending = true;
        changed = 0; warned = false;
        announce = url === prev ? null : FIXED ? "Постоянный адрес Doodle" : "Новый адрес Doodle (после перезапуска туннеля)";
      }
      if (!BOT_TOKEN || (!pending.size && !defaultPending)) return;
      if (defaultPending) {
        try {
          if (norm(await menuButtonUrl()) !== norm(url)) await botApi("setChatMenuButton", { menu_button: menuFor(url) });
          // Пока кнопка меню настроена в BotFather, API отвечает ok, но умолчание не меняется — поэтому перечитываем.
          defaultOk = norm(await menuButtonUrl()) === norm(url);
          defaultPending = false;
        } catch (e) { if (!isNetworkError(e)) { defaultPending = false; defaultOk = false; console.error("menu default:", e.message); } }
      }
      for (const id of [...pending]) {
        try {
          if (norm(await chatMenuUrl(id)) !== norm(url)) { await botApi("setChatMenuButton", { chat_id: Number(id), menu_button: menuFor(url) }); changed++; }
          pending.delete(id);
        } catch (e) {
          if (isNetworkError(e)) continue; // связь моргнула — повторим на следующем тике
          pending.delete(id);
          console.error(`menu chat ${id}:`, e.message);
        }
      }
      if (pending.size || defaultPending) {
        if (!warned) { warned = true; console.log(`menu button: нет связи с Telegram, повторяю каждые ${Math.round(TICK / 1000)} с (чатов осталось: ${pending.size}${defaultPending ? ", умолчание" : ""})`); }
        return;
      }
      if (changed || announce) console.log(`menu button → ${url} (умолчание: ${defaultOk ? "да" : "нет"}, обновлено чатов: ${changed})`);
      // Адрес сменился: кнопки меню сервер поправил сам, а главное мини-приложение (если включено) — только владелец руками,
      // поэтому о нём пишем, даже если кнопки у всех уже стояли верно.
      const main = announce ? await hasMainApp().catch(() => false) : false;
      if (announce && (changed || main)) {
        await notify(`🔗 ${announce}: ${url}\nАдрес мини-приложения обновлён автоматически — просто откройте Doodle заново.` +
          (defaultOk ? "" : "\n\nℹ️ Для новых пользователей адрес обновится сам, только если убрать кнопку меню в @BotFather (Bot Settings → Menu Button → Remove) — один раз.") +
          (main ? MAIN_APP_HINT : ""));
      }
      announce = null; changed = 0;
    } catch (e) { console.error("menu button:", e.message); }
    finally { busy = false; }
  };
  void tick();
  setInterval(tick, TICK);
}
