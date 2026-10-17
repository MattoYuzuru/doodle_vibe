import { ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { api } from "../store/api";
import { haptic } from "../telegram/webapp";

interface User {
  tgId: number; tgName: string | null; tgUsername: string | null; fullName: string | null; group: string | null;
  loggedIn: boolean; allowed: boolean; isOwner: boolean; labRequest: number | null; updatedAt: number | null;
}

/** Экран владельца: кто может делать отчёты с агентом (белый список), кто просит доступ. Переключатель пишет lab-allowlist.txt. */
export function AccessScreen() {
  const pop = useNav((s) => s.pop);
  const [users, setUsers] = useState<User[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<{ users: User[] }>("api/access").then((r) => { setUsers(r.users); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  const toggle = async (u: User) => {
    setBusy(u.tgId); haptic.select();
    try {
      const r = await api<{ users: User[] }>("api/access", { tgId: u.tgId, allowed: !u.allowed });
      setUsers(r.users);
      toast(!u.allowed ? `Отчёты открыты: ${u.tgName ?? u.fullName ?? u.tgId}` : `Отчёты закрыты: ${u.tgName ?? u.fullName ?? u.tgId}`);
    } catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(null); }
  };

  if (err === "owner_only") return <EmptyState icon={ShieldCheck} title="Только для владельца" text="Этим экраном управляет владелец бота." action="Назад" onAction={pop} />;
  const others = (users ?? []).filter((u) => !u.isOwner);

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Доступ к отчётам</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">Кому разрешены отчёты с агентом · тратят вашу подписку Claude</p>
      </div>
      {users === null && !err && <p className="px-1 text-s text-hint">Загружаю…</p>}
      {err && err !== "owner_only" && <p className="px-1 text-s font-semibold text-red">{err}</p>}
      {users !== null && others.length === 0 && (
        <Tile index={0} className="min-h-0"><EmptyState icon={Sparkles} title="Пока никого" text="Здесь появятся все, кто вошёл в Moodle через Doodle. Запросы доступа — сверху." /></Tile>
      )}
      {others.map((u, i) => (
        <Tile key={u.tgId} index={i} className="!min-h-0 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-m font-semibold">{u.tgName ?? u.fullName ?? `id ${u.tgId}`}{u.tgUsername && <span className="pl-1.5 font-medium text-hint">@{u.tgUsername}</span>}</p>
              <p className="truncate text-s text-hint">{[u.fullName, u.group].filter(Boolean).join(" · ") || "в Moodle не входил"} · id {u.tgId}</p>
              {u.labRequest && !u.allowed && <TileLabel className="mt-1 text-yellow normal-case tracking-normal">Просит доступ</TileLabel>}
              {!u.loggedIn && <TileLabel className="mt-1 normal-case tracking-normal">Вышел из Moodle</TileLabel>}
            </div>
            <button onClick={() => toggle(u)} disabled={busy === u.tgId} role="switch" aria-checked={u.allowed} aria-label="Отчёты с агентом"
              className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${u.allowed ? "bg-accent" : "bg-raised"}`}>
              <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition-[left] ${u.allowed ? "left-7" : "left-1"}`} />
            </button>
          </div>
        </Tile>
      ))}
      <p className="px-2 text-s text-hint">То же самое можно сделать на ПК в файле lab-allowlist.txt — по одному Telegram id в строке.</p>
    </div>
  );
}
