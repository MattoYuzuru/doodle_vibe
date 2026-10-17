// Проверка постоянного адреса Mini App (APP_URL) в tunnel-url.mjs — без настоящего Telegram.
// Модули копируются во временную папку с фальшивым токеном, fetch подменяется: ни один запрос не уходит в сеть.
// Запуск: node ops/stand/tunnel-url-test.mjs
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = await mkdtemp(join(tmpdir(), "tunnel-url-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фальшивый Telegram: кнопка меню по умолчанию и у каждого чата (туннельный сервер ставил её каждому лично).
const OLD = "https://old.trycloudflare.com/";
const menu = { default: OLD, 111: OLD, 222: OLD, 945210206: OLD };
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  assert.ok(u.startsWith("https://api.telegram.org/botFAKE:TOKEN/"), `запрос не туда: ${u}`);
  const method = u.split("/").pop();
  const body = JSON.parse(init?.body || "{}");
  calls.push({ method, body });
  const key = body.chat_id ?? "default";
  let result = true;
  if (method === "getChatMenuButton") result = { type: "web_app", text: "Doodle", web_app: { url: menu[key] ?? menu.default } };
  if (method === "setChatMenuButton") menu[key] = body.menu_button.web_app.url;
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
};

try {
  for (const f of ["tunnel-url.mjs", "bots.mjs"]) await copyFile(join(APP, f), join(dir, f));
  await writeFile(join(dir, "bot-token.txt"), "FAKE:TOKEN");
  await writeFile(join(dir, "bot-updates.on"), ""); // свой бот — без запасного пути через OpenClaw
  await mkdir(join(dir, "users"));
  for (const id of ["111", "222"]) await writeFile(join(dir, "users", `${id}.json`), "{}");
  // tunnel.log со старым адресом: при APP_URL он должен игнорироваться.
  await writeFile(join(dir, "tunnel.log"), "|  https://stale-tunnel.trycloudflare.com  |\n");
  await writeFile(join(dir, "current-url.txt"), "https://old.trycloudflare.com\n");

  process.env.APP_URL = "https://doodle.example.org/";
  process.env.TUNNEL_TICK_MS = "200";
  const { watchTunnelUrl } = await import(pathToFileURL(join(dir, "tunnel-url.mjs")).href);
  watchTunnelUrl();
  await sleep(800);

  const want = "https://doodle.example.org";
  assert.equal((await readFile(join(dir, "current-url.txt"), "utf8")).trim(), want, "current-url.txt = APP_URL без слэша");
  for (const k of ["default", 111, 222, 945210206]) assert.equal(menu[k], want, `кнопка меню (${k}) на постоянном адресе`);
  assert.ok(!Object.values(menu).some((u) => /stale-tunnel/.test(u)), "адрес из tunnel.log не использован");
  const notes = calls.filter((c) => c.method === "sendMessage");
  assert.equal(notes.length, 1, "владельцу одно сообщение о новом адресе");
  assert.match(notes[0].body.text, /Постоянный адрес Doodle: https:\/\/doodle\.example\.org/);

  // Следующие тики ничего не меняют и владельцу не пишут.
  const before = calls.length;
  await sleep(600);
  assert.ok(!calls.slice(before).some((c) => c.method === "setChatMenuButton" || c.method === "sendMessage"), "повторных правок и сообщений нет");
  console.log("tunnel-url (APP_URL): все проверки прошли");
} catch (e) {
  console.error(`ПРОВАЛ: ${e.message}`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
