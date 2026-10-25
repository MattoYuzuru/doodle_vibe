import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { MascotCard, MascotLoader } from "../components/assistant/MascotCard";
import { type AssistantContext, type AssistantDeadline, resolveAssistantPresentation } from "../theme/assistant-state";

/*
 * Каталог маскотов (DES-005): все состояния Дуси и Вари на синтетических данных и фиксированных часах — без входа в вуз,
 * backend и реальной даты. Открывается только в разработке: npm --prefix jarvis-app/web run dev → /mascot-catalog.html
 * (в сборку приложения страница не входит). Параметры адреса для повторяемых скриншотов: ?character=varya&theme=dark&motion=static.
 */

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 25, 9, 0); // 25 окт 2026, 12:00 МСК
const SPACE: Record<string, string> = { varya: "hse", dusya: "misis", unknown: "cu" };

type Fixture = { id: string; label: string; over: Partial<AssistantContext>; deadlines?: readonly AssistantDeadline[]; stale?: boolean; noSnapshot?: boolean; foreignSnapshot?: boolean };
const dl = (id: string, title: string, left: number | null, done = false) => ({ id, title, dueMs: left === null ? null : NOW + left, done });

const FIXTURES: Fixture[] = [
  { id: "urgent", label: "Срочно (< 24 ч), несколько работ", over: {}, deadlines: [dl("a", "Отчёт по лабе 3", 5 * HOUR), dl("b", "Тест по матанализу", 20 * HOUR)] },
  { id: "soon", label: "Скоро (24–72 ч)", over: {}, deadlines: [dl("a", "Эссе по философии", 2 * DAY)] },
  { id: "overdue", label: "Просрочено", over: {}, deadlines: [dl("a", "Домашка по линалу", -3 * HOUR)] },
  { id: "calm", label: "Спокойно (> 72 ч)", over: {}, deadlines: [dl("a", "Курсовая", 9 * DAY)] },
  { id: "completed", label: "Только что сдано", over: { recentEvent: { id: "ev", spaceId: "", kind: "deadline-completed", at: NOW - 300 } }, deadlines: [dl("a", "Курсовая", 9 * DAY)] },
  { id: "clear", label: "Открытых работ нет", over: {}, deadlines: [dl("a", "Отчёт", -DAY, true)] },
  { id: "undated", label: "Срок неизвестен", over: {}, deadlines: [dl("a", "Проект без срока", null)] },
  { id: "urgent-sync", label: "Обновление + срочная работа (срок бейджем)", over: { activity: "syncing" }, deadlines: [dl("a", "Отчёт по лабе 3", 5 * HOUR)] },
  { id: "urgent-completed", label: "Сдала одну, другая ещё горит", over: { recentEvent: { id: "ev2", spaceId: "", kind: "deadline-completed", at: NOW - 300 } }, deadlines: [dl("a", "Отчёт по лабе 3", 5 * HOUR)] },
  { id: "stale", label: "Срочно, данные устарели", over: {}, deadlines: [dl("a", "Отчёт по лабе 3", 5 * HOUR)], stale: true },
  { id: "reauth", label: "Нужно войти снова + срочная работа", over: { availability: "reauth" }, deadlines: [dl("a", "Отчёт по лабе 3", 5 * HOUR)], stale: true },
  { id: "error", label: "Ошибка обновления", over: { availability: "error" }, deadlines: [], stale: true },
  { id: "offline", label: "Нет связи", over: { availability: "offline" }, deadlines: [] },
  { id: "connecting", label: "Подключение", over: { activity: "connecting" }, noSnapshot: true },
  { id: "syncing", label: "Обновление", over: { activity: "syncing" }, deadlines: [] },
  { id: "thinking", label: "Ищет ответ", over: { activity: "thinking" }, deadlines: [] },
  { id: "empty", label: "Ничего не подключено", over: { availability: "empty" }, noSnapshot: true },
  { id: "unknown", label: "Нет данных (загрузка)", over: {}, noSnapshot: true },
  { id: "switch", label: "Сменили вуз, снимок ещё старый", over: {}, deadlines: [dl("a", "Работа другого вуза", HOUR)], foreignSnapshot: true },
];

