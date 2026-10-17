// Оценки преподавателей из приложения «Кампус» (campusapp.ru): у сайта открытый внутренний API, по которому работает
// его же страница /reviews/teachers — без входа. Ищем преподавателя по фамилии в НИТУ «МИСиС», берём рейтинг,
// критерии, теги и последние отзывы. Кэш на сутки по ФИО: страницы дедлайнов открываются часто, а оценки меняются редко.
const BASE = "https://campusapp.ru";
const ORG_MISIS = "5fb798fd0753d50006b98885";
const UA = "Mozilla/5.0 (Jarvis mini app; +https://t.me/Jarvis_kimmm_bot)";
const CACHE_MS = 24 * 3600 * 1000;
const cache = new Map(); // fullName → { at, data }

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`campus ${r.status}`);
  return r.json();
}

// Кириллица → латиница для адреса страницы (сайт открывает карточку по id, слаг — для читаемости ссылки).
const TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const slug = (name) => name.toLowerCase().split("").map((ch) => TR[ch] ?? (/[a-z0-9]/.test(ch) ? ch : "-")).join("").replace(/-+/g, "-").replace(/^-|-$/g, "");

/** «Колистратов Максим Васильевич» → ["колистратов", "м", "в"] */
const parts = (name) => name.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
function pick(items, fullName) {
  const [last, ...rest] = parts(fullName);
  const initials = rest.map((w) => w[0]).join("");
  const score = (t) => {
    const [l, ...r] = parts(t.name);
    if (l !== last) return 0;
    const ti = r.map((w) => w[0]).join("");
    if (r.join(" ") === rest.join(" ")) return 3; // полное совпадение
    if (ti && initials && (ti === initials || ti.startsWith(initials) || initials.startsWith(ti))) return 2; // по инициалам
    return 1; // только фамилия
  };
  return items.map((t) => ({ t, s: score(t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || (b.t.rating?.count || 0) - (a.t.rating?.count || 0))[0]?.t ?? null;
}

/** Карточка преподавателя из «Кампуса» или null, если не найден. Ошибки сети — тоже null (плитка просто без оценки). */
export async function teacher(fullName) {
  const key = fullName.trim().toLowerCase();
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c.data;
  let data = null;
  try {
    const last = parts(fullName)[0];
    const found = await get(`/api/next/teachers?search=${encodeURIComponent(last)}&organization=${ORG_MISIS}&limit=20`);
    const hit = pick(found.items || [], fullName);
    if (hit) {
      const [profile, reviews] = await Promise.all([
        get(`/api/next/teachers/${hit._id}`).catch(() => hit),
        get(`/api/next/teachers/${hit._id}/reviews?limit=5`).catch(() => ({ items: [] })),
      ]);
      const rating = profile.rating || hit.rating || {};
      data = {
        id: hit._id, name: profile.name || hit.name, url: `${BASE}/reviews/teachers/${slug(profile.name || hit.name)}-${hit._id}`,
        rating: { value: rating.value ?? null, weight: rating.weight ?? null, count: rating.count ?? 0 },
        criteria: (rating.criteria || []).map((x) => ({ title: x.title, value: x.value })),
        tags: (profile.tags || rating.tags || []).slice(0, 6).map((x) => ({ title: x.title, percentage: x.percentage })),
        reviews: (reviews.items || []).filter((r) => r.status === "published" || !r.status).map((r) => ({ text: r.content, value: r.value ?? null, at: r.createdAt, tags: (r.tags || []).slice(0, 4) })),
      };
    }
  } catch { data = null; }
  cache.set(key, { at: Date.now(), data });
  return data;
}
