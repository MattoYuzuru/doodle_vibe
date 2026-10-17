import { Download, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { api } from "../store/api";
import { haptic } from "../telegram/webapp";

interface EnvItem { name: string; how: string; source: string; size: string; why: string }
/** Запрос агента окружения: что он не стал ставить без владельца (lab.mjs envRequests). */
interface EnvReq { tgId: number; id: string; title: string; course: string; at: number; items: EnvItem[] }

const keyOf = (r: EnvReq) => `${r.tgId}-${r.id}`;
const when = (at: number) => new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Экран владельца: запросы агента окружения на установку программ. «Разрешить» запускает установку отмеченного, остальное отклоняется. */
export function EnvRequestsScreen() {
  const pop = useNav((s) => s.pop);
  const [reqs, setReqs] = useState<EnvReq[] | null>(null);
  const [off, setOff] = useState<Record<string, string[]>>({}); // снятые галочки по запросам (по умолчанию отмечено всё)
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<{ requests: EnvReq[] }>("api/env-requests").then((r) => { setReqs(r.requests); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  const decide = async (r: EnvReq, approve: string[]) => {
    const k = keyOf(r);
    setBusy(k); haptic.select();
    try {
      const res = await api<{ requests: EnvReq[] }>("api/env-requests", { tgId: r.tgId, id: r.id, approve });
      setReqs(res.requests);
      toast(approve.length ? `Разрешено: ${approve.join(", ")} — агент ставит` : "Отклонено — лаба пойдёт с заменами");
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(null); }
  };

  if (err === "owner_only") return <EmptyState icon={Download} title="Только для владельца" text="Запросы на установку решает владелец бота." action="Назад" onAction={pop} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Запросы на установку</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">Что агент окружения не ставит на ПК без вашего слова</p>
      </div>
      {reqs === null && !err && <p className="px-1 text-s text-hint">Загружаю…</p>}
      {err && err !== "owner_only" && <p className="px-1 text-s font-semibold text-red">{err}</p>}
      {reqs !== null && reqs.length === 0 && (
        <Tile index={0} className="min-h-0"><EmptyState icon={Sparkles} title="Запросов нет" text="Когда агент усомнится в пакете или программе из методички, запрос появится здесь и придёт в Telegram." /></Tile>
      )}
      {(reqs ?? []).map((r, i) => {
        const k = keyOf(r), skip = off[k] ?? [], chosen = r.items.filter((x) => !skip.includes(x.name)).map((x) => x.name);
        return (
          <Tile key={k} index={i} className="!min-h-0 py-3">
            <p className="text-m font-semibold">{r.title}</p>
            <p className="text-s text-hint">{[r.course, r.tgId ? `пользователь ${r.tgId}` : null, when(r.at)].filter(Boolean).join(" · ")}</p>
            <div className="mt-2 flex flex-col gap-2">
              {r.items.map((x) => {
                const on = !skip.includes(x.name);
                return (
                  <label key={x.name} className="flex items-start gap-3">
                    <input type="checkbox" checked={on} onChange={() => { haptic.select(); setOff({ ...off, [k]: on ? [...skip, x.name] : skip.filter((n) => n !== x.name) }); }} className="mt-1 size-5 shrink-0 accent-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-m font-semibold">{x.name}{x.size && <span className="pl-1.5 font-medium text-hint">{x.size}</span>}</span>
                      <span className="block break-words text-s text-hint">{[x.how, x.source].filter(Boolean).join(" · ")}</span>
                      {x.why && <TileLabel className="mt-0.5 text-yellow normal-case tracking-normal">{x.why}</TileLabel>}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => decide(r, chosen)} disabled={busy === k || chosen.length === 0} className="flex-1 rounded-xl bg-accent px-3 py-2.5 text-m font-bold text-white disabled:opacity-50">Разрешить{chosen.length < r.items.length ? ` (${chosen.length})` : ""}</button>
              <button onClick={() => decide(r, [])} disabled={busy === k} className="flex-1 rounded-xl bg-raised px-3 py-2.5 text-m font-bold disabled:opacity-50">Отклонить всё</button>
            </div>
          </Tile>
        );
      })}
      <p className="px-2 text-s text-hint">Неотмеченное отклоняется. Пока решения нет, лаба идёт с заменами; после «Разрешить» агент ставит и сообщает в Telegram.</p>
    </div>
  );
}
