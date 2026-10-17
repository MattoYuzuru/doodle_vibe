// Анонс новой функции «Сессия» всем пользователям Doodle (просьба владельца, 15 окт 2026): картинка
// assets\announce\session.png, под ней описание и кнопка, открывающая приложение сразу во вкладке «Журнал → Сессия»
// (?open=session, см. useNav.ts).
//
//   node ops\announce-session.mjs check  — ничего не отправляет: скольким уйдёт, кто выключил сообщения (/stop).
//   node ops\announce-session.mjs test   — только владельцу (посмотреть, как выглядит). В список «отправлено» не идёт.
//   node ops\announce-session.mjs send   — всем, кроме выключивших сообщения. Кому ушло — в announce-session-state.json:
//                                          повторный запуск досылает только тем, кому не дошло (сеть или ещё не
//                                          нажимали Start у бота).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const bots = await import("../bots.mjs");
const notify = await import("../notify.mjs");
const { OWNER_ID } = await import("../users.mjs");
const mode = process.argv[2] || "check";
const say = (t) => console.log(t);
const at = (name) => join(APP, name);
const STATE = at("announce-session-state.json");
const IMAGE = at("assets/announce/session.png");
const appUrl = await readFile(at("current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
const people = (await readdir(at("users")).catch(() => [])).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
const loadState = () => readFile(STATE, "utf8").then(JSON.parse).catch(() => ({ sent: [], unreachable: [] }));
const saveState = (s) => writeFile(STATE, JSON.stringify(s, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unreachable = (r) => r.error_code === 403 || /can't initiate|chat not found|bot was blocked|user is deactivated|PEER_ID_INVALID/i.test(String(r.description || ""));

export const TEXT = `Новое в Doodle — «Сессия»

Во вкладке «Журнал» появился переключатель «Журнал | Сессия». Там:
— сколько дней осталось до сессии;
— расписание экзаменов и зачётов вашей группы, как только его опубликуют;
— баллы по каждой дисциплине: сколько уже есть и сколько нужно на 3, 4 или 5 (или на зачёт);
— напоминания накануне экзамена и в день экзамена.

Открыть можно и с Главной (плитка «Сессия»), и командой /session в чате с ботом.`;

// Фото уходит один раз файлом, дальше — по file_id Telegram (быстрее и без повторной загрузки).
let photoId = null;
async function sendTo(id) {
  const markup = JSON.stringify({ inline_keyboard: [[{ text: "Открыть «Сессию»", web_app: { url: `${appUrl}/?open=session` } }]] });
  if (photoId) return bots.call("sendPhoto", { chat_id: id, photo: photoId, caption: TEXT, reply_markup: JSON.parse(markup) });
  const form = new FormData();
  form.set("chat_id", String(id));
  form.set("caption", TEXT);
  form.set("reply_markup", markup);
  form.set("photo", new Blob([await readFile(IMAGE)], { type: "image/png" }), "session.png");
  const r = await bots.call("sendPhoto", form, { timeout: 120000 });
  if (r.ok) photoId = r.result.photo.at(-1).file_id;
  return r;
}

async function main() {
  if (TEXT.length > 1024) { say(`Текст длиннее 1024 знаков (${TEXT.length}) — Telegram не примет подпись.`); return 1; }
  if (!appUrl) { say("Адрес приложения неизвестен (current-url.txt пуст) — кнопка не откроется. Сначала должен работать туннель."); return 1; }
  const muted = [];
  for (const id of people) if (await notify.isMuted(id)) muted.push(id);
  const st = await loadState();
  // Недоступных пробуем снова при каждом запуске: человек мог с тех пор нажать Start у бота.
  const todo = people.filter((id) => !muted.includes(id) && !st.sent.includes(id));
  say(`Людей: ${people.length}. Выключили сообщения (/stop): ${muted.length}. Уже отправлено: ${st.sent.length}. Осталось: ${todo.length}.`);
  say(`Кнопка ведёт на: ${appUrl}/?open=session`);

  if (mode === "test") {
    const r = await sendTo(OWNER_ID);
    say(r.ok ? "Пробное сообщение ушло владельцу." : `Не ушло: ${r.description}`);
    return r.ok ? 0 : 2;
  }
  if (mode !== "send") { say("\nЭто была проверка. Пробно себе: node ops\\announce-session.mjs test; всем: … send"); return 0; }

  let network = 0;
  st.unreachable = [];
  for (const id of todo) {
    const r = await sendTo(id);
    if (r.ok) st.sent.push(id); else if (unreachable(r)) st.unreachable.push(id); else { network++; say(`  ${id}: ${r.description}`); }
    await saveState(st); // после каждого: при обрыве второй раз не уйдёт
    await sleep(150);
  }
  say(`Анонс доставлен: ${st.sent.length} из ${people.length - muted.length}.`);
  if (st.unreachable.length) say(`  Бот не может писать (не нажимали Start или заблокировали): ${st.unreachable.join(", ")}`);
  if (network) { say(`  Не ушло из-за сети: ${network}. Запустите send ещё раз — досылается только им.`); return 2; }
  return 0;
}
process.exitCode = await main();
