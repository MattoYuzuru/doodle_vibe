import { AnimatePresence, m } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNav } from "../hooks/useNav";
import { useNow } from "../hooks/useNow";
import { useUi } from "../hooks/useUi";
import { DAY, HOUR, effectiveDue, mskParts, todayKey } from "../lib/dates";
import { plural } from "../lib/journal";
import { useJournal } from "../store/journal";
import { useSchedule } from "../store/schedule";
import { useAppStore } from "../store/useAppStore";
import { haptic } from "../telegram/webapp";
import { TABBAR_H } from "./TabBar";

/*
 * Сова Дуся — помощник в правом нижнем углу, на месте прежнего «+» (18 окт 2026). Нажатие — реплика по ситуации (дедлайн, пара, пропуски,
 * ночь, всё сдано, совет) и анимация; ещё нажатие — следующая фраза. Сама не всплывает: только точка на сове
 * (красная — горит дедлайн, жёлтая — совет про пару или пропуски), и после просмотра точка гаснет до завтра.
 * Пиксельный спрайт 24×24 собирается один раз строкой SVG; анимации — CSS-кадры steps() в index.css (owl-*),
 * в облегчённом режиме и при «уменьшить движение» сова стоит.
 */

type Mood = "deadline" | "overdue" | "class" | "skips" | "night" | "done" | "tip";
type Eyes = "open" | "up" | "closed" | "half" | "happy" | "wide" | "stern";

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
interface Ctx { mood: Mood; title?: string; left?: string; lesson?: string; mins?: number; attendance?: number | null; absences?: number; deadlineId?: string }
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
    case "class": return [
      `Через ${c.mins} мин пара: ${c.lesson}. Ноутбук, зарядка, ты — всё на месте?`,
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
    ];
  }
}
const LOOK: Record<Mood, { anim: string; eyes: [Eyes, Eyes, Eyes]; props: string[]; tag: string }> = {
  deadline: { anim: "panic", eyes: ["wide", "wide", "open"], props: ["excl", "sweat"], tag: "Скоро дедлайн" },
  overdue: { anim: "panic", eyes: ["wide", "stern", "open"], props: ["excl"], tag: "Просрочено" },
  class: { anim: "alert", eyes: ["up", "open", "open"], props: ["clock"], tag: "Скоро пара" },
  skips: { anim: "stern", eyes: ["stern", "stern", "open"], props: ["sweat"], tag: "Пропуски" },
  night: { anim: "sleepy", eyes: ["half", "closed", "wide"], props: ["zzz"], tag: "Поздно" },
  done: { anim: "happy", eyes: ["happy", "happy", "happy"], props: ["spark"], tag: "Всё сдано" },
  tip: { anim: "think", eyes: ["up", "up", "open"], props: ["q", "idea"], tag: "Совет" },
};

const leftText = (ms: number) => {
  const h = Math.floor(ms / HOUR);
  if (h >= 1) return `${h} ${plural(h, "час", "часа", "часов")}`;
  const mm = Math.max(1, Math.round(ms / 60e3));
  return `${mm} мин`;
};
const seenKey = (mood: Mood) => `owl-seen:${mood}:${todayKey()}`;
const wasSeen = (mood: Mood) => { try { return localStorage.getItem(seenKey(mood)) === "1"; } catch { return false; } };
const markSeen = (mood: Mood) => { try { localStorage.setItem(seenKey(mood), "1"); } catch { /* приватный режим */ } };

