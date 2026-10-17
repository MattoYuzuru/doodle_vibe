// Переезд Doodle на нового бота (решение владельца, 5 окт 2026: у бота нельзя сменить @-имя; прежний бот прощается
// и отключается).
//
// Что сделать владельцу до запуска: создать бота в BotFather (/newbot) и положить его токен одной строкой в файл
// jarvis-app\bot-token-new.txt. Токены этот скрипт не печатает и никуда, кроме Telegram, не передаёт.
//
// Порядок выбран так, чтобы необратимое — прощальная рассылка — шло последним, когда новый бот уже проверен вживую:
//
//   node ops\bot-move.mjs check     — только проверка: что за боты, скольким людям уйдёт прощальное сообщение.
//   node ops\bot-move.mjs go        — (1) новому боту ставятся описание, команды и кнопка приложения; (2) файлы токенов
//                                     меняются местами (прежний — в bot-token-prev.txt) и включается приём сообщений
//                                     (bot-updates.on). Людям ничего не отправляется. Дальше — перезапуск сервера и
//                                     проверка нового бота.
//   node ops\bot-move.mjs back      — откат шага go (пока не было farewell): токены и приём сообщений возвращаются как
//                                     были. Дальше — перезапуск сервера.
//   node ops\bot-move.mjs farewell  — прежний бот пишет всем прощальное сообщение со ссылкой на нового; потом у него
//                                     снимается кнопка приложения, в описании остаётся ссылка. Кому сообщение уже ушло,
//                                     запоминается (bot-move-state.json): повторный запуск досылает только тем, кому
//                                     не дошло из-за сети.
//   node ops\bot-move.mjs who       — кому новый бот ещё не может написать (не нажали в нём Start).
import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const bots = await import("../bots.mjs");
const welcome = await import("../welcome.mjs");
const mode = process.argv[2] || "check";
const say = (t) => console.log(t);
const at = (name) => join(APP, name);
const STATE = at("bot-move-state.json");
const appUrl = await readFile(at("current-url.txt"), "utf8").then((t) => t.trim()).catch(() => "");
const people = (await readdir(at("users")).catch(() => [])).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
const loadState = () => readFile(STATE, "utf8").then(JSON.parse).catch(() => ({}));
const saveState = (s) => writeFile(STATE, JSON.stringify(s, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAREWELL = (name) => `👋 Doodle переехал в нового бота: @${name}

Этот бот больше не работает: уведомления и приложение теперь только там. Нажмите кнопку ниже и «Старт» — вход в Moodle, настройки и календарь сохранены, заново ничего вводить не нужно.`;
const OLD_DESCRIPTION = (name) => `Этот бот больше не используется. Doodle переехал: @${name}`;
// Telegram не даёт боту писать человеку (не нажимал Start, заблокировал, чата нет) — повторять бесполезно.
const unreachable = (r) => r.error_code === 403 || /can't initiate|chat not found|bot was blocked|user is deactivated|PEER_ID_INVALID/i.test(String(r.description || ""));

// Выход — через код возврата main(), без process.exit: обрыв ещё закрывающихся соединений роняет Node на Windows.
async function main() {
  if (mode === "who") {
    // «Печатает…» в чат — действие без сообщения: Telegram откажет, если человек не нажимал Start у этого бота.
    const missing = [];
    for (const id of people) { const r = await bots.call("sendChatAction", { chat_id: id, action: "typing" }); if (!r.ok) missing.push(id); }
    say(`Всего людей: ${people.length}. Новый бот может писать: ${people.length - missing.length}.`);
    if (missing.length) say(`Ещё не нажали Start в новом боте (Telegram id): ${missing.join(", ")}`);
    return 0;
  }

  if (mode === "back") {
    const st = await loadState();
    if (st.farewell?.sent?.length) { say("Прощальное сообщение уже уходило людям — откат не делается."); return 1; }
    if (!existsSync(at("bot-token-prev.txt"))) { say("Откатывать нечего: файла bot-token-prev.txt нет."); return 1; }
    await rename(at("bot-token.txt"), at("bot-token-new.txt"));
    await rename(at("bot-token-prev.txt"), at("bot-token.txt"));
    if (existsSync(at("bot-updates.on"))) await rename(at("bot-updates.on"), at("bot-updates.off"));
    await saveState({ ...st, swappedAt: null, rolledBackAt: Date.now() });
    say("Откат сделан: сервер снова будет работать с прежним ботом. Нужен перезапуск сервера.");
    return 0;
  }

  if (mode === "farewell") {
    if (!existsSync(at("bot-token-prev.txt"))) { say("Сначала шаг go: файла bot-token-prev.txt (токен прежнего бота) нет."); return 1; }
    const meNew = await bots.call("getMe", {}), meOld = await bots.call("getMe", {}, { bot: "prev" });
    if (!meNew.ok || !meOld.ok) { say(`Бот не отвечает: ${meNew.ok ? "" : "новый — " + meNew.description} ${meOld.ok ? "" : "прежний — " + meOld.description}`.trim()); return 1; }
    if (meNew.result.id === meOld.result.id) { say("Токены прежнего и нового бота совпадают — рассылка не делается."); return 1; }
    const name = meNew.result.username, old = (method, body) => bots.call(method, body, { bot: "prev" });
    const st = await loadState();
    const fw = (st.farewell ??= { sent: [], unreachable: [] });
    let network = 0;
    for (const id of people) {
      if (fw.sent.includes(id) || fw.unreachable.includes(id)) continue;
      const r = await old("sendMessage", { chat_id: id, text: FAREWELL(name), disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: `Открыть @${name}`, url: `https://t.me/${name}?start=move` }]] } });
      if (r.ok) fw.sent.push(id); else if (unreachable(r)) fw.unreachable.push(id); else network++;
      await saveState(st); // после каждого человека: если скрипт оборвётся, второй раз ему не уйдёт
      await sleep(150);
    }
    say(`Прощальное сообщение от @${meOld.result.username}: доставлено ${fw.sent.length} из ${people.length}.`);
    if (fw.unreachable.length) say(`  Прежний бот не может писать (не нажимали Start или заблокировали): ${fw.unreachable.join(", ")}`);
    if (network) { say(`  Не ушло из-за сети: ${network}. Запустите этот шаг ещё раз — досылается только им.`); return 2; }
    // Никому не дошло (например, Telegram отклонил само сообщение) — прежний бот не отключается: сначала разобраться.
    if (people.length && !fw.sent.length) { say("  Сообщение не дошло никому — прежний бот не отключён."); return 2; }
    // Прежний бот отключается от Doodle: кнопка приложения снята (общая и у каждого чата), в описании — ссылка.
    const m = await old("setChatMenuButton", { menu_button: { type: "commands" } });
    for (const id of people) await old("setChatMenuButton", { chat_id: id, menu_button: { type: "commands" } });
    const d1 = await old("setMyDescription", { description: OLD_DESCRIPTION(name) });
    const d2 = await old("setMyShortDescription", { short_description: OLD_DESCRIPTION(name) });
    const off = m.ok && d1.ok && d2.ok;
    say(`  Прежний бот: кнопка приложения ${m.ok ? "снята" : "НЕ снята (" + m.description + ")"}, описание ${d1.ok && d2.ok ? "заменено ссылкой" : "НЕ заменено (" + (d1.description || d2.description) + ")"}.`);
    if (off) { fw.doneAt = Date.now(); await saveState(st); }
    return off ? 0 : 2;
  }

  // check и go: новый токен ещё лежит в bot-token-new.txt, основной бот — прежний.
  if (!existsSync(at("bot-token-new.txt"))) { say("Нет файла bot-token-new.txt — положите в него токен нового бота из BotFather (одной строкой)."); return 1; }
  const meNew = await bots.call("getMe", {}, { bot: "new" });
  const meOld = await bots.call("getMe", {});
  if (!meNew.ok) { say(`Новый бот не отвечает: ${meNew.description}. Проверьте токен в bot-token-new.txt.`); return 1; }
  if (!meOld.ok) { say(`Прежний бот не отвечает: ${meOld.description}.`); return 1; }
  const name = meNew.result.username, oldName = meOld.result.username;
  if (meNew.result.id === meOld.result.id) { say("В bot-token-new.txt лежит токен того же бота, что и сейчас. Нужен токен НОВОГО бота."); return 1; }
  say(`Прежний бот: @${oldName}. Новый бот: @${name} («${meNew.result.first_name}»).`);
  say(`Людей, которым уйдёт прощальное сообщение: ${people.length}. Адрес приложения: ${appUrl || "неизвестен (туннель не поднят)"}.`);
  // У кого на сервере уже есть копия личных данных приложения (свои дедлайны, задачи): без неё они в новом боте пропадут.
  const noCopy = people.filter((id) => !existsSync(join(APP, "cloud", `${id}.json`)));
  say(`Копия личных данных есть у ${people.length - noCopy.length} из ${people.length}${noCopy.length ? "; нет у: " + noCopy.join(", ") : ""}.`);
  if (mode !== "go") { say("\nЭто была проверка. Переезд: node ops\\bot-move.mjs go"); return 0; }
  if (!appUrl) { say("Адрес приложения неизвестен — сначала должен работать туннель."); return 1; }
  if (existsSync(at("bot-token-prev.txt"))) { say("Файл bot-token-prev.txt уже есть (остался от прошлого переезда) — уберите или переименуйте его и запустите снова."); return 1; }

  // 1. Новый бот: описание, команды, кнопка приложения. Людям ничего не отправляется.
  const neu = (method, body) => bots.call(method, body, { bot: "new" });
  const steps = [
    ["описание", await neu("setMyDescription", { description: welcome.DESCRIPTION })],
    ["короткое описание", await neu("setMyShortDescription", { short_description: welcome.SHORT_DESCRIPTION })],
    ["команды", await neu("setMyCommands", { commands: [{ command: "start", description: "Приветствие и кнопка приложения" }, { command: "help", description: "Как войти и что умеет Doodle" }] })],
    ["кнопка приложения", await neu("setChatMenuButton", { menu_button: { type: "web_app", text: "Doodle", web_app: { url: appUrl } } })],
  ];
  for (const [what, r] of steps) say(`  новый бот — ${what}: ${r.ok ? "поставлено" : "НЕ поставлено (" + r.description + ")"}`);
  if (steps.some(([, r]) => !r.ok)) { say("Новый бот настроен не полностью — переезд остановлен, ничего не изменено."); return 1; }

  // 2. Токены меняются местами; сообщения новому боту будет получать сервер. Если вторая замена не удалась — первая возвращается.
  await rename(at("bot-token.txt"), at("bot-token-prev.txt"));
  try { await rename(at("bot-token-new.txt"), at("bot-token.txt")); }
  catch (e) { await rename(at("bot-token-prev.txt"), at("bot-token.txt")); say(`Не удалось заменить файл токена (${e.message}) — всё возвращено как было.`); return 1; }
  if (existsSync(at("bot-updates.off"))) await rename(at("bot-updates.off"), at("bot-updates.on")); else await writeFile(at("bot-updates.on"), "");
  await saveState({ ...(await loadState()), oldBot: oldName, newBot: name, swappedAt: Date.now(), rolledBackAt: null });
  say(`\nГотово: сервер после перезапуска будет работать с @${name}. Прежний токен — в bot-token-prev.txt.`);
  say("Дальше: перезапустить сервер, проверить нового бота, затем node ops\\bot-move.mjs farewell.");
  return 0;
}
process.exitCode = await main();
