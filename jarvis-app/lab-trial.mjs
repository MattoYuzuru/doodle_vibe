// Пробный отчёт для новых пользователей (16 окт 2026, решение владельца). Кто не в белом списке и ни разу не делал отчётов
// с агентом, может сделать ОДИН отчёт по одной работе; после этого другие работы закрыты, пока владелец не даст доступ.
// Пробная лаба целиком идёт на более сильной модели (по умолчанию Opus 5.5) — первый отчёт должен получиться; остальные
// лабы, проверка отчёта и окружение — на обычной модели агента. Расход пробной лабы ограничен (budgetMTok, токены с весом
// usage.mjs): без предела чат пробной лабы позволял бы просить «пересобери на другое ФИО» сколько угодно раз.
//
// Защита от второго аккаунта (просьба владельца «один аккаунт — один отчёт»). Учёт — отдельный файл lab-trials.json (не
// записи пользователей: удалённая лаба, выход и вход, перенос папок его не меняют), с двумя ключами: Telegram id и номер
// учётной записи Moodle МИСИС (moodleUserId — сервер получает его при входе; без входа отчёт не запустить). Пробный не дают,
// если по любому из ключей он уже был, или у этого Telegram есть история лаб (файлы jobs/, checks/, расход в журналах).
// При первом запуске учёт заполняется всеми, у кого уже есть история: их Telegram и Moodle сразу помечены «уже пользовался».
// Остаётся одна лазейка: войти под ЧУЖИМ логином Moodle — но тогда тратится пробный хозяина этой учётки, а не лишний.
//
// Настройка — lab-trial.json рядом с сервером (необязательный): { "enabled": true, "model": "claude-cli/claude-opus-5-5",
// "budgetMTok": 6 }. model: null — обычная модель агента. Префикс claude-cli/ обязателен: с anthropic/ OpenClaw ведёт ход
// встроенным клиентом, и Anthropic отвечает claude_code_version_too_old (проверено 16 окт). Модель запоминается в пробной
// лабе при её начале — смена настройки на начатые лабы не влияет.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateReadError, readJson, writeJsonAtomic } from "./state-file.mjs";
import * as usage from "./usage.mjs";
import { OWNER_ID, knownUserIds, labsAllowed, moodleUserIdOf } from "./users.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
// Пути — переменными только для тестов (копия сервера во временной папке).
const LEDGER = process.env.LAB_TRIAL_LEDGER || join(DIR, "lab-trials.json");
const CONFIG = process.env.LAB_TRIAL_CONFIG || join(DIR, "lab-trial.json");
const JOBS = join(DIR, "jobs"), CHECKS = join(DIR, "checks");
const DEFAULTS = { enabled: true, model: "claude-cli/claude-opus-5-5", budgetMTok: 6 };

/** Настройка пробного отчёта. Нечитаемый или испорченный файл — пробные не выдаются (безопасная сторона), начатые идут. */
export async function config() {
  let c;
  try { c = await readJson(CONFIG, { missing: {}, corrupt: "throw" }); }
  catch (e) { console.error(`lab-trial: ${CONFIG} не читается — новые пробные отчёты не выдаются (${e.message || e})`); return { ...DEFAULTS, enabled: false }; }
  const budget = Number(c.budgetMTok);
  return {
    enabled: c.enabled !== false,
    model: c.model === null ? null : typeof c.model === "string" && c.model.trim() ? c.model.trim() : DEFAULTS.model,
    budgetMTok: Number.isFinite(budget) && budget > 0 ? budget : DEFAULTS.budgetMTok,
  };
}

/*
 * Файл учёта: { v, seededAt, trials: { "<tgId>": { id, at, mu, title, model, closedAt? } },
 * used: { tg: { "<tgId>": причина }, mu: { "<moodleUserId>": "<tgId или причина>" } } }.
 * В памяти один объект; все изменения — по одной общей очереди (две учётки Telegram одного человека не должны занять
 * пробный одновременно). Не прочитался — StateReadError (424): «учёта нет» вслепую раздало бы пробные заново.
 */
let ledger = null, loading = null, queue = Promise.resolve();
const marked = new Set(), markFailedAt = new Map(); // markFull из stateOf: уже отмеченные ("<tg>:<mu>") и когда отметка не удалась
const blank = () => ({ v: 1, seededAt: null, trials: {}, used: { tg: {}, mu: {} } });

/** Есть ли у этого Telegram история лаб с агентом (до пробного): файлы заданий и проверок или расход в журналах. */
async function historyOf(tgId) {
  const re = new RegExp(`^${Number(tgId)}-\\d+\\.json(\\.bad-.+)?$`); // имя задания — как keyOf в lab.mjs (<tgId>-<id>)
  for (const d of [JOBS, CHECKS]) {
    let names;
    try { names = await readdir(d); }
    catch (e) { if (e?.code === "ENOENT") continue; throw new StateReadError(d, e); } // непрочитанная папка ≠ «истории нет»
    if (names.some((n) => re.test(n))) return true;
  }
  return (await usage.byLab()).some((l) => l.tgId === Number(tgId));
}

