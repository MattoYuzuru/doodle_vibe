import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiV1Client, type UniversitySpace } from "../api/v1";
import { tg } from "../telegram/webapp";
import { UNIVERSITIES, type UniversityDef, slugify } from "./catalog";
import { sayError } from "./messages";
import { SpaceView } from "./SpaceView";

/*
 * Экран «Вузы» (#/universities): ВШЭ, МИСИС, ЦУ и «Свой вуз». Отдельный от прежних экранов поток на /api/v1: вход через
 * удалённый браузер, пароль с MFA, токен или календарь — как предложит сервер. Вне Telegram (локальный запуск) сервер
 * принимает синтетического пользователя dev-авторизации, поэтому initData может быть пустым.
 */

export const universitiesHash = (id?: string) => `#/universities${id ? `/${id}` : ""}`;
const sectionFromHash = (hash: string): UniversityDef["id"] => {
  const id = hash.match(/^#\/universities\/([a-z]+)/)?.[1];
  return UNIVERSITIES.find((u) => u.id === id)?.id ?? "hse";
};

export function UniversitiesApp() {
  const client = useMemo(() => createApiV1Client({ baseUrl: location.origin, initData: () => tg?.initData ?? "" }), []);
  const [section, setSection] = useState(() => sectionFromHash(location.hash));
  const [spaces, setSpaces] = useState<UniversitySpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customId, setCustomId] = useState<string | "new">("new");

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const load = useCallback(async () => {
    try { setSpaces((await client.spaces()).spaces); setError(null); } catch (e) { setError(sayError(e)); setSpaces((s) => s ?? []); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const presetIds = UNIVERSITIES.filter((u) => u.id !== "custom").map((u) => u.id as string);
  const customSpaces = (spaces ?? []).filter((s) => !presetIds.includes(s.universityId));
  useEffect(() => { if (customId === "new" && customSpaces.length === 1) setCustomId(customSpaces[0].id); }, [customSpaces, customId]);

  const ensureSpace = useCallback(async (def: UniversityDef, name: string) => {
    const universityId = def.id === "custom" ? slugify(name) : def.id;
    const existing = (spaces ?? []).find((s) => s.universityId === universityId);
    if (existing) return existing;
    const { space } = await client.createSpace(universityId, name);
    setSpaces((all) => [...(all ?? []), space]);
    return space;
  }, [client, spaces]);

  const def = UNIVERSITIES.find((u) => u.id === section)!;
  const space = def.id === "custom" ? customSpaces.find((s) => s.id === customId) ?? null : (spaces ?? []).find((s) => s.universityId === def.id) ?? null;
  const goBack = () => { history.replaceState(null, "", location.pathname + location.search); window.dispatchEvent(new HashChangeEvent("hashchange")); };

  return (
    <main className="space-ui mx-auto flex max-w-[480px] flex-col gap-4 px-4" style={{ paddingTop: "calc(8px + var(--safe-top))", paddingBottom: "calc(32px + var(--safe-bottom))" }} data-universities>
      <header className="flex items-center gap-2">
        <button type="button" onClick={goBack} aria-label="Назад в приложение" className="grid size-11 place-items-center rounded-2xl bg-card"><ChevronLeft size={22} /></button>
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Вузы</h1>
      </header>
      <nav className="flex flex-wrap gap-2" role="tablist" aria-label="Вуз">
        {UNIVERSITIES.map((u) => (
          <button key={u.id} type="button" role="tab" aria-selected={u.id === section} onClick={() => { location.hash = universitiesHash(u.id); }}
            className={`min-h-11 rounded-2xl px-4 text-m font-bold ${u.id === section ? "bg-accent text-on-accent" : "bg-card text-text"}`}>{u.short}</button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">
          <span className="flex-1">{error}</span>
          <button type="button" className="min-h-11 rounded-2xl bg-raised px-3 text-s font-bold text-text" onClick={() => void load()}>Повторить</button>
        </div>
      )}
      {def.id === "custom" && customSpaces.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Свои вузы">
          {customSpaces.map((s) => (
            <button key={s.id} type="button" aria-pressed={customId === s.id} onClick={() => setCustomId(s.id)}
              className={`min-h-11 rounded-2xl px-3 text-s font-bold ${customId === s.id ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{s.name}</button>
          ))}
          <button type="button" aria-pressed={customId === "new"} onClick={() => setCustomId("new")} className={`min-h-11 rounded-2xl px-3 text-s font-bold ${customId === "new" ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>+ Другой вуз</button>
        </div>
      )}
      {spaces === null ? <p role="status" className="text-m font-semibold text-hint">Загружаю…</p> : (
        <SpaceView key={`${def.id}:${def.id === "custom" ? customId : ""}`} client={client} def={def} space={space} ensureSpace={ensureSpace}
          onSpaceReady={def.id === "custom" ? (s) => setCustomId(s.id) : undefined} />
      )}
    </main>
  );
}
