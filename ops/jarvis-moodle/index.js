// Плагин OpenClaw «jarvis-moodle»: команда /deadlines отвечает сама, без модели и без подтверждений.
// Только чтение Moodle (задания активных курсов и статус сдачи). Прикрепление и отправка отчётов
// сюда намеренно не входят: они остаются в навыке moodle-student и требуют подтверждения.
// Токен Moodle читается из ~/.openclaw/moodle-token.txt и никуда не выводится.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "https://newlms.misis.ru";
const CACHE_MS = 5 * 60 * 1000;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const readText = (p) => readFile(p, "utf8").then((t) => t.trim()).catch(() => "");

// Сеть МИСИС (1 окт 2026): около половины новых соединений не устанавливаются, результат зависит от порта — новая попытка
// обычно проходит. Повторяем сетевые ошибки и таймауты (ошибки Moodle — сразу), а параллельные запросы (статусы всех
// заданий) пускаем не больше трёх разом: тогда они едут по уже открытым keep-alive-соединениям, а не по 30 новым.
async function retry(fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const network = e.message === "fetch failed" || e.name === "TimeoutError" || e.name === "AbortError";
      if (!network) throw e;
      if (i >= 5) throw new Error("Moodle не отвечает (сеть МИСИС), попробуйте через минуту");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
const LIMIT = 3;
let running = 0;
const queue = [];
async function limited(fn) {
  if (running >= LIMIT) await new Promise((r) => queue.push(r));
  running++;
  try { return await fn(); }
  finally { running--; const next = queue.shift(); if (next) next(); }
}

async function call(token, fn, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json", ...params });
  return limited(() => retry(async () => {
    const res = await fetch(`${BASE}/webservice/rest/server.php`, { method: "POST", body, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => { throw new Error(`Moodle ответил не данными (HTTP ${res.status})`); });
    if (data && data.exception) throw new Error(`${data.errorcode}: ${data.message}`);
    return data;
  }));
}

const shortCourse = (name) => name.replace(/\.\s.*$/, "").replace(/\s+(Весна|Осень)\s+\d{4}.*$/, "").trim();
const shortName = (name) => { const s = name.split(/\.\s/)[0]; return s.length > 70 ? s.slice(0, 67) + "…" : s; };

const htmlToText = (h = "") => h
  .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/\n{3,}/g, "\n\n").trim();

async function moodleToken() {
  const token = await readText(join(homedir(), ".openclaw", "moodle-token.txt"));
  if (!token) throw new Error("на ПК нет токена Moodle");
  return token;
}

// Все задания активных курсов в сыром виде Moodle.
async function rawAssignments(token) {
  const active = (await readText(join(homedir(), "moodle-work", "active-courses.txt")))
    .split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  const info = await call(token, "core_webservice_get_site_info");
  let courses = await call(token, "core_enrol_get_users_courses", { userid: info.userid });
  if (active.length) courses = courses.filter((c) => active.includes(c.id));
  const p = {};
  courses.forEach((c, i) => (p[`courseids[${i}]`] = c.id));
  const r = courses.length ? await call(token, "mod_assign_get_assignments", p) : { courses: [] };
  return r.courses.flatMap((c) => c.assignments.map((a) => ({ course: c.fullname, a })));
}

async function loadAssignments() {
  const token = await moodleToken();
  const r = { courses: [] };
  for (const { course, a } of await rawAssignments(token)) {
    let c = r.courses.find((x) => x.fullname === course);
    if (!c) r.courses.push((c = { fullname: course, assignments: [] }));
    c.assignments.push(a);
  }
  const now = Date.now() / 1000;
  const list = r.courses.flatMap((c) => c.assignments
    .filter((a) => a.duedate && a.duedate > now - 3 * 86400)
    .map((a) => ({ id: a.id, name: a.name, course: shortCourse(c.fullname), due: a.duedate })));
  await Promise.all(list.map(async (x) => {
    try {
      const s = await call(token, "mod_assign_get_submission_status", { assignid: x.id });
      x.status = s.lastattempt?.submission?.status ?? "none";
      x.graded = s.feedback?.grade?.grade != null;
    } catch { x.status = "unknown"; }
  }));
  return list.sort((a, b) => a.due - b.due);
}

let cache = null, cacheAt = 0, pending = null;
async function assignments(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  pending ??= loadAssignments().then((d) => { cache = d; cacheAt = Date.now(); return d; }).finally(() => { pending = null; });
  return pending;
}

function msk(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
}
function left(ts) {
  const s = ts - Date.now() / 1000;
  if (s <= 0) return "просрочено";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${Math.max(m, 1)} мин`;
}
const STATUS = { new: "не сдано", none: "не сдано", draft: "черновик", submitted: "отправлено", unknown: "статус неизвестен" };

function format(list, days) {
  const now = Date.now() / 1000, until = now + days * 86400;
  const open = list.filter((x) => x.status !== "submitted" && !x.graded && x.due <= until);
  const done = list.filter((x) => (x.status === "submitted" || x.graded) && x.due > now && x.due <= until).length;
  const t = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
  const lines = [`📚 Дедлайны на ${days} дн. (на ${t} МСК)`, ""];
  if (!open.length) lines.push("Несданных заданий в этот срок нет ✅");
  for (const x of open) {
    const s = x.due - now;
    const mark = s <= 0 ? "⛔" : s < 86400 ? "🔴" : s < 3 * 86400 ? "🟠" : s < 7 * 86400 ? "🟡" : "⚪";
    lines.push(`${mark} ${shortName(x.name)} — ${x.course}`, `     до ${msk(x.due)} · ${left(x.due)} · ${STATUS[x.status] || x.status}`);
  }
  if (done) lines.push("", `Уже отправлено в этот срок: ${done}`);
  const later = list.filter((x) => x.status !== "submitted" && !x.graded && x.due > until).length;
  if (later) lines.push(`Дальше ${days} дн. ещё ${later}: /deadlines ${days >= 30 ? 90 : 30}`);
  return lines.join("\n");
}

// Остальное чтение для инструмента moodle_read (модель вызывает его вместо Bash, поэтому без подтверждений).
async function listAssignments(filter = "") {
  const f = filter.toLowerCase();
  const rows = (await rawAssignments(await moodleToken()))
    .filter(({ course, a }) => !f || `${course} ${a.name}`.toLowerCase().includes(f))
    .sort((x, y) => (x.a.duedate || 9e9) - (y.a.duedate || 9e9))
    .map(({ course, a }) => `id=${a.id} | ${a.duedate ? msk(a.duedate) : "без срока"} | ${shortCourse(course)} | ${a.name}`);
  return rows.length ? rows.join("\n") : "Заданий не найдено.";
}

async function details(id) {
  const token = await moodleToken();
  const found = (await rawAssignments(token)).find(({ a }) => String(a.id) === String(id));
  if (!found) return `Задание id=${id} не найдено в активных курсах.`;
  const { course, a } = found;
  const cfg = (a.configs || []).filter((x) => ["maxfilesubmissions", "filetypeslist", "maxsubmissionsizebytes"].includes(x.name))
    .map((x) => `${x.name}=${x.value}`);
  const files = (a.introattachments || []).map((f) => f.filename);
  return [`Курс: ${course}`, `Задание: ${a.name} (id=${a.id})`, `Срок: ${a.duedate ? msk(a.duedate) : "без срока"}`,
    cfg.length ? `Ограничения на файлы: ${cfg.join(", ")}` : "", files.length ? `Вложения: ${files.join(", ")}` : "",
    "", "Условие:", htmlToText(a.intro).slice(0, 6000)].filter((x) => x !== "").join("\n");
}

async function status(id) {
  const s = await call(await moodleToken(), "mod_assign_get_submission_status", { assignid: id });
  const sub = s.lastattempt?.submission;
  const files = (sub?.plugins || []).flatMap((pl) => (pl.fileareas || []).flatMap((fa) => (fa.files || []).map((f) => f.filename)));
  return [`Статус ответа: ${STATUS[sub?.status ?? "none"] || sub?.status}`, `Оценивание: ${s.lastattempt?.gradingstatus ?? "?"}`,
    files.length ? `Прикреплено: ${files.join(", ")}` : "Файлов не прикреплено", s.feedback?.grade ? `Оценка: ${s.feedback.grade.grade}` : ""]
    .filter(Boolean).join("\n");
}

export default {
  id: "jarvis-moodle",
  name: "Jarvis Moodle",
  description: "Мгновенные дедлайны Moodle МИСИС по команде /deadlines (только чтение)",
  get configSchema() {
    return {
      safeParse: (v) => (v === undefined || (v && typeof v === "object" && !Array.isArray(v)) ? { success: true, data: v } : { success: false, error: { issues: [{ path: [], message: "expected config object" }] } }),
      jsonSchema: { type: "object", additionalProperties: true },
    };
  },
  register(api) {
    api.registerTool({
      name: "moodle_read",
      label: "Moodle (чтение)",
      description: "Только чтение Moodle МИСИС владельца: deadlines (несданные задания на N дней), assignments (список заданий с id, фильтр по слову), details (условие задания по id), status (что прикреплено и статус по id). Используй его для любых вопросов о дедлайнах и заданиях вместо Bash и навыка moodle-student. Ничего не прикрепляет и не отправляет.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["deadlines", "assignments", "details", "status"] },
          days: { type: "number", description: "Для deadlines: сколько дней вперёд, по умолчанию 14" },
          filter: { type: "string", description: "Для assignments: слово из названия курса или задания" },
          id: { type: "number", description: "Для details и status: id задания" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        let text;
        try {
          if (params.action === "deadlines") text = format(await assignments(false), Math.min(Math.max(Number(params.days) || 14, 1), 180));
          else if (params.action === "assignments") text = await listAssignments(params.filter || "");
          else if (params.action === "details") text = params.id ? await details(params.id) : "Нужен id задания.";
          else if (params.action === "status") text = params.id ? await status(params.id) : "Нужен id задания.";
          else text = "Неизвестное действие.";
        } catch (e) {
          text = `Ошибка Moodle: ${e.message}`;
        }
        return { content: [{ type: "text", text }] };
      },
    });
    api.registerCommand({
      name: "deadlines",
      description: "Ближайшие дедлайны Moodle",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        if (ctx.senderIsOwner === false) return { text: "Эта команда доступна только владельцу бота." };
        const tokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
        const force = tokens.some((x) => /^(обнови|refresh|!)$/i.test(x));
        const n = Number(tokens.find((x) => /^\d+$/.test(x)));
        const days = Number.isFinite(n) && n > 0 ? Math.min(n, 180) : 14;
        try {
          return { text: format(await assignments(force), days) };
        } catch (e) {
          return { text: `Не удалось получить дедлайны из Moodle: ${e.message}\nПК включён? Moodle открывается только через домашний VPN.` };
        }
      },
    });
  },
};
