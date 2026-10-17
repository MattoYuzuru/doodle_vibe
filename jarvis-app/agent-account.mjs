// Агент лаб под отдельной учётной записью Windows (16 окт 2026, ops\migrate\УЧЁТКА-АГЕНТА.md). Сервер приложения
// работает под владельцем ПК, а Gateway OpenClaw и агент лаб — под обычным пользователем doodle-agent: папку приложения,
// ключи и профиль владельца агенту закрывает сама Windows, а не только правила и сторож.
//
// Для сервера от этого меняется немногое, и всё собрано здесь:
//   — журналы Claude CLI агента (расход, «что сейчас делает») и его настройки Claude Code (запись сторожа) лежат в
//     профиле doodle-agent, а не в домашней папке сервера;
//   — командных строк процессов чужой учётки сервер без прав администратора не видит (activity.mjs читает журнал);
//   — зависший Gateway перезапускает задача Планировщика от имени doodle-agent (gateway-watch.mjs);
//   — Docker Desktop у агента открыт на его экране заранее, сам агент его не запускает (правила лабы);
//   — общие файлы агента (замок замеров, wsl-users.json) — в moodle-work\agent-shared: в корень moodle-work агенту
//     писать нельзя (иначе он положил бы туда CLAUDE.md или .claude\settings.json для сеансов Claude Code владельца).
//
// Включается файлом agent-account.json рядом с сервером — его пишет ops\migrate\agent-account\1-права.ps1:
//   { "user": "doodle-agent", "home": "C:\\Users\\doodle-agent", "restartTask": "Doodle Gateway Restart" }
// Нет файла — агент под той же учётной записью, что и сервер (как на ноутбуке): всё по-старому.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AGENT_ACCOUNT_FILE || join(DIR, "agent-account.json"); // переменная — для проверок

function read() {
  let j;
  try { j = JSON.parse(readFileSync(FILE, "utf8").replace(/^\uFEFF/, "")); }
  catch (e) {
    if (e.code !== "ENOENT") console.log(`agent-account: ${FILE} не прочитан (${e.message}) — считаю, что агент под той же учётной записью`);
    return null;
  }
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  if (!str(j?.user) || !str(j?.home)) { console.log(`agent-account: в ${FILE} нет user или home — считаю, что агент под той же учётной записью`); return null; }
  return { user: str(j.user), home: str(j.home), restartTask: str(j.restartTask) || "Doodle Gateway Restart" };
}

/** Отдельная учётная запись агента { user, home, restartTask } или null — агент под той же учётной записью, что и сервер. */
export const AGENT = read();
/** Домашняя папка учётной записи, под которой работает агент. */
export const AGENT_HOME = process.env.AGENT_HOME || AGENT?.home || homedir();
// Claude CLI называет папку журналов по рабочей папке сессии: всё, кроме букв и цифр, заменяется на «-».
const projectDir = (ws) => join(AGENT_HOME, ".claude", "projects", join(AGENT_HOME, ".openclaw", ws).replace(/[^A-Za-z0-9]/g, "-"));
/** Журналы Claude CLI агента лаб (агент files) и главного агента OpenClaw (чат бота в Telegram). */
export const AGENT_TRANSCRIPTS = projectDir("workspace-files");
export const AGENT_CHAT_TRANSCRIPTS = projectDir("workspace");
/** Настройки Claude Code учётной записи агента: в них подключён сторож (ops\agent-guard\install.mjs). */
export const AGENT_SETTINGS = join(AGENT_HOME, ".claude", "settings.json");

// moodle-work — та же, что в lab.mjs: в домашней папке сервера (владельца ПК).
const WORK = join(homedir(), "moodle-work");
/** Общая папка агента moodle-work\agent-shared (её заводит 1-права.ps1) или null, если её нет. */
export const sharedDir = () => { const d = join(WORK, "agent-shared"); return existsSync(d) ? d : null; };
/**
 * Общий файл агентов (замки замеров, установок, снимков LTspice): в общей папке агента, а без неё — в корне moodle-work,
 * как было. То же правило — в assets\lt_shot.py и assets\wsl_lab.py.
 */
export const sharedFile = (name) => join(sharedDir() || WORK, name);
/** Файл-замок нагрузочных замеров (правила лабы и activity.mjs). */
export const measureLock = () => process.env.LAB_LOCK_FILE || sharedFile(".measure.lock");

const DOCKER_USER = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "DockerDesktop", "Docker Desktop.exe");
const DOCKER_ALL = join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
/**
 * Правило про запуск Docker Desktop для агента (lab-instruction.md, env-instruction.md: {{DOCKER_START}}). Под своей
 * учётной записью агент Docker не запускает: Docker Desktop открывается при входе doodle-agent в Windows. Иначе — путь,
 * где Docker на этом ПК стоит на самом деле (на ноутбуке — «для пользователя», на новом ПК — в Program Files).
 */
export function dockerRule() {
  if (AGENT) return "Docker Desktop на этом ПК запускается сам при входе в Windows и уже открыт на твоём экране. Если `docker info` не отвечает, подожди до двух минут и проверь снова; сам Docker Desktop не запускай, не перезапускай и его настройки не меняй. Не заработал — так и напиши в ответе и делай то, что можно без Docker.";
  const hint = "и подожди, пока `docker info` заработает (до двух минут). Другие пути не пробуй: запуск несуществующего файла открывает на экране владельца окно с ошибкой.";
  if (existsSync(DOCKER_USER) || !existsSync(DOCKER_ALL)) return `Docker на этом ПК стоит не в \`Program Files\`. Если \`docker info\` не отвечает, запусти \`${DOCKER_USER}\` ${hint}`;
  return `Если \`docker info\` не отвечает, запусти \`${DOCKER_ALL}\` ${hint}`;
}
