// Проверка напоминания про главное мини-приложение в tunnel-url.mjs (19 окт 2026) — без настоящего Telegram.
// Быстрый туннель меняет адрес → владельцу «Новый адрес Doodle»; если у бота включено главное мини-приложение
// (getMe.has_main_web_app), в том же сообщении — подсказка обновить адрес в BotFather, иначе подсказки нет.
// Модули копируются во временную папку с фальшивым токеном, fetch подменяется: ни один запрос не уходит в сеть.
// Запуск: node ops/stand/tunnel-mainapp-test.mjs
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = await mkdtemp(join(tmpdir(), "tunnel-mainapp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const menu = { default: "https://old.trycloudflare.com/", 111: "https://old.trycloudflare.com/", 945210206: "https://old.trycloudflare.com/" };
let mainApp = false;
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  assert.ok(u.startsWith("https://api.telegram.org/botFAKE:TOKEN/"), `запрос не туда: ${u}`);
  const method = u.split("/").pop();
  const body = JSON.parse(init?.body || "{}");
  calls.push({ method, body });
  const key = body.chat_id ?? "default";
  let result = true;
  if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Doodle", has_main_web_app: mainApp };
  if (method === "getChatMenuButton") result = { type: "web_app", text: "Doodle", web_app: { url: menu[key] ?? menu.default } };
  if (method === "setChatMenuButton") menu[key] = body.menu_button.web_app.url;
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
};
const notes = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
const box = (u) => `|  ${u}  |\n`;

try {
  for (const f of ["tunnel-url.mjs", "bots.mjs"]) await copyFile(join(APP, f), join(dir, f));
  await writeFile(join(dir, "bot-token.txt"), "FAKE:TOKEN");
  await writeFile(join(dir, "bot-updates.on"), "");
  await mkdir(join(dir, "users"));
  await writeFile(join(dir, "users", "111.json"), "{}");
  await writeFile(join(dir, "current-url.txt"), "https://old.trycloudflare.com\n");
  await writeFile(join(dir, "tunnel.log"), box("https://first-one.trycloudflare.com"));

  delete process.env.APP_URL;
  process.env.TUNNEL_TICK_MS = "200";
  const { watchTunnelUrl } = await import(pathToFileURL(join(dir, "tunnel-url.mjs")).href);
  watchTunnelUrl();
  await sleep(800);

  // 1. Главного мини-приложения нет — обычное сообщение, без BotFather.
  assert.equal(notes().length, 1, "одно сообщение о первом новом адресе");
  assert.match(notes()[0], /Новый адрес Doodle .*: https:\/\/first-one\.trycloudflare\.com/);
  assert.doesNotMatch(notes()[0], /Configure Mini App/, "без главного мини-приложения подсказки нет");

  // 2. Владелец включил главное мини-приложение, туннель перезапустился — подсказка с новым адресом.
  mainApp = true;
  await appendFile(join(dir, "tunnel.log"), box("https://second-two.trycloudflare.com"));
  await sleep(800);
  assert.equal(notes().length, 2, "второе сообщение о втором адресе");
  assert.match(notes()[1], /second-two\.trycloudflare\.com/);
  assert.match(notes()[1], /Configure Mini App → Edit Mini App URL/, "подсказка обновить адрес в BotFather");

  // 3. Адрес не меняется — повторных сообщений нет.
  await sleep(600);
  assert.equal(notes().length, 2, "без смены адреса владельцу не пишем");
  console.log("tunnel-url (главное мини-приложение): все проверки прошли");
} catch (e) {
  console.error(`ПРОВАЛ: ${e.message}`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
