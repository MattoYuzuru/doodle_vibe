import { useState } from "react";
import { MascotLoader } from "../../components/assistant/MascotCard";
import { useScheme } from "../../hooks/useScheme";
import { useMascotMotion } from "../../hooks/useSpace";
import { characterFor } from "../../lib/space-adapter";
import { type Connection, PlatformError, type SourceKind, type UniversitySpace, usePlatform, v1 } from "../../store/platform";
import { haptic } from "../../telegram/webapp";

/*
 * «Подключить учёбу» (DES-010): выбрать вуз, скинуть ссылку на учебный сайт, при необходимости войти. Всё через новый
 * API: сервер сам определяет, что за сайт (discovery), и говорит, нужен ли вход. Пароль уходит только на сервер Doodle
 * для входа в этот сайт; клиент его не хранит. Ничего не отправляется на сайты вуза от имени студента, кроме входа.
 */

const PRESETS: { universityId: string; name: string }[] = [
  { universityId: "hse", name: "ВШЭ" },
  { universityId: "misis", name: "МИСИС" },
];
const KINDS: [SourceKind, string][] = [["lms", "LMS / Moodle"], ["schedule", "Расписание"], ["table", "Таблица"], ["document", "Документ"], ["website", "Сайт"]];
const ERRORS: Record<string, string> = {
  OFFLINE: "Сервер не отвечает. Проверь интернет и попробуй ещё раз.",
  VALIDATION_ERROR: "Проверь ссылку: нужен адрес https:// без логина и параметров.",
  INVALID_URL: "Проверь ссылку: нужен адрес https:// без логина и параметров.",
  RATE_LIMITED: "Слишком много попыток. Подожди минуту.",
  JOB_TIMEOUT: "Сайт проверяется дольше обычного. Статус появится на Главной.",
};
const say = (e: unknown) => {
  const code = e instanceof PlatformError ? e.code : "INTERNAL_ERROR";
  return ERRORS[code] ?? `Не получилось (${code}). Попробуй ещё раз.`;
};
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "university";

