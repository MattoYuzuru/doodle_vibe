// Ограничение частоты запросов (просьба владельца «начнём с защиты», 4 окт 2026). Счётчики в памяти: ключ (пользователь
// Telegram, адрес клиента, вид действия) → сколько раз за текущее окно времени. Отдельной программы и базы не нужно:
// пользователей немного, а цель — чтобы один зациклившийся клиент или настойчивый посторонний не занял сервер и не
// заставил его засыпать запросами Moodle с домашнего адреса. От настоящей сетевой атаки это не защита — её гасит то,
// что стоит перед сервером (туннель).
const buckets = new Map(); // ключ → { n, until }
const MAX_KEYS = 100000;

/**
 * Отметить обращение. Возвращает null, если предел не превышен, иначе { wait — через сколько секунд окно закончится,
 * first — это первое превышение в окне (для одной строки в журнале, а не тысячи) }.
 */
export function hit(key, max, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (!b || now >= b.until) {
    if (buckets.size >= MAX_KEYS) { sweep(now); if (buckets.size >= MAX_KEYS) buckets.clear(); } // память важнее счётчиков
    b = { n: 0, until: now + windowMs };
    buckets.set(key, b);
  }
  b.n++;
  return b.n <= max ? null : { wait: Math.max(1, Math.ceil((b.until - now) / 1000)), first: b.n === max + 1 };
}
/** Сколько обращений уже отмечено в текущем окне (без новой отметки). */
export function count(key, now = Date.now()) {
  const b = buckets.get(key);
  return b && now < b.until ? b.n : 0;
}
export function sweep(now = Date.now()) { for (const [k, b] of buckets) if (now >= b.until) buckets.delete(k); }
export const size = () => buckets.size;
setInterval(sweep, 60e3).unref();

/**
 * Адрес клиента — для счётчиков по адресу. Сервер слушает только 127.0.0.1, а снаружи запросы приходят через туннель
 * на этом же ПК, поэтому адрес соединения всегда местный; настоящий адрес туннель кладёт в заголовок: Cloudflare —
 * cf-connecting-ip (клиент подделать не может), остальные — последним значением X-Forwarded-For (первое значение
 * присылает сам клиент). Заголовков нет — запрос с этого же ПК («local»: сторож, стенд).
 */
export function clientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf.slice(0, 64);
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1].slice(0, 64) : "local";
}
