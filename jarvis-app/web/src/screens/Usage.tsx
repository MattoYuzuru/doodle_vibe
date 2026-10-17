import { Gauge, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { api } from "../store/api";
import { haptic } from "../telegram/webapp";

/**
 * Расход агента по пользователю (usage.mjs summary). Мера — токены с весом (monthTok, totalTok): по ним считается лимит.
 * month и total — справочная оценка в долларах по ценам API.
 */
interface UsageUser { tgId: number; month: number; total: number; monthTok: number; totalTok: number; calls: number; labs: number; monthLabs: number; last: string | null; limit: number | null; own: boolean; name: string | null; username: string | null; group: string | null; isOwner: boolean }
interface UsageLab { tgId: number; id: string; tok: number; raw: number; usd: number; calls: number; kinds: Record<string, number>; kindsTok: Record<string, number>; last: string | null; title: string | null; course: string | null; name: string | null }
interface UsageData { month: string; defaultLimit: number | null; users: UsageUser[]; labs: UsageLab[]; monthTotal: number; total: number; monthTok: number; totalTok: number; monthRaw: number; totalRaw: number; other: Record<"chat" | "service", { monthTok: number; totalTok: number }>; labsCount: number; avgLab: number | null; avgLabTok: number | null; limitsBroken?: boolean; source: "transcripts" | "reported" }

const usd = (x: number) => `$${x.toFixed(2).replace(".", ",")}`;
/** Расход: «4,5 млн», «350 тыс.», «900» */
const tok = (x: number) => (x >= 999500 ? `${(x / 1e6).toFixed(1).replace(".", ",").replace(/,0$/, "")} млн` : x >= 1000 ? `${Math.round(x / 1000)} тыс.` : String(Math.round(x)));
/** Лимит — без потери точности: «5 млн», «1,25 млн», «125 тыс.» (то же число, что владелец ввёл). */
const lim = (x: number) => (x >= 1e6 ? `${String(x / 1e6).replace(".", ",")} млн` : x >= 1000 ? `${String(x / 1000).replace(".", ",")} тыс.` : String(x));
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;
const dayOf = (d: string | null) => (d ? `${Number(d.slice(8, 10))}.${d.slice(5, 7)}` : "");
const KIND: Record<string, string> = { lab: "отчёт", env: "установка программ", check: "проверка отчёта" };
/** Поле лимита — в миллионах токенов: «5» → 5 000 000, «0,5» → 500 000, пусто → без лимита. */
const toLimit = (s: string) => (s.trim() === "" ? null : Math.round(Number(s.replace(",", ".").replace(/\s/g, "")) * 1e6));
const fromLimit = (v: number | null) => (v == null ? "" : String(v / 1e6).replace(".", ","));
/** Самое большое, что принимает поле: 1000 млн. Больше — почти наверняка ввели токены, а не миллионы. */
const MAX_FIELD = 1e9;
/** Самый маленький лимит, кроме явного нуля: тысяча токенов. */
const MIN_FIELD = 1000;
/** «3 работы», «1 работа», «5 работ» */
const works = (n: number) => { const d = n % 10, h = n % 100; return `${n} ${d === 1 && h !== 11 ? "работа" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "работы" : "работ"}`; };
/** Сколько средних работ помещается в лимит — словами. */
const fits = (limit: number, avg: number) => (limit < avg ? "меньше одной средней работы" : `примерно ${works(Math.floor(limit / avg))}`);

/** Экран владельца: сколько токенов агент потратил на каждого пользователя и работу, и месячные лимиты в токенах. */
export function UsageScreen() {
  const pop = useNav((s) => s.pop);
  const [d, setD] = useState<UsageData | null>(null);
  const [err, setErr] = useState("");
  const [common, setCommon] = useState("");
  const [edit, setEdit] = useState<number | null>(null); // чей личный лимит сейчас правится
  const [personal, setPersonal] = useState("");
  const [busy, setBusy] = useState(false);
  // keepCommon — сохранён личный лимит: набранное в поле общего лимита не трогаем.
  const take = (r: UsageData, keepCommon = false) => { setD(r); if (!keepCommon) setCommon(fromLimit(r.defaultLimit)); setErr(""); };
  useEffect(() => { api<UsageData>("api/usage").then((r) => take(r)).catch((e) => setErr((e as Error).message)); }, []);

  const save = async (tgId: number | null, text: string) => {
    const limit = toLimit(text);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) { haptic.warning(); toast("Лимит — число в миллионах токенов, например 5"); return; }
    if (limit !== null && limit > MAX_FIELD) { haptic.warning(); toast("Поле — в миллионах токенов: чтобы поставить 5 миллионов, введите 5"); return; }
    // Положительное, но меньше тысячи токенов — почти наверняка опечатка: округлилось бы до нуля и закрыло бы агента. Ноль — только явным «0».
    if (limit !== null && limit < MIN_FIELD && Number(text.replace(",", ".").replace(/\s/g, "")) !== 0) { haptic.warning(); toast("Слишком мало: поле — в миллионах токенов, например 0,5. Чтобы закрыть работу агента, введите 0"); return; }
    setBusy(true); haptic.select();
    try {
      take(await api<UsageData>("api/usage", { tgId, limit }), tgId !== null);
      setEdit(null);
      toast(limit === null ? (tgId === null ? "Общий лимит снят" : "Личный лимит снят — действует общий") : limit === 0 ? "Лимит 0: работа агента закрыта" : `Лимит ${lim(limit)} токенов в месяц сохранён`);
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(false); }
  };

  if (err === "owner_only") return <EmptyState icon={Gauge} title="Только для владельца" text="Расход и лимиты видит владелец бота." action="Назад" onAction={pop} />;

  // Подсказка под полем считается от того, что сейчас набрано (пусто — от примера в 5 млн).
  const typed = toLimit(common);
  const sample = typed !== null && Number.isFinite(typed) && typed > 0 && typed <= MAX_FIELD ? typed : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Расход и лимиты</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">Сколько токенов потратил агент</p>
      </div>
      {d === null && !err && <p className="px-1 text-s text-hint">Считаю…</p>}
      {err && err !== "owner_only" && <p className="px-1 text-s font-semibold text-red">{err}</p>}
      {d && (
        <>
          {d.limitsBroken && (
            <p className="rounded-2xl bg-red/15 px-4 py-3 text-s font-semibold text-red">Файл лимитов на сервере не читается: пользователям с лимитом агент сейчас отказывает. Сохраните общий лимит заново — файл будет создан с нуля (личные лимиты придётся задать ещё раз).</p>
          )}
          <Tile index={0} className="!min-h-0 py-3">
            <TileLabel>За {monthName(d.month)}</TileLabel>
            <p className="font-display mt-1 text-[30px] leading-none font-extrabold tracking-[-0.03em] tabular">{tok(d.monthTok)}<span className="pl-2 text-m font-bold text-hint">токенов с весом</span></p>
            <p className="mt-2 text-s font-semibold text-hint">
              За всё время {tok(d.totalTok)} · работ {d.labsCount}{d.avgLabTok != null ? ` · в среднем ${tok(d.avgLabTok)} за работу` : ""}
            </p>
            <p className="mt-1 text-[12px] font-semibold text-hint">Простой суммой, как в журнале Claude: {tok(d.monthRaw)} за месяц, {tok(d.totalRaw)} за всё время</p>
          </Tile>

          <Tile index={1} className="!min-h-0 py-3">
            <TileLabel>Общий лимит на пользователя в месяц</TileLabel>
            <div className="mt-2 flex items-center gap-2">
              <input value={common} onChange={(e) => setCommon(e.target.value)} inputMode="decimal" placeholder="без лимита" aria-label="Общий лимит, миллионов токенов в месяц"
                className="min-h-11 min-w-0 flex-1 rounded-xl bg-raised px-3 text-m font-semibold outline-none" />
              <span className="shrink-0 text-s font-bold text-hint">млн токенов</span>
              <button onClick={() => save(null, common)} disabled={busy} className="min-h-11 rounded-xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50">Сохранить</button>
            </div>
            <p className="mt-2 text-s text-hint">
              Пусто — без лимита.{d.avgLabTok ? ` Средняя работа — около ${tok(d.avgLabTok)}, самая тяжёлая — ${tok(d.labs[0]?.tok ?? d.avgLabTok)}: ${sample ? `лимит ${lim(sample)}` : "например, лимит 5 млн"} — это ${fits(sample ?? 5e6, d.avgLabTok)} в месяц.` : ""}
            </p>
            <p className="mt-1.5 text-s text-hint">
              На 100 % пользователю до 1-го числа закрываются новый отчёт, исправление по замечаниям и проверка своего отчёта; дописать начатую работу в чате можно, пока расход не дойдёт до 125 %. Вторую работу одновременно с идущей агент не начнёт, если остатка лимита не хватает на обычную работу. Вам придёт сообщение на 80 % и на 100 %. На вас лимит не действует.
            </p>
          </Tile>

          <TileLabel className="px-1 pt-1">Пользователи · за {monthName(d.month)}</TileLabel>
          {d.users.length === 0 && <p className="px-1 text-s text-hint">Агент ещё ни для кого не работал.</p>}
          {d.users.map((u, i) => {
            const share = u.limit ? Math.min(1, u.monthTok / u.limit) : 0, percent = u.limit ? Math.floor((u.monthTok * 100) / u.limit) : u.limit === 0 ? 100 : null;
            const color = percent == null ? "var(--c-accent)" : percent >= 100 ? "var(--c-red)" : percent >= 80 ? "var(--c-yellow)" : "var(--c-accent)";
            return (
              <Tile key={u.tgId} index={i + 2} className="!min-h-0 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-m font-bold">{u.name ?? `id ${u.tgId}`}{u.isOwner ? " (вы)" : ""}</p>
                    <p className="truncate text-s text-hint">{[u.username ? `@${u.username}` : null, u.group, `всего работ ${u.labs}`, u.last ? `последняя ${dayOf(u.last)}` : null].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-[20px] leading-none font-extrabold tabular">{tok(u.monthTok)}</p>
                    <p className="mt-1 text-[12px] font-semibold text-hint">за всё время {tok(u.totalTok)}</p>
                  </div>
                </div>
                {!u.isOwner && (
                  <>
                    {u.limit != null && (
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${(u.limit === 0 ? 1 : share) * 100}%`, background: color }} /></div>
                    )}
                    {edit === u.tgId ? (
                      <div className="mt-2.5 flex items-center gap-2">
                        <input value={personal} onChange={(e) => setPersonal(e.target.value)} inputMode="decimal" autoFocus placeholder="как у всех" aria-label="Личный лимит, миллионов токенов в месяц"
                          className="min-h-10 min-w-0 flex-1 rounded-xl bg-raised px-3 text-m font-semibold outline-none" />
                        <span className="shrink-0 text-[12px] font-bold text-hint">млн токенов</span>
                        <button onClick={() => save(u.tgId, personal)} disabled={busy} className="min-h-10 rounded-xl bg-accent px-3 text-s font-bold text-on-accent disabled:opacity-50">Сохранить</button>
                        <button onClick={() => setEdit(null)} className="min-h-10 rounded-xl bg-raised px-3 text-s font-bold">Отмена</button>
                      </div>
                    ) : (
                      <button onClick={() => { haptic.select(); setEdit(u.tgId); setPersonal(u.own ? fromLimit(u.limit) : ""); }}
                        className="mt-2 flex min-h-9 items-center gap-1.5 text-s font-bold text-accent">
                        <Pencil size={14} strokeWidth={2.5} />
                        {u.limit == null ? "Без лимита" : u.limit === 0 ? "Закрыто (лимит 0)" : `${percent} % из ${lim(u.limit)} токенов${u.own ? " · личный лимит" : ""}`}
                      </button>
                    )}
                  </>
                )}
              </Tile>
            );
          })}

          {(d.other.chat.totalTok > 0 || d.other.service.totalTok > 0) && (
            <Tile index={d.users.length + 2} className="!min-h-0 py-3">
              <TileLabel>Не входит в лимиты · за {monthName(d.month)}</TileLabel>
              {d.other.chat.totalTok > 0 && (
                <div className="mt-1.5 flex items-baseline justify-between gap-3"><span className="text-s font-semibold">Ваш чат с ботом</span><span className="shrink-0 text-s font-bold tabular">{tok(d.other.chat.monthTok)}<span className="pl-1.5 font-semibold text-hint">всего {tok(d.other.chat.totalTok)}</span></span></div>
              )}
              {d.other.service.totalTok > 0 && (
                <div className="mt-1.5 flex items-baseline justify-between gap-3"><span className="text-s font-semibold">Служебные сессии</span><span className="shrink-0 text-s font-bold tabular">{tok(d.other.service.monthTok)}<span className="pl-1.5 font-semibold text-hint">всего {tok(d.other.service.totalTok)}</span></span></div>
              )}
              <p className="mt-2 text-[12px] font-semibold text-hint">Это тоже тратит вашу подписку, но не относится ни к одному пользователю. Дедлайны, расписание, журнал и уведомления токенов не тратят совсем.</p>
            </Tile>
          )}

          {d.labs.length > 0 && <TileLabel className="px-1 pt-1">Работы за всё время — от тяжёлых к лёгким{d.labsCount > d.labs.length ? ` (первые ${d.labs.length})` : ""}</TileLabel>}
          {d.labs.length > 0 && (
            <Tile index={d.users.length + 3} className="!min-h-0 py-1">
              {d.labs.map((l, i) => (
                <div key={`${l.tgId}:${l.id}`} className={`flex items-start justify-between gap-3 py-2.5 ${i ? "border-t border-separator" : ""}`}>
                  <div className="min-w-0">
                    <p className="truncate text-m font-semibold">{l.title ?? `Задание ${l.id}`}</p>
                    <p className="truncate text-s text-hint">{[l.name ?? `id ${l.tgId}`, dayOf(l.last), `${l.calls} обращений к модели`].filter(Boolean).join(" · ")}</p>
                    {(Object.keys(l.kindsTok).length > 1 || !l.kindsTok.lab) && (
                      <p className="truncate text-[12px] font-semibold text-hint">{Object.entries(l.kindsTok).map(([k, v]) => `${KIND[k] ?? k} ${tok(v)}`).join(" · ")}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-m font-bold tabular">{tok(l.tok)}</p>
                    <p className="text-[12px] font-semibold text-hint">в журнале {tok(l.raw)}</p>
                  </div>
                </div>
              ))}
            </Tile>
          )}
          <p className="px-2 text-s text-hint">
            Что входит в счёт: всё, что агент делает по работе пользователя, — отчёт, вопросы и правки, исправление по замечаниям, «Кратко о работе», установка программ и проверка своего отчёта.
          </p>
          <p className="px-2 text-s text-hint">
            Токены считаются с весом: текст, написанный моделью, — за 5, повторное чтение переписки из кэша — за 0,1, запись в кэш — за 1,25–2, новый ввод — за 1; у более тяжёлой модели всё умножается (от 0,5 у Haiku до 2–5 у Opus и Fable; у Sonnet, на которой работает агент, — на 1). Поэтому число не совпадает с журналом Claude, где всё сложено подряд: у длинных работ оно в несколько раз меньше, потому что почти вся сумма в журнале — дешёвое повторное чтение. Это приближение: точную формулу лимитов подписки Anthropic не публикует. Для справки: 1 млн таких токенов — это {usd(d.totalTok ? (d.total / d.totalTok) * 1e6 : 2)} по ценам API.
          </p>
          <p className="px-2 text-s text-hint">
            {d.source === "transcripts"
              ? "Считается по журналам Claude на этом ПК: каждое обращение агента к модели."
              : "Журналов Claude на этом ПК нет — считается по отчётам агента о расходе, это заниженная оценка."}
          </p>
        </>
      )}
    </div>
  );
}