export function ConnectScreen({ spaceId }: { spaceId?: string }) {
  const spaces = usePlatform((s) => s.spaces);
  const [space, setSpace] = useState<UniversitySpace | null>(() => spaces.find((s) => s.id === spaceId) ?? null);
  const [otherName, setOtherName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<SourceKind>("lms");
  const [conn, setConn] = useState<Connection | null>(null);
  const [mode, setMode] = useState<"password" | "token">("password");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dark = useScheme() === "dark";
  const motion = useMascotMotion();
  const st = usePlatform.getState;

  const chooseSpace = async (universityId: string, name: string) => {
    setError(null);
    const existing = spaces.find((s) => s.universityId === universityId);
    if (existing) { st().setActive(existing.id); setSpace(existing); return; }
    setBusy("Создаю вуз");
    try { setSpace(await st().createSpace(universityId, name)); } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  // После задачи сервера смотрим, чем закончилось подключение: готово, нужен вход или ошибка.
  const finish = async (connectionId: string, jobId: string) => {
    setBusy("Проверяю сайт");
    try { await st().waitJob(jobId); } catch (e) { setError(say(e)); }
    const { connection } = await v1<{ connection: Connection }>(`connections/${encodeURIComponent(connectionId)}`);
    setConn(connection);
    if (connection.status === "ready") { setDone("Подключено. Сроки и пары появятся на Главной."); haptic.success(); }
    else if (connection.status === "error") setError(`Сайт не подключился (${connection.errorCode ?? "ошибка"}). Проверь ссылку или вход.`);
    await st().reload();
  };

  const addSource = async () => {
    if (!space) return;
    setError(null); setDone(null);
    let u: URL;
    try { u = new URL(url.trim()); } catch { setError(ERRORS.INVALID_URL); return; }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) { setError(ERRORS.INVALID_URL); return; }
    setBusy("Добавляю источник");
    try {
      const { connection, job } = await st().addSource(space.id, u.origin + u.pathname, kind);
      setConn(connection);
      await finish(connection.id, job.id);
    } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  const signIn = async () => {
    if (!conn) return;
    setError(null);
    setBusy("Вхожу");
    try {
      const origin = new URL(conn.sourceUrl).origin;
      const { job } = await st().saveAuth(conn.id, mode === "token" ? { origin, token: token.trim() } : { origin, username: login.trim(), password });
      setPassword(""); setToken("");
      await finish(conn.id, job.id);
    } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";
  return (
    <div className="space-ui flex flex-col gap-4 px-1 pt-2 pb-8" data-connect>
      <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Подключить учёбу</h1>

      <section className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Вуз">
        <p className="text-m font-bold">1. Вуз</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.universityId} type="button" disabled={!!busy} aria-pressed={space?.universityId === p.universityId}
              onClick={() => void chooseSpace(p.universityId, p.name)}
              className={`min-h-11 rounded-2xl px-4 text-m font-bold ${space?.universityId === p.universityId ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{p.name}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="connect-other">Другой вуз</label>
          <input id="connect-other" className={field} placeholder="Другой вуз, например ЦУ" value={otherName} onChange={(e) => setOtherName(e.target.value)} />
          <button type="button" className={primary} disabled={!otherName.trim() || !!busy} onClick={() => void chooseSpace(slug(otherName), otherName.trim())}>Выбрать</button>
        </div>
        {space && <p className="text-s font-semibold text-hint">Выбран: {space.name}</p>}
      </section>

      {space && (
        <form className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Источник" onSubmit={(e) => { e.preventDefault(); void addSource(); }}>
          <p className="text-m font-bold">2. Ссылка на учебный сайт</p>
          <label className="text-s font-bold text-hint" htmlFor="connect-url">Адрес сайта</label>
          <input id="connect-url" className={field} inputMode="url" autoComplete="url" placeholder="https://lms.university.ru" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label className="text-s font-bold text-hint" htmlFor="connect-kind">Что это за сайт</label>
          <select id="connect-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="submit" className={primary} disabled={!url.trim() || !!busy}>Добавить</button>
        </form>
      )}

      {conn?.status === "user_action_required" && (
        <form className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Вход" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
          <p className="text-m font-bold">3. Вход на {new URL(conn.sourceUrl).host}</p>
          <p className="text-s text-hint">Данные уходят только на сервер Doodle, чтобы войти в этот сайт. В приложении они не сохраняются.</p>
          <div className="flex gap-2" role="group" aria-label="Способ входа">
            {(["password", "token"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                className={`min-h-11 rounded-2xl px-3 text-s font-bold ${mode === m ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{m === "password" ? "Логин и пароль" : "Токен"}</button>
            ))}
          </div>
          {mode === "password" ? (
            <>
              <label className="sr-only" htmlFor="connect-login">Логин</label>
              <input id="connect-login" className={field} autoComplete="username" placeholder="Логин" value={login} onChange={(e) => setLogin(e.target.value)} />
              <label className="sr-only" htmlFor="connect-password">Пароль</label>
              <input id="connect-password" className={field} type="password" autoComplete="current-password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} />
            </>
          ) : (
            <>
              <label className="sr-only" htmlFor="connect-token">Токен</label>
              <input id="connect-token" className={field} autoComplete="off" placeholder="Токен" value={token} onChange={(e) => setToken(e.target.value)} />
            </>
          )}
          <button type="submit" className={primary} disabled={!!busy || (mode === "password" ? !login.trim() || !password : !token.trim())}>Войти</button>
        </form>
      )}

      {busy && <MascotLoader character={space ? characterFor(space) : "dusya"} label={busy} dark={dark} motion={motion} size={56} />}
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-m font-semibold text-red">{error}</p>}
      {done && <p role="status" className="rounded-2xl bg-green/10 px-3 py-2 text-m font-semibold text-green">{done}</p>}
    </div>
  );
}
