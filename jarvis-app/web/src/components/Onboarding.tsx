import { AnimatePresence, m } from "framer-motion";
import { Bell, CalendarDays, LayoutGrid, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { haptic } from "../telegram/webapp";
import { spring } from "../theme/motion";

const KEY = "doodle.tour.v1";
// Хранилище недоступно — считаем, что знакомство уже видели: иначе оно показывалось бы при каждом запуске.
const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(KEY, "1"); } catch { /* хранилище недоступно */ } };
/** Знакомство открыто кнопкой «Что умеет Doodle» из чата бота (?open=tour). */
export const tourFromLink = () => new URLSearchParams(location.search).get("open") === "tour";
/** Знакомство ещё не показывали на этом устройстве. */
export const tourUnseen = () => !seen();

const SLIDES = [
  { icon: LayoutGrid, title: "Всё главное — на одном экране", text: "Дедлайны и оценки из Moodle, расписание группы, посещаемость и баллы из электронного журнала." },
  { icon: Bell, title: "Напомню сам", text: "За сутки и за 3 часа до срока. О новых заданиях и тестах, об открытии теста, об оценках и замечаниях преподавателя — сообщением бота." },
  { icon: CalendarDays, title: "Календарь и свои задачи", text: "Пары и сроки можно добавить в календарь телефона. Свои задачи и заметки живут рядом с учебными." },
  { icon: ShieldCheck, title: "Вход — учётной записью Moodle", text: "Пароль хранится в зашифрованном виде — только чтобы электронный журнал не просил его снова. Выйти можно в любой момент: пароль удалится." },
];

/**
 * Знакомство с приложением (просьба владельца, 5 окт 2026): четыре экрана при первом запуске — до входа в Moodle —
 * и по кнопке «Что умеет Doodle» в чате бота. Листается кнопкой и свайпом; «Пропустить» закрывает сразу.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const last = i === SLIDES.length - 1;
  const done = () => { markSeen(); haptic.success(); onDone(); };
  const go = (d: number) => {
    const n = i + d;
    if (n < 0) return;
    if (n >= SLIDES.length) return done();
    setDir(d); setI(n); haptic.select();
  };
  const s = SLIDES[i];
  const Icon = s.icon;
  return (
    <m.div
      role="dialog" aria-modal="true" aria-label="Знакомство с Doodle"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex flex-col bg-page"
      style={{ paddingTop: "calc(12px + var(--safe-top))", paddingBottom: "calc(20px + var(--safe-bottom))" }}
    >
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col px-5">
        <div className="flex min-h-11 items-center justify-end">
          {!last && <button onClick={done} className="min-h-11 px-2 text-m font-semibold text-hint">Пропустить</button>}
        </div>
        <div className="relative flex flex-1 items-center overflow-hidden">
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            <m.div
              key={i} custom={dir}
              variants={{ enter: (d: number) => ({ opacity: 0, x: 48 * d }), center: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: -48 * d }) }}
              initial="enter" animate="center" exit="exit" transition={spring(380, 32)}
              drag="x" dragDirectionLock dragConstraints={{ left: 0, right: 0 }} dragElastic={0.35}
              onDragEnd={(_, info) => { if (info.offset.x < -56) go(1); else if (info.offset.x > 56) go(-1); }}
              className="flex w-full flex-col items-center px-2 text-center"
            >
              <span className="grid size-24 place-items-center rounded-[28px] bg-accent/15 text-accent"><Icon size={44} strokeWidth={2.25} /></span>
              <h1 className="mt-7 font-display text-l font-extrabold tracking-[-0.03em]">{s.title}</h1>
              <p className="mt-3 text-m leading-[22px] text-hint">{s.text}</p>
            </m.div>
          </AnimatePresence>
        </div>
        <div className="flex justify-center gap-2 py-5" aria-hidden="true">
          {SLIDES.map((_, n) => <span key={n} className={`h-1.5 rounded-full transition-all duration-300 ${n === i ? "w-6 bg-accent" : "w-1.5 bg-separator"}`} />)}
        </div>
        <button onClick={() => go(1)} className="flex min-h-12 items-center justify-center rounded-2xl bg-accent text-m font-bold text-on-accent">
          {last ? "Начать" : "Дальше"}
        </button>
      </div>
    </m.div>
  );
}