function contextFor(f: Fixture, character: string, motion: "full" | "static", reduced: boolean, acknowledged: readonly string[]): AssistantContext {
  const spaceId = SPACE[character];
  const snapshotSpace = f.foreignSnapshot ? (spaceId === "hse" ? "misis" : "hse") : spaceId;
  const recentEvent = f.over.recentEvent ? { ...f.over.recentEvent, spaceId } : null;
  return {
    spaceId, nowMs: NOW, timeZone: "Europe/Moscow", availability: "ready", activity: "idle",
    snapshot: f.noSnapshot ? null : { spaceId: snapshotSpace, updatedAt: NOW - 5 * MIN, stale: !!f.stale, deadlines: f.deadlines ?? [] },
    preferences: { seasonal: true, motion: motion === "static" ? "calm" : "system" },
    reducedMotion: reduced, lite: false, visible: true, acknowledgedEventIds: acknowledged,
    ...f.over, recentEvent,
  };
}

const q = new URLSearchParams(location.search);
const pickParam = <T extends string>(key: string, allowed: readonly T[], fallback: T) => {
  const v = q.get(key) as T | null;
  return v && allowed.includes(v) ? v : fallback;
};

function Catalog() {
  const [character, setCharacter] = useState(pickParam("character", ["varya", "dusya", "unknown"] as const, "varya"));
  const [theme, setTheme] = useState(pickParam("theme", ["light", "dark"] as const, "light"));
  const [motion, setMotion] = useState(pickParam("motion", ["full", "static"] as const, "full"));
  const [size, setSize] = useState(Number(pickParam("size", ["46", "72", "120"] as const, "72")));
  const [nightcap, setNightcap] = useState(q.get("nightcap") === "1");
  const [replay, setReplay] = useState(0);
  // Показанные реакции на сдачу: после показа карточка сообщает о них, и они не повторяются, пока не нажата «Проиграть заново».
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => { document.documentElement.dataset.scheme = theme; }, [theme]);

  const seg = <T extends string | number>(label: string, value: T, options: readonly [T, string][], set: (v: T) => void) => (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span className="mr-1 text-s font-bold text-hint">{label}</span>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} onClick={() => set(v)}
          className={`min-h-11 rounded-2xl px-3 text-s font-bold ${v === value ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{text}</button>
      ))}
    </fieldset>
  );

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 bg-page px-4 py-6 text-text">
      <header>
        <h1 className="text-xl font-bold">Каталог маскотов</h1>
        <p className="mt-1 text-m text-hint">Синтетические данные, часы стоят на 25 октября 2026, 12:00 МСК. Ничего не загружается.</p>
      </header>
      <div className="flex flex-col gap-2">
        {seg("Персонаж", character, [["varya", "Варя (ВШЭ)"], ["dusya", "Дуся (МИСИС)"], ["unknown", "Неизвестный вуз"]], setCharacter)}
        {seg("Тема", theme, [["light", "Светлая"], ["dark", "Тёмная"]], setTheme)}
        {seg("Движение", motion, [["full", "Обычное"], ["static", "Спокойное"]], setMotion)}
        {seg("Размер", size, [[46, "46"], [72, "72"], [120, "120"]], setSize)}
        {seg("Колпак", nightcap ? "on" : "off", [["off", "Нет"], ["on", "Ночной"]], (v) => setNightcap(v === "on"))}
        <div><button type="button" onClick={() => { setAcknowledged([]); setReplay((n) => n + 1); }} className="min-h-11 rounded-2xl bg-raised px-3 text-s font-bold">Проиграть реакции заново</button></div>
      </div>
      <section className="flex flex-col gap-3 rounded-[20px] bg-card p-3.5" aria-label="Заставки загрузки" data-fixture="loaders">
        <p className="text-s font-bold text-hint">Заставка загрузки · бег на месте и полоска без процентов</p>
        <MascotLoader character="varya" label="Тащу в гнездо сроки из LMS" dark={theme === "dark"} motion={motion === "static" || reduced ? "static" : "full"} size={size} />
        <MascotLoader character="dusya" label="Собираю расписание" dark={theme === "dark"} motion={motion === "static" || reduced ? "static" : "full"} size={size} />
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIXTURES.map((f) => {
          const p = resolveAssistantPresentation(contextFor(f, character, motion, reduced, acknowledged));
          return (
            <div key={`${f.id}:${replay}`} className="flex min-w-0 flex-col gap-1.5" data-fixture={f.id}>
              <p className="text-s font-bold text-hint">{f.label} · <code>{p.status}</code></p>
              <MascotCard presentation={p} nowMs={NOW} dark={theme === "dark"} size={size} nightcap={nightcap}
                onReactionShown={(id) => setAcknowledged((a) => (a.includes(id) ? a : [...a, id]))} />
            </div>
          );
        })}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Catalog /></StrictMode>);
