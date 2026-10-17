import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, Copy, Mail, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../store/api";
import { haptic, tg } from "../telegram/webapp";
import { spring } from "../theme/motion";
import { Tile, TileLabel } from "./Tile";
import { toast } from "./Toast";

interface Campus {
  id: string; name: string; url: string;
  rating: { value: number | null; weight: number | null; count: number };
  criteria: { title: string; value: number }[];
  tags: { title: string; percentage: number }[];
  reviews: { text: string; value: number | null; at: string; tags: string[] }[];
}
interface Teacher { id: number; name: string; email: string | null; role: string | null; campus: Campus | null }
/** Курс Moodle для экрана «Курс»: полное название, описание (текстом) и адрес страницы курса. */
export interface CourseCard { id: number; fullname: string; summary: string; url: string }
const cache = new Map<number, Teacher[]>();
const courseCache = new Map<number, CourseCard | null>();

/**
 * «Написать»: письмо преподавателю в почтовом приложении телефона (Mail.ru, если оно выбрано почтой по умолчанию —
 * на iPhone: Настройки → Почта Mail.ru → «Приложение почты по умолчанию», на Android — выбор «Всегда» в окне выбора).
 * Публичной схемы для прямого запуска приложения Mail.ru нет, а Telegram.WebApp.openLink принимает только http(s),
 * поэтому mailto уходит через навигацию WebView. Если через 1,2 с мы всё ещё на экране — телефон ссылку не принял,
 * тогда открываем письмо в веб-версии Почты Mail.ru (браузер). Адрес заодно копируется в буфер.
 */
async function writeTo(t: Teacher) {
  if (!t.email) return;
  const email = t.email, subject = encodeURIComponent("Вопрос по курсу");
  const mailto = `mailto:${email}?subject=${subject}`;
  const web = `https://e.mail.ru/compose/?to=${encodeURIComponent(email)}&subject=${subject}`;
  try { await navigator.clipboard.writeText(email); } catch { /* буфер недоступен — не страшно */ }
  haptic.tap();
  let left = false;
  const onHide = () => { if (document.visibilityState === "hidden") left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  try { location.href = mailto; } catch { /* ниже — запасной путь */ }
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (left || document.visibilityState === "hidden") return;
    if (tg?.openLink) tg.openLink(web); else window.open(web, "_blank");
  }, 1200);
}


/** Преподаватели курса с сервера (Moodle + «Кампус»), с кэшем на сессию; null — ещё грузится. */
export function useTeachers(courseId: number) {
  const [list, setList] = useState<Teacher[] | null>(cache.get(courseId) ?? null);
  useEffect(() => {
    if (cache.has(courseId)) { setList(cache.get(courseId)!); return; }
    api<{ teachers: Teacher[]; course?: CourseCard }>(`api/teachers?course=${courseId}`)
      .then((r) => { cache.set(courseId, r.teachers); courseCache.set(courseId, r.course ?? null); setList(r.teachers); })
      .catch(() => setList([]));
  }, [courseId]);
  return list;
}
/** Описание курса из Moodle (приходит тем же запросом, что и преподаватели); undefined — ещё грузится. */
export function useCourseCard(courseId: number): CourseCard | null | undefined {
  const list = useTeachers(courseId); // тот же запрос и тот же кэш
  return list === null ? undefined : courseCache.get(courseId) ?? null;
}
/** «Колистратов Максим Васильевич» → «Колистратов М. В.» */
const short = (name: string) => name.trim().split(/\s+/).map((w, i) => (i ? `${w[0]}.` : w)).join(" ");

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(1).replace(".", ","));
const when = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { month: "short", year: "numeric" });
const plural = (n: number, one: string, few: string, many: string) => { const m = n % 100, d = n % 10; return m >= 11 && m <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many; };

/**
 * Преподаватели курса из Moodle (контакты курса): имя, роль, почта — скопировать или написать.
 * Справа — оценка из «Кампуса» (публичные отзывы студентов); нажатие раскрывает критерии, теги и последние отзывы.
 */