/**
 * Первое заполнение: все, у кого уже есть история (или полный доступ), — «уже пользовался», по Telegram и по Moodle.
 * Признак истории здесь шире обычного: ещё и папка лаб человека (moodle-work\users\<tgId>) — на случай, если папку jobs/
 * при переносе на другой ПК ещё не скопировали. В обычной проверке её нет: папку создаёт подготовка инструкции ещё до
 * занятия пробного, и сбой на этом шаге отнял бы пробный у нового пользователя.
 */
async function seed() {
  const l = blank();
  for (const tgId of await knownUserIds()) {
    const owner = tgId === OWNER_ID, full = owner || (await labsAllowed(tgId));
    const hist = (await historyOf(tgId)) || existsSync(join(homedir(), "moodle-work", "users", String(tgId)));
    if (!owner && !full && !hist) continue;
    l.used.tg[tgId] = owner ? "owner" : hist ? "history" : "full";
    const mu = await moodleUserIdOf(tgId);
    if (mu) l.used.mu[mu] = String(tgId);
  }
  l.seededAt = Date.now();
  await writeJsonAtomic(LEDGER, l, { space: 1 });
  return l;
}

async function load() {
  if (ledger) return ledger;
  loading ??= (async () => {
    const l = await readJson(LEDGER, { missing: null, corrupt: "throw" });
    ledger = l ? { ...blank(), ...l, used: { tg: {}, mu: {}, ...l.used } } : await seed();
    return ledger;
  })().finally(() => { loading = null; });
  return loading;
}
/** Изменение учёта по общей очереди: fn правит копию, запись удалась — копия становится учётом (не удалась — всё как было). */
function change(fn) {
  const run = async () => {
    const next = structuredClone(await load());
    const out = await fn(next);
    if (out === false) return false;
    await writeJsonAtomic(LEDGER, next, { space: 1 });
    ledger = next;
    return true;
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

/**
 * Состояние пользователя: via "full" — владелец или белый список; "trial" — у него пробная лаба (trial = запись);
 * offer — пробный ему положен и ещё не занят; иначе reason — код для клиента.
 */
export async function stateOf(tgId) {
  tgId = Number(tgId);
  if (tgId === OWNER_ID) return { via: "full" };
  if (await labsAllowed(tgId)) {
    // Полный доступ — «уже пользовался» по Telegram и Moodle при любом обращении к лабам (а не только при запуске лабы):
    // иначе «Исправить» и «Проверить отчёт» с полным доступом не оставляли следа, и учётка Moodle потом получала
    // пробный со второго Telegram. Отмеченных помним в памяти; не вышло (учёт не читается) — повтор через 10 минут,
    // а не на каждом опросе лаб (иначе каждый запрос перечитывал бы испорченный файл и писал ошибку в журнал).
    const mu = await moodleUserIdOf(tgId).catch(() => null);
    const key = `${tgId}:${mu ?? ""}`;
    if (!marked.has(key) && Date.now() - (markFailedAt.get(tgId) || 0) > 10 * 60e3) {
      marked.add(key);
      void markFull(tgId).catch((e) => { marked.delete(key); markFailedAt.set(tgId, Date.now()); console.error(`lab-trial ${tgId}: отметка полного доступа не записана — ${e.message || e}`); });
    }
    return { via: "full" };
  }
  const l = await load();
  const t = l.trials[tgId];
  const mu = await moodleUserIdOf(tgId);
  if (t) {
    if (t.closedAt) return { via: null, trial: t, reason: "labs_not_allowed" };
    // Пробный привязан и к учётке Moodle: под другой (одногруппника) вести его нельзя — attach и submit ушли бы в чужой Moodle.
    if (t.mu && mu && t.mu !== mu) return { via: null, trial: t, reason: "trial_other_account" };
    return { via: "trial", trial: t };
  }
  if (!mu) return { via: null, reason: "labs_not_allowed" }; // не вошёл в Moodle — предлагать нечего (и сверить учётку не с чем)
  if (l.used.tg[tgId] || l.used.mu[mu] || Object.values(l.trials).some((x) => x.mu === mu)) return { via: null, reason: "labs_not_allowed" };
  if (!(await config()).enabled) return { via: null, reason: "labs_not_allowed" };
  if (await historyOf(tgId)) return { via: null, reason: "labs_not_allowed" };
  return { via: null, offer: true };
}

/**
 * Можно ли работать с лабой id: allowed — открыть и вести (полный доступ или своя пробная); claim — эту работу можно
 * начать как пробную (GET отдаёт пустую лабу, start займёт пробный). Остальное — 403 с кодом reason.
 */
export async function access(tgId, id) {
  const s = await stateOf(tgId);
  if (s.via === "full") return { allowed: true, via: "full" };
  if (s.via === "trial") return s.trial.id === String(id) ? { allowed: true, via: "trial", trial: s.trial } : { allowed: false, reason: "trial_used", trial: s.trial };
  if (s.offer) return { allowed: false, claim: true };
  return { allowed: false, reason: s.reason || "labs_not_allowed", trial: s.trial || null };
}

/** Занять пробный за работой id (из lab.startJob, внутри очереди пользователя). Повторная проверка — уже под общей очередью. */
export async function claim(tgId, id, { title = "" } = {}) {
  tgId = Number(tgId);
  const cfg = await config();
  let record = null;
  await change(async (l) => {
    const mu = await moodleUserIdOf(tgId);
    const ok = cfg.enabled && mu && !l.trials[tgId] && !l.used.tg[tgId] && !l.used.mu[mu] && !Object.values(l.trials).some((x) => x.mu === mu) && !(await historyOf(tgId));
    if (!ok) throw Object.assign(new Error("trial_used"), { status: 403 });
    record = l.trials[tgId] = { id: String(id), at: Date.now(), mu, title: String(title || "").slice(0, 200), model: cfg.model };
  });
  return record;
}

/** Человек начал лабу с полным доступом: его Telegram и Moodle — «уже пользовался» (на случай, если доступ потом закроют). */
export async function markFull(tgId) {
  tgId = Number(tgId);
  if (tgId === OWNER_ID) return;
  const l = await load();
  const mu = await moodleUserIdOf(tgId);
  if (l.used.tg[tgId] && (!mu || l.used.mu[mu])) return;
  await change((n) => {
    if (n.used.tg[tgId] && (!mu || n.used.mu[mu])) return false; // пока ждали очереди, отметку уже поставили — не переписывать файл
    n.used.tg[tgId] ??= "full"; if (mu) n.used.mu[mu] ??= String(tgId);
  });
}

/**
 * Владелец закрывает пробный (экран «Доступ к отчётам»): и неначатый, и идущий — дальше только по белому списку.
 * Помечается и учётка Moodle (ревью 16 окт): иначе со второго Telegram с тем же логином Moodle неначатый закрытый
 * пробный выдавался заново.
 */
export async function close(tgId) {
  tgId = Number(tgId);
  return change(async (l) => {
    const mu = await moodleUserIdOf(tgId);
    const t = l.trials[tgId];
    if (t) { if (t.closedAt) return false; t.closedAt = Date.now(); if (mu) l.used.mu[mu] ??= String(tgId); return; }
    if (l.used.tg[tgId] && (!mu || l.used.mu[mu])) return false;
    l.used.tg[tgId] ??= "closed";
    if (mu) l.used.mu[mu] ??= String(tgId);
  });
}

/** Пробная ли это лаба: id → запись пробного этого пользователя (или null). Для учёта расхода у владельца. */
export async function trialOf(tgId, id) {
  const t = (await load()).trials[Number(tgId)];
  return t && t.id === String(id) ? t : null;
}
/** Все пробные лабы — для экрана расхода: ключ "<tgId>:<id>". */
export async function trialKeys() {
  return new Set(Object.entries((await load()).trials).map(([tg, t]) => `${tg}:${t.id}`));
}

/** Сколько осталось от предела расхода пробной лабы (токены с весом) и сам предел. */
export async function budget(tgId, id) {
  const limit = Math.round((await config()).budgetMTok * 1e6);
  const used = (await usage.byLab()).find((l) => l.tgId === Number(tgId) && String(l.id) === String(id))?.tok || 0;
  return { limit, used, left: limit - used };
}
/**
 * Проверка перед ходом агента в пробной лабе: предел исчерпан — понятная ошибка. Владелец потом открыл полный доступ —
 * предела у этой лабы больше нет (модель остаётся прежней: другая модель в той же сессии перечитала бы всё без кэша).
 */
export async function guard(tgId, id) {
  if ((await stateOf(tgId)).via === "full") return;
  const b = await budget(tgId, id);
  if (b.left > 0) return;
  throw Object.assign(new Error("Пробный отчёт исчерпан: на него ушёл весь отведённый расход агента. Готовый отчёт можно прикрепить и отправить. Чтобы делать отчёты дальше, запросите доступ к отчётам."), { status: 403 });
}

/** Что показать в профиле: "available" — пробный положен; { id, title, at } — пробная лаба; null — полный доступ или не положен. */
export async function view(tgId) {
  const s = await stateOf(tgId);
  if (s.via === "full") return null;
  if (s.offer) return "available";
  if (s.trial) return { id: s.trial.id, title: s.trial.title || null, at: s.trial.at, closed: !!s.trial.closedAt, otherAccount: s.reason === "trial_other_account" };
  return null;
}
/** Для экрана владельца: tgId → "available" | { id, title, at, closed } | "used" (история или закрыт) | null. */
export async function ownerView(tgIds) {
  const out = {};
  for (const id of tgIds) {
    try { out[id] = await view(id) ?? ((await load()).used.tg[id] ? "used" : null); }
    catch { out[id] = null; }
  }
  return out;
}