export function OwlAssistant() {
  const now = useNow(60_000);
  const keyboard = useUi((s) => s.keyboard);
  const { push, setTab, setJournalView } = useNav(useShallow((s) => ({ push: s.push, setTab: s.setTab, setJournalView: s.setJournalView })));
  const { deadlines, status } = useAppStore(useShallow((s) => ({ deadlines: s.deadlines, status: s.status })));
  const journal = useJournal((s) => s.st);
  const sched = useSchedule((s) => s.data);

  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const [eyes, setEyes] = useState<Eyes>("open");
  const [anim, setAnim] = useState<string | null>(null);
  const [props, setProps] = useState<string[]>([]);
  const [seen, setSeen] = useState(0);

  const p = mskParts(now);
  const night = p.hh >= 23 || p.hh < 5;
  const dark = document.documentElement.dataset.scheme === "dark";
  const svg = useMemo(() => sprite(dark, night), [dark, night]);

  // Ситуация — по приоритету: горит дедлайн → скоро пара → пропуски → ночь → всё сдано → совет.
  const ctx: Ctx = useMemo(() => {
    const open = deadlines.filter((d) => d.status === "open").map((d) => ({ d, due: effectiveDue(d.due) })).sort((a, b) => a.due - b.due);
    const overdue = open.find((x) => x.due <= now && x.due > now - 2 * DAY);
    if (overdue) return { mood: "overdue", title: overdue.d.title, deadlineId: overdue.d.id };
    const next = open.find((x) => x.due > now);
    if (next && next.due - now <= DAY) return { mood: "deadline", title: next.d.title, left: leftText(next.due - now), deadlineId: next.d.id };
    const hm = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const lesson = useSchedule.getState().forDay(todayKey()).find((l) => l.start > hm);
    if (lesson) {
      const [h, mi] = lesson.start.split(":").map(Number);
      const mins = h * 60 + mi - (p.hh * 60 + p.mm);
      if (mins <= 60) return { mood: "class", lesson: lesson.name, mins };
    }
    const d = journal?.connected ? journal.data : null;
    if (d?.summary.attendance != null && d.summary.attendance < 75) return { mood: "skips", attendance: Math.round(d.summary.attendance * 10) / 10, absences: d.summary.absences };
    if (night) return { mood: "night" };
    if (status === "ready" && !open.length) return { mood: "done" };
    return { mood: "tip" };
  }, [deadlines, status, journal, sched, now, night, p.hh, p.mm]);

  const badge = (ctx.mood === "deadline" || ctx.mood === "overdue") ? "red" : (ctx.mood === "class" || ctx.mood === "skips") ? "yellow" : null;
  const showBadge = badge && !wasSeen(ctx.mood) && seen >= 0;
  const look = LOOK[ctx.mood];
  const text = pick(lines(ctx), n);

  // Реакция на нажатие: три «кадра» глаз и значки над головой, потом сова успокаивается.
  useEffect(() => {
    if (!anim) return;
    setEyes(look.eyes[0]); setProps([look.props[0]]);
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
    if (open) setN((x) => x + 1); else setOpen(true);
    setAnim(look.anim + ":" + Date.now());
    if (badge) { markSeen(ctx.mood); setSeen((x) => x + 1); }
  };
  const action = ctx.deadlineId ? { label: "Открыть", run: () => push({ name: "deadline", id: ctx.deadlineId! }) }
    : ctx.mood === "class" ? { label: "Весь план", run: () => setTab("plan") }
    : ctx.mood === "skips" ? { label: "Журнал", run: () => { setJournalView("journal"); setTab("journal"); } }
    : null;
  const bottom = `calc(${TABBAR_H + 12}px + var(--safe-bottom))`;

  return (
    <>
      <AnimatePresence>
        {open && !keyboard && (
          <m.div role="dialog" aria-label="Подсказка совы Дуси"
            initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 520, damping: 36 }}
            className="fixed right-4 z-30 w-[min(340px,calc(100vw-32px))] rounded-[20px] bg-card p-3.5 text-text shadow-[0_14px_40px_rgb(0_0_0/0.28)]"
            style={{ bottom: `calc(${TABBAR_H + 84}px + var(--safe-bottom))` }}>
            <div className="flex items-center gap-2">
              <span className="text-m font-bold">Дуся</span>
              <span className={`rounded-full px-2 py-0.5 text-s font-bold ${badge === "red" ? "bg-red/15 text-red" : badge === "yellow" ? "bg-yellow/15 text-yellow" : "bg-accent/15 text-accent"}`}>{look.tag}</span>
              <button onClick={() => setOpen(false)} aria-label="Закрыть" className="-mr-1.5 ml-auto grid size-9 place-items-center rounded-full text-hint"><X size={18} strokeWidth={2.25} /></button>
            </div>
            <p className="mt-1.5 text-m font-medium" aria-live="polite">{text}</p>
            <div className="mt-3 flex gap-2">
              {action && <button onClick={() => { haptic.tap(); setOpen(false); action.run(); }} className="min-h-11 flex-1 rounded-2xl bg-accent px-3 text-m font-bold text-on-accent">{action.label}</button>}
              <button onClick={tap} className="min-h-11 flex-1 rounded-2xl bg-raised px-3 text-m font-bold">Ещё</button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
      <button onClick={tap} aria-label={`Сова Дуся: ${look.tag.toLowerCase()}`} aria-hidden={keyboard || undefined} tabIndex={keyboard ? -1 : undefined}
        className={`owl fixed right-4 z-30 grid size-14 place-items-center rounded-full bg-card shadow-[0_8px_22px_rgb(0_0_0/0.22)] transition-[scale,opacity,translate] duration-200 active:scale-90 ${keyboard ? "pointer-events-none translate-y-[200px] opacity-0" : ""} ${anim ? `owl-a-${anim.split(":")[0]}` : ""} ${props.map((x) => `owl-p-${x}`).join(" ")}`}
        style={{ bottom }}>
        <svg viewBox="0 0 24 24" width="46" height="46" shapeRendering="crispEdges" data-eyes={eyes} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
        {showBadge && <span className={`absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-page ${badge === "red" ? "bg-red" : "bg-yellow"}`} />}
      </button>
    </>
  );
}