export function Teachers({ courseId, title = "Преподаватели", index = 2, showEmpty = false, reviews = true }: { courseId: number; title?: string; index?: number; showEmpty?: boolean; reviews?: boolean }) {
  const list = useTeachers(courseId);
  const [open, setOpen] = useState<number | null>(null);
  if (!list?.length) {
    if (!showEmpty) return null;
    return <Tile index={index} className="!min-h-0 py-3"><TileLabel>{title}</TileLabel><p className="mt-1 text-s text-hint">{list ? "В Moodle у курса не указаны преподаватели" : "Загружаю…"}</p></Tile>;
  }

  const copy = async (t: Teacher) => {
    if (!t.email) return;
    try { await navigator.clipboard.writeText(t.email); haptic.success(); toast("Почта скопирована"); }
    catch { toast(t.email); }
  };

  return (
    <Tile index={index} className="!min-h-0 py-1">
      <TileLabel className="pt-2">{title}</TileLabel>
      {list.map((t, i) => {
        const c = t.campus, rated = !!c && c.rating.count > 0, expanded = open === t.id;
        return (
          <div key={t.id} className={`py-2 ${i < list.length - 1 ? "border-b border-separator" : ""}`}>
            <div className="flex min-h-12 items-center gap-3">
              <button onClick={() => { if (!c) return; haptic.select(); setOpen(expanded ? null : t.id); }} className="min-w-0 flex-1 text-left" aria-expanded={expanded}>
                <p className="truncate text-m font-semibold">{t.name}</p>
                <p className="flex items-center gap-1.5 truncate text-s text-hint">
                  {rated ? (
                    <><Star size={13} strokeWidth={2.5} className="shrink-0 fill-yellow text-yellow" /><span className="font-bold text-text">{fmt(c!.rating.value)}</span>
                      <span>· {c!.rating.count} {plural(c!.rating.count, "оценка", "оценки", "оценок")} в Кампусе</span>
                      <ChevronDown size={14} className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} /></>
                  ) : c ? <span>Есть в Кампусе, оценок пока нет</span> : <span>{[t.role, t.email].filter(Boolean).join(" · ") || "почта скрыта"}</span>}
                </p>
              </button>
              {t.email && (
                <>
                  <button onClick={() => copy(t)} aria-label="Скопировать почту" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent"><Copy size={17} strokeWidth={2.25} /></button>
                  <button onClick={() => writeTo(t)} aria-label="Написать" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent"><Mail size={17} strokeWidth={2.25} /></button>
                </>
              )}
            </div>
            <AnimatePresence initial={false}>
              {expanded && c && (
                <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring(420, 34)} className="overflow-hidden">
                  {t.email && <p className="mt-1 text-s text-hint">{[t.role, t.email].filter(Boolean).join(" · ")}</p>}
                  {c.criteria.length > 0 && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      {c.criteria.map((k) => (
                        <div key={k.title} className="flex items-center gap-3 text-s">
                          <span className="w-44 shrink-0 truncate text-hint">{k.title}</span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-yellow" style={{ width: `${Math.max(0, Math.min(100, (k.value / 5) * 100))}%` }} /></span>
                          <span className="w-7 text-right font-bold tabular">{fmt(k.value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {c.tags.length > 0 && (
                    <p className="mt-3 flex flex-wrap gap-1.5">
                      {c.tags.map((g) => <span key={g.title} className="rounded-full bg-raised px-2.5 py-1 text-[12px] font-semibold text-hint">{g.title} · {g.percentage}%</span>)}
                    </p>
                  )}
                  {reviews && c.reviews.map((r, j) => (
                    <div key={j} className="mt-3 rounded-2xl bg-raised p-3">
                      <p className="flex items-center gap-2 text-[12px] font-bold text-hint"><Star size={12} strokeWidth={2.5} className="fill-yellow text-yellow" />{fmt(r.value)}<span className="font-medium">· {when(r.at)}</span></p>
                      <p className="mt-1 line-clamp-5 text-s leading-[18px]">{r.text}</p>
                    </div>
                  ))}
                </m.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </Tile>
  );
}

/**
 * Плашка под названием лабораторной или теста: чипы «★ 5,0 · Колистратов М. В.» по каждому преподавателю курса.
 * Нажатие раскрывает почту, критерии, теги и последние отзывы из «Кампуса».
 */
export function TeacherPlaque({ courseId }: { courseId: number }) {
  const list = useTeachers(courseId);
  const [open, setOpen] = useState<number | null>(null);
  if (!list?.length) return null;
  const copy = async (t: Teacher) => {
    if (!t.email) return;
    try { await navigator.clipboard.writeText(t.email); haptic.success(); toast("Почта скопирована"); }
    catch { toast(t.email); }
  };
  const cur = list.find((t) => t.id === open);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => {
          const c = t.campus, rated = !!c && c.rating.count > 0, active = open === t.id;
          return (
            <button key={t.id} onClick={() => { haptic.select(); setOpen(active ? null : t.id); }} aria-expanded={active}
              className={`flex min-h-8 items-center gap-1.5 rounded-full px-3 text-s font-semibold transition-colors ${active ? "bg-accent text-on-accent" : "glass text-text"}`}>
              {rated && <><Star size={12} strokeWidth={2.5} className={active ? "fill-on-accent text-on-accent" : "fill-yellow text-yellow"} /><span className="font-bold">{fmt(c!.rating.value)}</span><span className={active ? "opacity-70" : "text-hint"}>·</span></>}
              <span className="truncate">{short(t.name)}</span>
            </button>
          );
        })}
      </div>
      <AnimatePresence initial={false}>
        {cur && (
          <m.div key={cur.id} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring(420, 34)} className="overflow-hidden">
            <div className="glass-tile mt-2 rounded-2xl p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-m font-semibold">{cur.name}</p>
                  <p className="truncate text-s text-hint">{[cur.role, cur.email].filter(Boolean).join(" · ") || "почта скрыта"}{cur.campus && cur.campus.rating.count > 0 && ` · ${cur.campus.rating.count} ${plural(cur.campus.rating.count, "оценка", "оценки", "оценок")} в Кампусе`}</p>
                </div>
                {cur.email && (
                  <>
                    <button onClick={() => copy(cur)} aria-label="Скопировать почту" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent"><Copy size={17} strokeWidth={2.25} /></button>
                    <button onClick={() => writeTo(cur)} aria-label="Написать" className="glass grid size-10 shrink-0 place-items-center rounded-full text-accent"><Mail size={17} strokeWidth={2.25} /></button>
                  </>
                )}
              </div>
              {cur.campus ? (
                <>
                  {cur.campus.criteria.length > 0 && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      {cur.campus.criteria.map((k) => (
                        <div key={k.title} className="flex items-center gap-3 text-s">
                          <span className="w-44 shrink-0 truncate text-hint">{k.title}</span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-yellow" style={{ width: `${Math.max(0, Math.min(100, (k.value / 5) * 100))}%` }} /></span>
                          <span className="w-7 text-right font-bold tabular">{fmt(k.value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {cur.campus.tags.length > 0 && (
                    <p className="mt-3 flex flex-wrap gap-1.5">
                      {cur.campus.tags.map((g) => <span key={g.title} className="rounded-full bg-raised px-2.5 py-1 text-[12px] font-semibold text-hint">{g.title} · {g.percentage}%</span>)}
                    </p>
                  )}
                  {cur.campus.rating.count === 0 && <p className="mt-2 text-s text-hint">В «Кампусе» есть, оценок пока нет.</p>}
                </>
              ) : <p className="mt-2 text-s text-hint">В «Кампусе» не найден.</p>}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
