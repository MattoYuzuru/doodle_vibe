import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiV1Client, AuthMethod, Connection, Job, LoginSession, UniversitySpace } from "../api/v1";
import { MascotLoader } from "../components/assistant/MascotCard";
import { useScheme } from "../hooks/useScheme";
import { useMascotMotion } from "../hooks/useSpace";
import { characterFor } from "../lib/space-adapter";
import { AuthPanel, type PresetCredentials } from "./AuthPanel";
import { KIND_LABELS, type PresetSource, type SourceKind, type UniversityDef, hostOf, normalizeSourceUrl, originOf } from "./catalog";
import { LoginFlow } from "./LoginFlow";
import { sayCode, sayError, wordCode } from "./messages";
import { Results, type SpaceResults, fmtStamp } from "./Results";

/*
 * Один вуз: его источники (из пресета или введённые), вход там, где он нужен, и полученные данные.
 * Порядок как просил владелец: адрес уже подставлен, креды вводятся по желанию, «Подключить» — и дальше сервер сам
 * определяет сайт; если нужен вход, пользователя ведут в нужный способ. Протухшая сессия — кнопка «Войти снова».
 */

const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none focus-visible:ring-2 focus-visible:ring-accent";
const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";
const secondary = "min-h-11 rounded-2xl bg-raised px-4 text-m font-bold text-text disabled:opacity-50";
const EMPTY: SpaceResults = { schedule: null, deadlines: null, courses: null, documents: null, failed: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Detail { authMethods: AuthMethod[]; login: LoginSession | null }
interface Draft { url: string; username: string; password: string; kind: SourceKind; name: string }
const draftOf = (p?: PresetSource): Draft => ({ url: p?.url ?? "", username: "", password: "", kind: p?.kind ?? "lms", name: "" });

interface Props {
  client: ApiV1Client;
  def: UniversityDef;
  space: UniversitySpace | null;
  /** Создаёт пространство вуза при первом подключении. */
  ensureSpace: (def: UniversityDef, name: string) => Promise<UniversitySpace>;
  /** Источник подключён в этом пространстве (для «Своего вуза»: перейти к нему). */
  onSpaceReady?: (space: UniversitySpace) => void;
}

export function SpaceView({ client, def, space, ensureSpace, onSpaceReady }: Props) {
  const [spaceId, setSpaceId] = useState<string | null>(space?.id ?? null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [results, setResults] = useState<SpaceResults>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [work, setWork] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reauth, setReauth] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>(() => def.sources.map(draftOf));
  const [extra, setExtra] = useState<Draft>(() => draftOf());
  const [bound, setBound] = useState<Record<number, string>>({});
  const [busyDraft, setBusyDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const dark = useScheme() === "dark";
  const motion = useMascotMotion();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async (id: string) => {
    let list: Connection[] = [];
    try {
      list = (await client.connections(id)).connections;
      if (!alive.current) return list;
      setConnections(list);
      setError(null);
      const entries = await Promise.all(list.map(async (c): Promise<[string, Detail]> => {
        try { const d = await client.connection(c.id); return [c.id, { authMethods: d.authMethods, login: d.login }]; }
        catch { return [c.id, { authMethods: [], login: null }]; }
      }));
      if (alive.current) setDetails((prev) => Object.fromEntries(entries.map(([cid, d]) => [cid, d.authMethods.length || d.login || !prev[cid] ? d : prev[cid]])));
    } catch (e) { if (alive.current) setError(sayError(e)); }
    const names = ["расписание", "дедлайны", "курсы", "документы"];
    const settled = await Promise.allSettled([client.items(id, "schedule"), client.items(id, "deadlines"), client.items(id, "courses"), client.documents(id)]);
    if (!alive.current) return list;
    setResults((prev) => {
      const pick = <T,>(i: number, old: T) => (settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<T>).value : old);
      return {
        schedule: pick(0, prev.schedule), deadlines: pick(1, prev.deadlines), courses: pick(2, prev.courses),
        documents: settled[3].status === "fulfilled" ? settled[3].value.documents : prev.documents,
        failed: names.filter((_, i) => settled[i].status === "rejected"),
      };
    });
    setNow(Date.now());
    setLoaded(true);
    return list;
  }, [client]);

  useEffect(() => { if (spaceId) void refresh(spaceId); else setLoaded(true); }, [spaceId, refresh]);

  // Сервер ещё проверяет сайт или синхронизирует: переспрашиваем, пока подключение «в работе» (не бесконечно).
  const polls = useRef(0);
  const pending = connections.some((c) => c.status === "pending");
  useEffect(() => {
    if (!pending || !spaceId || polls.current >= 40) return;
    const t = setTimeout(() => { polls.current += 1; void refresh(spaceId); }, 2000);
    return () => clearTimeout(t);
  }, [pending, spaceId, connections, refresh]);
  useEffect(() => { if (!pending) polls.current = 0; }, [pending]);

  const waitJob = async (job: Job): Promise<Job> => {
    let current = job;
    for (let i = 0; i < 45 && alive.current; i++) {
      if (current.status === "succeeded" || current.status === "failed") return current;
      await sleep(i === 0 ? 0 : 1000);
      current = (await client.job(job.id)).job;
    }
    return current;
  };
  const mark = (id: string, label: string | null) => setWork((w) => { const next = { ...w }; if (label) next[id] = label; else delete next[id]; return next; });
  const note = (id: string, message: string | null) => setNotes((n) => { const next = { ...n }; if (message) next[id] = message; else delete next[id]; return next; });

  /** Дождаться задачи, обновить данные и вернуть свежее подключение. */
  const settle = async (id: string, job: Job, label: string) => {
    mark(id, label);
    try { await waitJob(job); } catch (e) { note(id, sayError(e)); }
    const list = spaceId ? await refresh(spaceId) : [];
    mark(id, null);
    return list.find((c) => c.id === id) ?? null;
  };

  const connect = async (draft: Draft, key: string, index?: number) => {
    const sourceUrl = normalizeSourceUrl(draft.url);
    setDraftError((m) => ({ ...m, [key]: "" }));
    if (!sourceUrl) { setDraftError((m) => ({ ...m, [key]: sayCode("UNSAFE_SOURCE_URL") })); return; }
    setBusyDraft(key);
    const credentials: PresetCredentials | undefined = draft.username.trim() && draft.password ? { username: draft.username.trim(), password: draft.password } : undefined;
    let sp: UniversitySpace | null = null;
    try {
      sp = space ?? (spaceId ? { id: spaceId } as UniversitySpace : await ensureSpace(def, draft.name.trim() || (def.id === "custom" ? hostOf(sourceUrl) : def.name)));
      if (!spaceId) setSpaceId(sp.id);
      const preset = index !== undefined ? def.sources[index] : undefined;
      const { connection, job } = await client.createConnection(sp.id, sourceUrl, draft.kind, preset?.label);
      if (index !== undefined) setBound((b) => ({ ...b, [index]: connection.id }));
      setDrafts((d) => d.map((x, i) => (i === index ? { ...x, password: "" } : x)));
      if (key === "extra") setExtra(draftOf());
      mark(connection.id, "Проверяю сайт…");
      setConnections((c) => [...c, connection]);
      try { await waitJob(job); } catch (e) { note(connection.id, sayError(e)); }
      const list = await refresh(sp.id);
      mark(connection.id, null);
      const fresh = list.find((c) => c.id === connection.id);
      if (fresh && credentials) await autoLogin(fresh, credentials);
      onSpaceReady?.(sp);
    } catch (e) { setDraftError((m) => ({ ...m, [key]: sayError(e) })); }
    finally { setBusyDraft(null); }
  };

  /** Креды из карточки до «Подключить» применяются, только если сервер сам предложил вход паролем. */
  const autoLogin = async (connection: Connection, credentials: PresetCredentials) => {
    if (connection.status !== "user_action_required") return;
    let methods: AuthMethod[] = [];
    try { methods = (await client.connection(connection.id)).authMethods; } catch { return; }
    const sso = methods.find((m) => m.type === "sso_password");
    const plain = methods.find((m) => m.type === "password");
    try {
      if (sso) {
        const { login } = await client.startLogin(connection.id, { mode: "password", ...credentials });
        setDetails((d) => ({ ...d, [connection.id]: { authMethods: methods, login } }));
      } else if (plain) {
        const { job } = await client.auth(connection.id, { origin: originOf(connection.sourceUrl), ...credentials });
        await settle(connection.id, job, "Вхожу…");
      }
    } catch (e) { note(connection.id, sayError(e)); }
  };

  const setLogin = useCallback((id: string, login: LoginSession | null) => setDetails((d) => ({ ...d, [id]: { authMethods: d[id]?.authMethods ?? [], login } })), []);
  const loginDone = async (connection: Connection, login: LoginSession) => {
    mark(connection.id, "Загружаю данные…");
    let c: Connection | null = connection;
    for (let i = 0; i < 20 && spaceId && alive.current; i++) {
      const list = await refresh(spaceId);
      c = list.find((x) => x.id === connection.id) ?? null;
      if (!c || c.status !== "pending") break;
      await sleep(1500);
    }
    setDismissed((d) => [...d, login.id]);
    setReauth((r) => r.filter((x) => x !== connection.id));
    mark(connection.id, null);
  };
  const startInteractive = async (connection: Connection) => {
    note(connection.id, null);
    try { const { login } = await client.startLogin(connection.id, { mode: "interactive" }); setLogin(connection.id, login); }
    catch (e) { note(connection.id, sayError(e)); }
  };
  const run = async (connection: Connection, label: string, action: () => Promise<{ job: Job }>) => {
    note(connection.id, null);
    mark(connection.id, label);
    try { const { job } = await action(); await settle(connection.id, job, label); }
    catch (e) { note(connection.id, sayError(e)); mark(connection.id, null); }
  };
  const disconnect = async (connection: Connection) => {
    setConfirmDelete(null);
    try { await client.deleteConnection(connection.id); setBound((b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== connection.id))); if (spaceId) await refresh(spaceId); }
    catch (e) { note(connection.id, sayError(e)); }
  };

  const characters = characterFor({ universityId: def.id, name: def.name });
  const boundIds = new Set(Object.values(bound));
  const presetConnection = (p: PresetSource, i: number) => connections.find((c) => c.id === bound[i]) ?? connections.find((c) => !boundIds.has(c.id) && originOf(c.sourceUrl) === originOf(p.url));
  const claimed = new Set(def.sources.map((p, i) => presetConnection(p, i)?.id));
  const others = connections.filter((c) => !claimed.has(c.id));

  const card = (c: Connection) => {
    const detail = details[c.id];
    const activeLogin = detail?.login && !dismissed.includes(detail.login.id) ? detail.login : null;
    const expired = c.errorCode === "source_session_expired";
    const word = wordCode(c.errorCode);
    const busy = work[c.id];
    const showAuth = !activeLogin && (c.status === "user_action_required" && (!expired || reauth.includes(c.id)) || reauth.includes(c.id));
    const badge = busy ? "Проверяю" : c.status === "ready" ? "Подключено" : c.status === "pending" ? "Проверяю" : c.status === "error" ? "Ошибка" : expired ? "Сессия истекла" : "Нужен вход";
    const tone = busy || c.status === "pending" ? "text-hint" : c.status === "ready" ? "text-green" : c.status === "error" ? "text-red" : "text-yellow";
    const fetched = [results.schedule, results.deadlines, results.courses].flatMap((s) => s?.sources ?? []).filter((s) => s.connectionId === c.id).map((s) => s.fetchedAt).sort().at(-1);
    return (
      <article key={c.id} className="flex flex-col gap-3 rounded-[22px] bg-card p-4" data-source-card={c.label || hostOf(c.sourceUrl)} data-status={c.status} data-error={c.errorCode ?? ""}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-m font-extrabold [overflow-wrap:anywhere]">{c.label || hostOf(c.sourceUrl)}</h3>
            <p className="text-s text-hint [overflow-wrap:anywhere]">{hostOf(c.sourceUrl)} · {KIND_LABELS[c.kind]}</p>
          </div>
          <span className={`shrink-0 text-s font-bold ${tone}`} data-badge>{badge}</span>
        </div>
        {fetched && <p className="text-s text-hint">Последнее получение: {fmtStamp(fetched)}</p>}
        {busy && <MascotLoader character={characters} label={busy} dark={dark} motion={motion} size={48} />}
        {!busy && c.errorCode && word && (
          <p role="alert" className={`rounded-2xl px-3 py-2 text-s font-semibold ${c.status === "user_action_required" ? "bg-yellow/10 text-yellow" : "bg-red/10 text-red"}`}>
            {word.text}{word.action ? ` ${word.action}` : ""} ({c.errorCode})
          </p>
        )}
        {notes[c.id] && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{notes[c.id]}</p>}
        {activeLogin && (
          <LoginFlow client={client} login={activeLogin} onChange={(l) => setLogin(c.id, l)} onSucceeded={() => void loginDone(c, activeLogin)}
            onRestart={() => { setDismissed((d) => [...d, activeLogin.id]); setReauth((r) => [...r.filter((x) => x !== c.id), c.id]); }}
            onManual={() => { setDismissed((d) => [...d, activeLogin.id]); void startInteractive(c); }} />
        )}
        {!busy && showAuth && (
          <AuthPanel client={client} connectionId={c.id} sourceUrl={c.sourceUrl} methods={detail?.authMethods ?? []} reauth={expired || reauth.includes(c.id)}
            onLogin={(l) => setLogin(c.id, l)} onSaved={(job) => void settle(c.id, job, "Вхожу…").then(() => setReauth((r) => r.filter((x) => x !== c.id)))}
            onRecheck={() => void run(c, "Проверяю сайт…", () => client.sync(c.id))} />
        )}
        {!busy && !activeLogin && (
          <div className="flex flex-wrap gap-2">
            {expired && !showAuth && <button type="button" className={primary} onClick={() => setReauth((r) => [...r, c.id])}>Войти снова</button>}
            {c.status !== "user_action_required" && c.status !== "pending" && (
              <button type="button" className={secondary} onClick={() => void run(c, "Обновляю данные…", () => client.sync(c.id))}>{c.status === "error" ? "Повторить" : "Обновить"}</button>
            )}
            {c.status === "ready" && !expired && !showAuth && <button type="button" className={secondary} onClick={() => setReauth((r) => [...r, c.id])}>Войти снова</button>}
            {confirmDelete === c.id ? (
              <>
                <button type="button" className="min-h-11 rounded-2xl bg-red px-4 text-m font-bold text-white" onClick={() => void disconnect(c)}>Да, отключить</button>
                <button type="button" className={secondary} onClick={() => setConfirmDelete(null)}>Не отключать</button>
              </>
            ) : <button type="button" className={secondary} onClick={() => setConfirmDelete(c.id)}>Отключить</button>}
          </div>
        )}
      </article>
    );
  };

  const draftCard = (p: PresetSource, i: number) => {
    const key = `preset-${i}`;
    const d = drafts[i];
    const set = (patch: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const busy = busyDraft === key;
    return (
      <form key={key} className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label={p.label} data-source-card={p.label} data-status="new"
        onSubmit={(e) => { e.preventDefault(); void connect(d, key, i); }}>
        <h3 className="font-display text-m font-extrabold">{p.label}</h3>
        {p.hint && <p className="text-s text-hint">{p.hint}</p>}
        <label className="text-s font-bold text-hint" htmlFor={`${def.id}-url-${i}`}>Адрес источника</label>
        <input id={`${def.id}-url-${i}`} className={field} inputMode="url" autoComplete="off" value={d.url} onChange={(e) => set({ url: e.target.value })} />
        {p.credentials && (
          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-s font-bold text-hint">{p.credentials.title}</legend>
            <label className="sr-only" htmlFor={`${def.id}-login-${i}`}>Логин</label>
            <input id={`${def.id}-login-${i}`} className={field} autoComplete="username" spellCheck={false} placeholder={p.credentials.login} value={d.username} onChange={(e) => set({ username: e.target.value })} />
            <label className="sr-only" htmlFor={`${def.id}-password-${i}`}>Пароль</label>
            <input id={`${def.id}-password-${i}`} className={field} type="password" autoComplete="current-password" placeholder="Пароль" value={d.password} onChange={(e) => set({ password: e.target.value })} />
            <p className="text-s text-hint">Пароль уходит на сервер Doodle один раз для входа и не хранится. Можно оставить пустым и войти в браузере.</p>
          </fieldset>
        )}
        <button type="submit" className={primary} disabled={busy || !d.url.trim()}>{busy ? "Подключаю…" : "Подключить"}</button>
        {draftError[key] && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{draftError[key]}</p>}
      </form>
    );
  };

  const custom = def.id === "custom";
  const showExtra = custom || connections.length > 0 || def.sources.length > 0;
  return (
    <div className="flex flex-col gap-4" data-university={def.id} data-space={spaceId ?? ""}>
      <p className="text-s text-hint">{def.intro}</p>
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{error}</p>}
      {!loaded && <p role="status" className="text-m font-semibold text-hint">Загружаю источники…</p>}
      {def.sources.map((p, i) => { const c = presetConnection(p, i); return c ? card(c) : draftCard(p, i); })}
      {others.map(card)}
      {showExtra && (
        <form className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label={custom ? "Адрес вуза" : "Добавить источник"} data-source-card="extra"
          onSubmit={(e) => { e.preventDefault(); void connect(extra, "extra"); }}>
          <h3 className="font-display text-m font-extrabold">{custom && !connections.length ? "Адрес LMS или сайта вуза" : "Добавить источник"}</h3>
          {custom && !spaceId && (
            <>
              <label className="text-s font-bold text-hint" htmlFor="extra-name">Название вуза</label>
              <input id="extra-name" className={field} placeholder="Например, СПбГУ" value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} />
            </>
          )}
          <label className="text-s font-bold text-hint" htmlFor={`${def.id}-extra-url`}>Адрес сайта</label>
          <input id={`${def.id}-extra-url`} className={field} inputMode="url" autoComplete="off" placeholder="https://lms.university.ru" value={extra.url} onChange={(e) => setExtra({ ...extra, url: e.target.value })} />
          <label className="text-s font-bold text-hint" htmlFor={`${def.id}-extra-kind`}>Что это за сайт</label>
          <select id={`${def.id}-extra-kind`} className={field} value={extra.kind} onChange={(e) => setExtra({ ...extra, kind: e.target.value as SourceKind })}>
            {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="submit" className={primary} disabled={busyDraft === "extra" || !extra.url.trim()}>{busyDraft === "extra" ? "Подключаю…" : "Подключить"}</button>
          {draftError.extra && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{draftError.extra}</p>}
        </form>
      )}
      {spaceId && connections.length > 0 && <Results results={results} connections={connections} now={now} />}
    </div>
  );
}
