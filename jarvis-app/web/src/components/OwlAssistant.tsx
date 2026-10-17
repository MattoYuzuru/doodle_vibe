import { AnimatePresence, m } from "framer-motion";
import { Feather, Moon, Smartphone, Sparkles, Sun, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { useScheme } from "../hooks/useScheme";
import { useUi } from "../hooks/useUi";
import { DAY, HOUR, effectiveDue, mskParts, todayKey } from "../lib/dates";
import { plural } from "../lib/journal";
import { useJournal } from "../store/journal";
import { useSchedule } from "../store/schedule";
import { useAppStore } from "../store/useAppStore";
import { lite, setLite } from "../lib/perf";
import { addToHomeScreen, haptic, homeScreenStatus, setScheme } from "../telegram/webapp";
import { TABBAR_H } from "./TabBar";

/*
 * Сова Дуся — помощник в правом нижнем углу, на месте прежнего «+» (18 окт 2026). Нажатие — реплика по ситуации (дедлайн, пара, пропуски,
 * ночь, всё сдано, совет) и анимация; ещё нажатие — следующая фраза. Сама не всплывает: только точка на сове
 * (красная — горит дедлайн, жёлтая — совет про пару или пропуски), и после просмотра точка гаснет до завтра.
 * Пиксельный спрайт 24×24 собирается один раз строкой SVG; анимации — CSS-кадры steps() в index.css (owl-*),
 * в облегчённом режиме и при «уменьшить движение» сова стоит.
 */

type Mood = "deadline" | "overdue" | "class" | "skips" | "night" | "morning" | "friday" | "done" | "tip" | "party";
type Eyes = "open" | "up" | "closed" | "half" | "happy" | "wide" | "stern";
/** Сценки поверх обычной реплики: праздник за сданное, «щекотно» после частых нажатий, «серьёзная сова» после неё, новое звание. */
type Special = { kind: "party"; title: string } | { kind: "tickle"; lines: string[]; step: number } | { kind: "calm" } | { kind: "rank"; title: string; count: number };

// ---------- спрайт ----------
const N = 24;
type Px = [number, number, string];
function layer() {
  const g: Px[] = [];
  const api = {
    set(x: number, y: number, c: string) { if (x >= 0 && y >= 0 && x < N && y < N) g.push([x, y, c]); return api; },
    rect(x: number, y: number, w: number, h: number, c: string) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) api.set(x + i, y + j, c); return api; },
    ell(cx: number, cy: number, rx: number, ry: number, c: string) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; if (dx * dx + dy * dy <= 1) api.set(x, y, c); }
      return api;
    },
    pts(a: [number, number][], c: string) { a.forEach(([x, y]) => api.set(x, y, c)); return api; },
    svg() { return g.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`).join(""); },
  };
  return api;
}
const B = "#2f7bf6", BD = "#1f66e0", L = "#6aa2ff", S = "#a9cbff", W = "#ffffff", K = "#0a1a4a", BEAK = "#ffc23d", BEAK2 = "#e09a12";
const g = (attrs: string, inner: string) => `<g ${attrs}>${inner}</g>`;

function sprite(dark: boolean, nightcap: boolean) {
  const ink = dark ? W : K, cap = dark ? W : K, tas = dark ? S : BD, feet = dark ? W : K;
  const disc = (l: ReturnType<typeof layer>, x: number, y = 11, h = 4) => l.rect(x, y, 4, h, W);
  const eyes: Record<Eyes, () => ReturnType<typeof layer>> = {
    open: () => { const l = layer(); disc(l, 7); disc(l, 13); return l.rect(8, 12, 2, 2, K).rect(14, 12, 2, 2, K); },
    up: () => { const l = layer(); disc(l, 7); disc(l, 13); return l.rect(8, 11, 2, 2, K).rect(14, 11, 2, 2, K); },
    half: () => { const l = layer(); disc(l, 7, 13, 2); disc(l, 13, 13, 2); return l.rect(7, 12, 4, 1, K).rect(13, 12, 4, 1, K).rect(8, 13, 2, 1, K).rect(14, 13, 2, 1, K); },
    closed: () => layer().rect(7, 13, 4, 1, K).rect(13, 13, 4, 1, K),
    happy: () => layer().pts([[7, 13], [8, 12], [9, 12], [10, 13]], K).pts([[13, 13], [14, 12], [15, 12], [16, 13]], K),
    wide: () => { const l = layer(); disc(l, 7, 10, 5); disc(l, 13, 10, 5); return l.set(8, 12, K).set(15, 12, K); },
    stern: () => { const l = layer(); disc(l, 7, 12, 3); disc(l, 13, 12, 3); return l.rect(8, 13, 2, 2, K).rect(14, 13, 2, 2, K).pts([[7, 10], [8, 10], [9, 11], [10, 11]], K).pts([[13, 11], [14, 11], [15, 10], [16, 10]], K); },
  };
  const props: Record<string, ReturnType<typeof layer>> = {
    excl: layer().rect(20, 2, 2, 4, ink).rect(20, 7, 2, 1, ink),
    sweat: layer().set(19, 9, tas).rect(19, 10, 2, 2, tas).set(20, 12, tas),
    zzz: layer().pts([[18, 1], [19, 1], [20, 1], [19, 2], [18, 3], [19, 3], [20, 3]], tas).pts([[21, 4], [22, 4], [22, 5], [21, 6], [22, 6]], tas),
    idea: layer().rect(19, 1, 3, 3, ink).set(20, 4, tas).pts([[18, 0], [22, 0], [17, 2], [23, 2]], tas),
    q: layer().rect(19, 1, 3, 1, ink).set(22, 2, ink).rect(20, 3, 2, 1, ink).set(20, 4, ink).set(20, 6, ink),
    spark: layer().pts([[2, 6], [1, 7], [2, 7], [3, 7], [2, 8]], tas).pts([[21, 9], [20, 10], [21, 10], [22, 10], [21, 11]], tas).pts([[3, 18], [2, 19], [3, 19], [4, 19], [3, 20]], tas),
    clock: layer().rect(19, 1, 4, 4, ink).rect(20, 2, 2, 2, BD).set(21, 2, ink),
    feather: layer().pts([[2, 11], [3, 12]], S).pts([[21, 12], [20, 13]], S).pts([[1, 17], [2, 18]], L).pts([[22, 18], [21, 19]], L),
  };
  const hat = nightcap
    ? layer().rect(9, 7, 7, 1, W).rect(10, 5, 5, 2, S).rect(11, 4, 4, 1, S).rect(12, 3, 3, 1, S).rect(14, 2, 2, 1, S).set(16, 2, S).set(17, 3, S).rect(18, 3, 2, 2, W)
    : layer().rect(9, 3, 6, 1, cap).rect(7, 4, 10, 1, cap).rect(9, 5, 6, 1, cap).rect(10, 6, 4, 2, cap).set(16, 5, tas).set(16, 6, tas).rect(15, 7, 2, 2, tas);
  return (
    g('class="owl-rig"',
      g('class="owl-wing-l"', layer().rect(4, 14, 2, 5, BD).set(5, 19, BD).svg()) +
      g('class="owl-wing-r"', layer().rect(18, 14, 2, 5, BD).set(18, 19, BD).svg()) +
      g('class="owl-tufts"', layer().rect(6, 7, 2, 2, B).rect(16, 7, 2, 2, B).set(6, 6, B).set(17, 6, B).svg()) +
      layer().ell(12, 15, 7.5, 7, B).svg() +
      layer().ell(12, 19, 4, 2.8, L).pts([[10, 18], [12, 19], [14, 18]], S).svg() +
      layer().rect(11, 15, 2, 1, BEAK).set(11, 16, BEAK).set(12, 16, BEAK2).svg() +
      layer().rect(9, 22, 2, 1, feet).rect(13, 22, 2, 1, feet).svg() +
      (Object.keys(eyes) as Eyes[]).map((k) => g(`data-eye="${k}"`, eyes[k]().svg())).join("") +
      hat.svg()
    ) + Object.entries(props).map(([k, l]) => g(`data-prop="${k}"`, l.svg())).join("")
  );
}

// ---------- фразы ----------
interface Ctx { mood: Mood; title?: string; left?: string; lesson?: string; place?: string; mins?: number; attendance?: number | null; absences?: number; deadlineId?: string; lessonsToday?: number; firstAt?: string }
const pick = <T,>(a: T[], i: number) => a[i % a.length];
function lines(c: Ctx): string[] {
  switch (c.mood) {
    case "deadline": return [
      `«${c.title}» — через ${c.left}. Я не паникую. Это ты паникуешь. Ладно, мы обе.`,
      `До сдачи «${c.title}» ${c.left}. Говорят, дедлайн — лучший мотиватор. Проверим?`,
      `Это не я ухаю. Это приближается «${c.title}».`,
      `Хорошая новость: срок известен. Плохая: он через ${c.left}.`,
    ];
    case "overdue": return [
      `«${c.title}» уже просрочен. Не страшно — открой и посмотри, можно ли ещё сдать.`,
      `Срок по «${c.title}» прошёл. Напиши преподавателю сегодня — завтра будет неловко вдвойне.`,
    ];
    case "class": return (c.mins ?? 99) <= 10 ? [
      `Через ${c.mins} мин ${c.lesson}${c.place ? `, ${c.place}` : ""}. Пора выходить!`,
      `${c.lesson} через ${c.mins} мин${c.place ? ` в ${c.place}` : ""}. Беги, я подержу место.`,
      `Осталось ${c.mins} мин до пары. Если ты ещё лежишь — вставай прямо сейчас.`,
    ] : [
      `Через ${c.mins} мин пара: ${c.lesson}${c.place ? ` (${c.place})` : ""}. Ноутбук, зарядка, ты — всё на месте?`,
      "Выходи сейчас — и придёшь вовремя. Выйдешь через 10 минут — придёшь эффектно.",
      `${c.lesson} совсем скоро. Кофе успеешь, второй — нет.`,
    ];
    case "skips": return [
      `Посещаемость ${String(c.attendance ?? "").replace(".", ",")}%. Ниже 75% — пора подтянуть.`,
      c.absences ? `${c.absences} ${plural(c.absences, "пропуск", "пропуска", "пропусков")} за семестр. Преподаватель уже считает тебя легендой.` : "Я не осуждаю. Я просто очень внимательно смотрю.",
      "Я не осуждаю. Я просто очень внимательно смотрю.",
      "Завтра первая пара? Я разбужу. Мне несложно, я всё равно не сплю.",
    ];
    case "night": return [
      "Я сова, мне можно не спать. А тебе — нет.",
      "Поздно. Конспект никуда не убежит, а сон уже убегает.",
      "Ладно, ещё одна задача и спать. Я засекаю.",
      "Невыспавшийся мозг запоминает хуже. Это не я придумала, это наука.",
    ];
    case "morning": return [
      c.lessonsToday ? `Доброе утро! Сегодня ${c.lessonsToday} ${plural(c.lessonsToday, "пара", "пары", "пар")}, первая в ${c.firstAt}.` : "Доброе утро! Сегодня пар нет. Редкий праздник.",
      "Ух… *зевает* Сначала завтрак, потом дедлайны.",
      "Утро — лучшее время для самого противного задания. Пока мозг не понял, что происходит.",
      "Я ещё не проснулась, но ты держись.",
    ];
    case "friday": return [
      "Пятница! Дедлайны подождут хотя бы до утра.",
      "Неделя позади. Ты молодец, даже если так не кажется.",
      "Пятничный вечер. Сова официально разрешает отдыхать.",
    ];
    case "party": return [
      `«${c.title}» — сдано! Ух-ух-ух!`,
      `Минус одно задание: «${c.title}». Я танцую!`,
      `«${c.title}» готово. Ты сегодня в ударе.`,
    ];
    case "done": return [
      "Все сроки закрыты! Официально можно ничего не делать.",
      "Ух-ух! Кто сдал всё вовремя? Мы сдали!",
      "Ноль долгов. Я горжусь тобой, и мои перья тоже.",
    ];
    default: return [
      "Разбей лабу на куски по 25 минут. Помидорный таймер работает, проверено совами.",
      "Отчёт проще писать сразу после лабы, пока всё помнишь. Через неделю это будет археология.",
      "Сначала делай самое неприятное задание. Дальше будет только легче.",
      "Сфоткай доску после пары. Будущий ты скажет спасибо.",
      "Объясни тему мне. Если смог объяснить сове — точно понял.",
      "Повтори конспект 10 минут перед сном. Мозг доделает остальное, пока ты спишь.",
      "Закрой лишние вкладки. Я вижу, их там много.",
      "Зажми меня подольше — откроется быстрое меню: тема, лёгкий режим, профиль.",
    ];
  }
}
const LOOK: Record<Mood, { anim: string; eyes: [Eyes, Eyes, Eyes]; props: string[]; tag: string }> = {
  deadline: { anim: "panic", eyes: ["wide", "wide", "open"], props: ["excl", "sweat"], tag: "Скоро дедлайн" },
  overdue: { anim: "panic", eyes: ["wide", "stern", "open"], props: ["excl"], tag: "Просрочено" },
  class: { anim: "alert", eyes: ["up", "open", "open"], props: ["clock"], tag: "Скоро пара" },
  skips: { anim: "stern", eyes: ["stern", "stern", "open"], props: ["sweat"], tag: "Пропуски" },
  night: { anim: "sleepy", eyes: ["half", "closed", "wide"], props: ["zzz"], tag: "Поздно" },
  morning: { anim: "sleepy", eyes: ["half", "closed", "open"], props: ["zzz"], tag: "Утро" },
  friday: { anim: "happy", eyes: ["happy", "happy", "open"], props: ["spark"], tag: "Пятница" },
  done: { anim: "happy", eyes: ["happy", "happy", "happy"], props: ["spark"], tag: "Всё сдано" },
  tip: { anim: "think", eyes: ["up", "up", "open"], props: ["q", "idea"], tag: "Совет" },
  party: { anim: "party", eyes: ["happy", "happy", "happy"], props: ["spark"], tag: "Сдано!" },
};
const TICKLE_LOOK = { anim: "tickle", eyes: ["happy", "happy", "happy"] as [Eyes, Eyes, Eyes], props: ["feather", "spark"], tag: "Хи-хи" };
const CALM_LOOK = { anim: "happy", eyes: ["happy", "happy", "open"] as [Eyes, Eyes, Eyes], props: [] as string[], tag: "Привет" };
const CALM_TEXT = "Кхм. Я серьёзная сова. Чем помочь?";

// «Щекотно» (5 быстрых нажатий): три случайные реплики со смехом, потом Дуся поправляет шапочку и делает серьёзный вид.
const TICKLE = [
  "Хи-хи! Щекотно!", "Ха-ха-ха! Только не под крылом!", "Ух-ух-ух! Перья летят!",
  "Хи-хи-хи! Ну хватит, ну пожалуйста!", "Ахаха! Я сейчас упаду с ветки!", "Ой-ой-ой! Это моё самое щекотное перо!",
];
const tickleLines = () => [...TICKLE].sort(() => Math.random() - 0.5).slice(0, 3);

// Звания за нажатия на сову за день: при новом — поздравление, в ответе «серьёзной совы» — текущее.
const RANKS: [number, string][] = [[10, "Тыкатель-любитель"], [25, "Тыкатель со стажем"], [50, "Мастер тыка"], [100, "Легенда тыка"]];
const rankOf = (n: number) => RANKS.filter(([k]) => n >= k).pop()?.[1] ?? null;
const tapsKey = () => `owl-taps:${todayKey()}`;
const readTaps = () => { try { return Number(localStorage.getItem(tapsKey()) || 0); } catch { return 0; } };
const saveTaps = (n: number) => { try { localStorage.setItem(tapsKey(), String(n)); } catch { /* приватный режим */ } };

const leftText = (ms: number) => {
  const h = Math.floor(ms / HOUR);
  if (h >= 1) return `${h} ${plural(h, "час", "часа", "часов")}`;
  const mm = Math.max(1, Math.round(ms / 60e3));
  return `${mm} мин`;
};
const seenKey = (k: string) => `owl-seen:${k}:${todayKey()}`;
const wasSeen = (k: string) => { try { return localStorage.getItem(seenKey(k)) === "1"; } catch { return false; } };
const markSeen = (k: string) => { try { localStorage.setItem(seenKey(k), "1"); } catch { /* приватный режим */ } };

export function OwlAssistant() {
  const now = useNow(60_000);
  const keyboard = useUi((s) => s.keyboard);
  const { push, setTab, setJournalView } = useNav(useShallow((s) => ({ push: s.push, setTab: s.setTab, setJournalView: s.setJournalView })));
  const { deadlines, status } = useAppStore(useShallow((s) => ({ deadlines: s.deadlines, status: s.status })));
  const journal = useJournal((s) => s.st);
  const sched = useSchedule((s) => s.data);
  const stackLen = useNav((s) => s.stack.length);

  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const [eyes, setEyes] = useState<Eyes>("open");
  const [anim, setAnim] = useState<string | null>(null);
  const [props, setProps] = useState<string[]>([]);
  const [seen, setSeen] = useState(0);
  const [special, setSpecial] = useState<Special | null>(null);
  const [tapCount, setTapCount] = useState(readTaps);
  const taps = useRef<number[]>([]);
  const tapsDay = useRef({ day: todayKey(), n: tapCount });
  const prevStatus = useRef<Map<string, string> | null>(null);
  const pendingParty = useRef<string | null>(null);
  const partyTimer = useRef(0);
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; long: boolean; timer: number } | null>(null);
  const suppressClick = useRef(false);
  const [homeScreen, setHomeScreen] = useState<string | null>(null);
  useEffect(() => { if (menu) void homeScreenStatus().then(setHomeScreen); }, [menu]);

  const p = mskParts(now);
  const night = p.hh >= 23 || p.hh < 5;
  const dark = useScheme() === "dark";
  const svg = useMemo(() => sprite(dark, night), [dark, night]);

  // Ситуация — по приоритету: горит дедлайн → скоро пара → пропуски → ночь → утро → вечер пятницы → всё сдано → совет.
  const ctx: Ctx = useMemo(() => {
    const open = deadlines.filter((d) => d.status === "open").map((d) => ({ d, due: effectiveDue(d.due) })).sort((a, b) => a.due - b.due);
    const overdue = open.find((x) => x.due <= now && x.due > now - 2 * DAY);
    if (overdue) return { mood: "overdue", title: overdue.d.title, deadlineId: overdue.d.id };
    const next = open.find((x) => x.due > now);
    if (next && next.due - now <= DAY) return { mood: "deadline", title: next.d.title, left: leftText(next.due - now), deadlineId: next.d.id };
    const hm = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const lesson = useSchedule.getState().forDay(todayKey()).sort((x, y) => x.start.localeCompare(y.start)).find((l) => l.start > hm);
    if (lesson) {
      const [h, mi] = lesson.start.split(":").map(Number);
      const mins = h * 60 + mi - (p.hh * 60 + p.mm);
      if (mins <= 60) return { mood: "class", lesson: lesson.name, place: lesson.place, mins };
    }
    const d = journal?.connected ? journal.data : null;
    if (d?.summary.attendance != null && d.summary.attendance < 75) return { mood: "skips", attendance: Math.round(d.summary.attendance * 10) / 10, absences: d.summary.absences };
    if (night) return { mood: "night" };
    if (p.hh >= 6 && p.hh < 10) {
      const today = useSchedule.getState().forDay(todayKey()).sort((x, y) => x.start.localeCompare(y.start));
      return { mood: "morning", lessonsToday: today.length, firstAt: today[0]?.start };
    }
    if (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() === 5 && p.hh >= 17) return { mood: "friday" };
    if (status === "ready" && !open.length) return { mood: "done" };
    return { mood: "tip" };
  }, [deadlines, status, journal, sched, now, night, p.hh, p.mm]);

  // Пара через 10 минут — своя точка: если подсказку за час уже смотрели, напомнить ещё раз.
  const soon = ctx.mood === "class" && (ctx.mins ?? 99) <= 10;
  const badgeKey = soon ? "class-soon" : ctx.mood;
  const badge = (ctx.mood === "deadline" || ctx.mood === "overdue" || soon) ? "red" : (ctx.mood === "class" || ctx.mood === "skips") ? "yellow" : null;
  const showBadge = badge && !wasSeen(badgeKey) && seen >= 0;
  const tickling = special?.kind === "tickle";
  const rank = rankOf(tapCount);
  const baseLook = soon ? { ...LOOK.class, tag: "Пора выходить" } : LOOK[ctx.mood];
  const look = tickling ? TICKLE_LOOK : special?.kind === "calm" ? { ...CALM_LOOK, tag: rank ?? CALM_LOOK.tag }
    : special?.kind === "party" ? LOOK.party : special?.kind === "rank" ? { ...LOOK.party, tag: "Новое звание" } : baseLook;
  const tagColor = !special && badge === "red" ? "bg-red/15 text-red" : !special && badge === "yellow" ? "bg-yellow/15 text-yellow" : special?.kind === "party" || special?.kind === "rank" ? "bg-green/15 text-green" : "bg-accent/15 text-accent";
  const text = tickling ? special.lines[special.step]
    : special?.kind === "calm" ? `${CALM_TEXT}\nНажатий сегодня: ${tapCount}.${rank ? ` Звание: «${rank}».` : ""}`
    : special?.kind === "rank" ? `Новое звание: «${special.title}»! 🏅\nНажатий на сову сегодня: ${special.count}.`
    : special?.kind === "party" ? pick(lines({ mood: "party", title: special.title }), n)
    : pick(lines(ctx), n);
  const restEyes = (): Eyes => (ctx.mood === "done" ? "happy" : "open");

  // Праздник: дедлайн стал «сдано» (отметили в приложении или засчитал Moodle). Первую загрузку и массовую
  // синхронизацию (больше трёх разом) не празднуем; поверх открытого экрана не видно — ждём возврата на вкладку.
  useEffect(() => {
    const cur = new Map(deadlines.map((d) => [d.id, d.status]));
    const prev = prevStatus.current;
    prevStatus.current = cur;
    if (!prev?.size) return;
    const fresh = deadlines.filter((d) => d.status === "done" && prev.get(d.id) === "open");
    if (fresh.length >= 1 && fresh.length <= 3) pendingParty.current = fresh[0].title;
  }, [deadlines]);
  useEffect(() => {
    if (!pendingParty.current || stackLen > 0 || keyboard || tickling) return;
    const t = window.setTimeout(() => {
      const title = pendingParty.current;
      pendingParty.current = null;
      if (!title) return;
      haptic.success();
      setSpecial({ kind: "party", title }); setN(0); setOpen(true); setAnim("party:" + Date.now());
      clearTimeout(partyTimer.current);
      partyTimer.current = window.setTimeout(() => { setOpen(false); setSpecial(null); }, 6000);
    }, 350);
    return () => clearTimeout(t);
  }, [stackLen, keyboard, deadlines, tickling]);

  // «Щекотно»: смех по одной реплике, перья летят; потом «серьёзная сова» и счётчик нажатий.
  useEffect(() => {
    if (special?.kind !== "tickle") return;
    setEyes("happy"); setProps(TICKLE_LOOK.props);
    const last = special.step >= special.lines.length - 1;
    const t = window.setTimeout(() => {
      if (!last) { haptic.tap(); setSpecial({ ...special, step: special.step + 1 }); return; }
      setSpecial({ kind: "calm" }); setAnim("happy:" + Date.now());
    }, 1300);
    return () => clearTimeout(t);
  }, [special]);

  // Реакция на нажатие: три «кадра» глаз и значки над головой, потом сова успокаивается.
  useEffect(() => {
    if (!anim || anim.startsWith("tickle")) return;
    setEyes(look.eyes[0]); setProps(look.props.slice(0, 1));
    const t = [
      window.setTimeout(() => { setEyes(look.eyes[1]); setProps(look.props); }, 600),
      window.setTimeout(() => setEyes(look.eyes[2]), 2000),
      window.setTimeout(() => { setAnim(null); setProps(ctx.mood === "done" ? ["spark"] : []); setEyes(ctx.mood === "done" ? "happy" : "open"); }, 3000),
    ];
    return () => t.forEach(clearTimeout);
  }, [anim, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Сама по себе — моргает и оглядывается.
  useEffect(() => {
    let alive = true, t = 0;
    const loop = () => {
      t = window.setTimeout(() => {
        if (!alive) return;
        if (!anim) { setEyes("closed"); window.setTimeout(() => alive && setEyes(ctx.mood === "done" ? "happy" : "open"), 140); }
        loop();
      }, 2500 + Math.random() * 3000);
    };
    loop();
    return () => { alive = false; clearTimeout(t); };
  }, [anim, ctx.mood]);

  const tap = () => {
    haptic.tap();
    clearTimeout(partyTimer.current);
    if (special) { setSpecial(null); setN(0); setOpen(true); }
    else if (open) setN((x) => x + 1); else setOpen(true);
    setAnim(baseLook.anim + ":" + Date.now());
    if (badge) { markSeen(badgeKey); setSeen((x) => x + 1); }
  };
  // Каждое нажатие по сове идёт в счётчик дня; пять быстрых подряд — «щекотно», круглое число — новое звание.
  const owlTap = () => {
    const day = todayKey();
    const cnt = (tapsDay.current.day === day ? tapsDay.current.n : readTaps()) + 1;
    tapsDay.current = { day, n: cnt }; saveTaps(cnt); setTapCount(cnt);
    if (tickling) return;
    const t = Date.now();
    taps.current = [...taps.current.filter((x) => t - x < 2500), t];
    if (taps.current.length >= 5) {
      taps.current = [];
      clearTimeout(partyTimer.current);
      haptic.success();
      setSpecial({ kind: "tickle", step: 0, lines: tickleLines() }); setOpen(true); setAnim("tickle:" + Date.now());
      return;
    }
    const r = RANKS.find(([k]) => k === cnt);
    if (r) {
      clearTimeout(partyTimer.current);
      haptic.success();
      setSpecial({ kind: "rank", title: r[1], count: cnt }); setOpen(true); setAnim("party:" + Date.now());
      return;
    }
    tap();
  };
  const close = () => { setOpen(false); clearTimeout(partyTimer.current); if (special) { setSpecial(null); setAnim(null); setEyes(restEyes()); setProps([]); } };
  const action = special ? null : ctx.deadlineId ? { label: "Открыть", run: () => push({ name: "deadline", id: ctx.deadlineId! }) }
    : ctx.mood === "class" ? { label: "Весь план", run: () => setTab("plan") }
    : ctx.mood === "skips" ? { label: "Журнал", run: () => { setJournalView("journal"); setTab("journal"); } }
    : null;
  const bottom = `calc(${TABBAR_H + 12}px + var(--safe-bottom))`;

  // Быстрое меню по зажатию совы: кнопки дугой слева-сверху. Можно, не отпуская палец, довести до кнопки и отпустить,
  // а можно отпустить и нажать кнопку. Только то, чего нет во вкладках (дедлайн, план и журнал убраны по просьбе владельца):
  // профиль, тема, облегчённый режим (с перезапуском) и ярлык на экран телефона — если Telegram умеет и ярлыка ещё нет.
  const items = [
    { key: "profile", label: "Профиль", Icon: UserRound, run: () => push({ name: "profile" }) },
    { key: "theme", label: dark ? "Светлая" : "Тёмная", Icon: dark ? Sun : Moon, run: () => setScheme(dark ? "light" : "dark") },
    { key: "lite", label: lite ? "Обычный режим" : "Лёгкий режим", Icon: lite ? Sparkles : Feather, run: () => setLite(!lite) },
    ...(homeScreen === "missed" || homeScreen === "unknown"
      ? [{ key: "home", label: "На экран", Icon: Smartphone, run: () => { addToHomeScreen(); setHomeScreen("added"); } }] : []),
  ];
  const R = 140;
  const spot = (i: number) => { const a = Math.PI - (i / (items.length - 1)) * (Math.PI / 2); return { x: R * Math.cos(a), y: -R * Math.sin(a) }; };
  const closeMenu = () => { setMenu(false); setHover(null); hoverRef.current = null; };
  const runItem = (i: number) => { haptic.tap(); closeMenu(); items[i].run(); };
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* старый WebView */ }
    const timer = window.setTimeout(() => {
      if (!press.current) return;
      press.current.long = true;
      haptic.success();
      setOpen(false); setMenu(true); setHover(null); hoverRef.current = null;
    }, 450);
    press.current = { x: e.clientX, y: e.clientY, long: false, timer };
  };
  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const pr = press.current;
    if (!pr) return;
    if (!pr.long) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 12) { clearTimeout(pr.timer); press.current = null; }
      return;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-radial]");
    const i = el ? Number(el.dataset.radial) : null;
    if (i !== hoverRef.current) { hoverRef.current = i; setHover(i); if (i != null) haptic.select(); }
  };
  const onUp = (cancel: boolean) => {
    const pr = press.current;
    press.current = null;
    if (!pr) return;
    clearTimeout(pr.timer);
    if (!pr.long) return;
    suppressClick.current = true;
    if (!cancel && hoverRef.current != null) runItem(hoverRef.current);
  };

  return (
    <>
      <AnimatePresence>
        {menu && !keyboard && (
          <m.div key="owl-menu-bg" className="fixed inset-0 z-[29] bg-black/30" onClick={closeMenu}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} />
        )}
      </AnimatePresence>
      <div className="pointer-events-none fixed right-4 z-40 size-14" style={{ bottom }} role="menu" aria-label="Быстрое меню Дуси" aria-hidden={!menu || undefined}>
        <AnimatePresence>
          {menu && !keyboard && items.map((it, i) => {
            const p = spot(i);
            return (
              <m.button key={it.key} data-radial={i} role="menuitem" aria-label={it.label} onClick={() => runItem(i)}
                initial={{ x: 0, y: 0, scale: 0.3, opacity: 0 }} animate={{ x: p.x, y: p.y, scale: hover === i ? 1.15 : 1, opacity: 1 }}
                exit={{ x: 0, y: 0, scale: 0.3, opacity: 0, transition: { duration: 0.12 } }}
                transition={{ type: "spring", stiffness: 560, damping: 30, delay: i * 0.025 }}
                className={`pointer-events-auto absolute top-1 left-1 grid size-12 place-items-center rounded-full shadow-[0_8px_22px_rgb(0_0_0/0.25)] transition-colors duration-100 ${hover === i ? "bg-accent text-on-accent" : "bg-card text-text"}`}>
                <it.Icon size={22} strokeWidth={2.25} />
                <span className="absolute top-full mt-1 rounded-full bg-card px-1.5 text-[11px] leading-4 font-bold whitespace-nowrap text-text">{it.label}</span>
              </m.button>
            );
          })}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {open && !keyboard && (
          <m.div role="dialog" aria-label="Подсказка совы Дуси"
            initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 520, damping: 36 }}
            className="fixed right-4 z-30 w-[min(340px,calc(100vw-32px))] rounded-[20px] bg-card p-3.5 text-text shadow-[0_14px_40px_rgb(0_0_0/0.28)]"
            style={{ bottom: `calc(${TABBAR_H + 84}px + var(--safe-bottom))` }}>
            <div className="flex items-center gap-2">
              <span className="text-m font-bold">Дуся</span>
              <span className={`rounded-full px-2 py-0.5 text-s font-bold ${tagColor}`}>{look.tag}</span>
              <button onClick={close} aria-label="Закрыть" className="-mr-1.5 ml-auto grid size-9 place-items-center rounded-full text-hint"><X size={18} strokeWidth={2.25} /></button>
            </div>
            <p className={`mt-1.5 whitespace-pre-line text-m font-medium ${tickling ? "owl-say-tickle font-bold" : ""}`} aria-live="polite">{text}</p>
            {!tickling && <div className="mt-3 flex gap-2">
              {action && <button onClick={() => { haptic.tap(); setOpen(false); action.run(); }} className="min-h-11 flex-1 rounded-2xl bg-accent px-3 text-m font-bold text-on-accent">{action.label}</button>}
              <button onClick={tap} className="min-h-11 flex-1 rounded-2xl bg-raised px-3 text-m font-bold">Ещё</button>
            </div>}
          </m.div>
        )}
      </AnimatePresence>
      <button onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (menu) { closeMenu(); return; } owlTap(); }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => onUp(false)} onPointerCancel={() => onUp(true)} onContextMenu={(e) => e.preventDefault()}
        aria-label={`Сова Дуся: ${look.tag.toLowerCase()}. Зажми — быстрое меню`} aria-hidden={keyboard || undefined} tabIndex={keyboard ? -1 : undefined}
        className={`owl owl-hold fixed right-4 z-30 grid size-14 place-items-center rounded-full bg-card shadow-[0_8px_22px_rgb(0_0_0/0.22)] transition-[scale,opacity,translate] duration-200 active:scale-90 ${keyboard ? "pointer-events-none translate-y-[200px] opacity-0" : ""} ${anim ? `owl-a-${anim.split(":")[0]}` : ""} ${props.map((x) => `owl-p-${x}`).join(" ")}`}
        style={{ bottom }}>
        <svg viewBox="0 0 24 24" width="46" height="46" shapeRendering="crispEdges" data-eyes={eyes} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
        {showBadge && <span className={`absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-page ${badge === "red" ? "bg-red" : "bg-yellow"}`} />}
      </button>
    </>
  );
}
