import { useEffect, useRef, useState } from "react";
import { MascotLoader } from "../../components/assistant/MascotCard";
import { useScheme } from "../../hooks/useScheme";
import { useMascotMotion } from "../../hooks/useSpace";
import { connectionsOf, characterFor } from "../../lib/space-adapter";
import { AUTH_NOTES, type AuthField, type AuthMethod, FIELD_LABEL, SOURCE_PRESETS, authBody, authReady, isBrowserLogin, sourceError, sourceProblem, universitiesLink } from "../../lib/sources";
import { type Connection, PlatformError, type SourceKind, type UniversitySpace, usePlatform } from "../../store/platform";
import { haptic } from "../../telegram/webapp";
import { openSource } from "./SpaceTabs";

/*
 * «Подключить учёбу» (DES-010; ВШЭ — по backend #13, docs/universities.md): выбрать вуз, нажать готовый источник
 * (Smart LMS, РУЗ, LMS МИСИС) или вставить свою ссылку, затем войти той формой, которую предложил сервер (authMethods:
 * ссылка календаря, идентификатор РУЗ, токен, логин и пароль, OAuth — в рекомендуемом порядке). Данные входа уходят
 * только на сервер Doodle; в приложении не сохраняются и после отправки стираются из формы.
 */

const UNIVERSITIES: { universityId: string; name: string }[] = [
  { universityId: "hse", name: "ВШЭ" },
  { universityId: "misis", name: "МИСИС" },
];
const KINDS: [SourceKind, string][] = [["lms", "LMS / Moodle"], ["schedule", "Расписание"], ["table", "Таблица"], ["document", "Документ"], ["website", "Сайт"]];
const ERRORS: Record<string, string> = {
  OFFLINE: "Сервер не отвечает. Проверь интернет и попробуй ещё раз.",
  VALIDATION_ERROR: "Проверь ссылку: нужен адрес https:// без логина и параметров.",
  INVALID_URL: "Проверь ссылку: нужен адрес https:// без логина и параметров.",
  INVALID_SOURCE_KIND: "Выбери, что это за сайт.",
  RATE_LIMITED: "Слишком много попыток. Подожди минуту.",
  JOB_TIMEOUT: "Сайт проверяется дольше обычного. Статус появится на Главной.",
  OAUTH_PROVIDER_UNAVAILABLE: "Этот способ входа сейчас недоступен. Выбери другой.",
};
const say = (e: unknown) => {
  const code = e instanceof PlatformError ? e.code : "INTERNAL_ERROR";
  return ERRORS[code] ?? `Не получилось (${code}). Попробуй ещё раз.`;
};
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "university";
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const STATUS: Record<Connection["status"], string> = { ready: "Подключено", pending: "Проверяется", user_action_required: "Нужен вход", error: "Ошибка" };

export function ConnectScreen({ spaceId }: { spaceId?: string }) {
  const spaces = usePlatform((s) => s.spaces);
  const data = usePlatform((s) => s.data);
  // По умолчанию — вуз, открытый на Главной: там видно, что уже подключено и куда нужно войти заново.
  const [space, setSpace] = useState<UniversitySpace | null>(() => spaces.find((s) => s.id === (spaceId ?? usePlatform.getState().activeId)) ?? null);
  const [otherName, setOtherName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<SourceKind>("lms");
  const [conn, setConn] = useState<Connection | null>(null);
  const [methods, setMethods] = useState<AuthMethod[]>([]);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [values, setValues] = useState<Partial<Record<AuthField, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dark = useScheme() === "dark";
  const motion = useMascotMotion();
  const st = usePlatform.getState;
  const connected = space && data?.spaceId === space.id ? connectionsOf(data) : [];
  const presets = space ? SOURCE_PRESETS[space.universityId] ?? [] : [];
  const method = methods.find((m) => m.id === methodId) ?? methods[0] ?? null;
  // Форма входа появляется ниже готовых сайтов — подводим к ней, чтобы шаг 3 не остался за краем экрана.
  const authRef = useRef<HTMLFormElement>(null);
  const authKey = conn && method && conn.status !== "ready" ? conn.id : null;
  useEffect(() => {
    if (authKey) authRef.current?.scrollIntoView({ behavior: motion === "full" ? "smooth" : "auto", block: "start" });
  }, [authKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseSpace = async (universityId: string, name: string) => {
    setError(null); setDone(null); setConn(null);
    const existing = spaces.find((s) => s.universityId === universityId);
    if (existing) { st().setActive(existing.id); setSpace(existing); return; }
    setBusy("Создаю вуз");
    try { setSpace(await st().createSpace(universityId, name)); } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  // После задачи сервера смотрим, чем закончилось: готово, нужен вход (и каким способом) или ошибка с кодом.
  const settle = async (connectionId: string, jobId: string) => {
    setBusy("Проверяю сайт");
    try { await st().waitJob(jobId); } catch (e) { setError(say(e)); }
    const { connection, authMethods } = await st().getConnection(connectionId);
    setConn(connection);
    setMethods(authMethods);
    setMethodId((cur) => (authMethods.some((m) => m.id === cur) ? cur : authMethods[0]?.id ?? null));
    if (connection.status === "ready") {
      setDone(`${connection.label || host(connection.sourceUrl)} подключён. Сроки и пары появятся на Главной.`);
      setMethods([]); haptic.success();
    } else if (connection.status === "error" || connection.errorCode) {
      setError(sourceError(connection.errorCode));
    }
    await st().reload();
  };

  const addSource = async (sourceUrl: string, sourceKind: SourceKind, label?: string) => {
    if (!space) return;
    setError(null); setDone(null); setConn(null); setMethods([]); setValues({});
    let u: URL;
    try { u = new URL(sourceUrl.trim()); } catch { setError(ERRORS.INVALID_URL); return; }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) { setError(ERRORS.INVALID_URL); return; }
    setBusy("Добавляю источник");
    try {
      const { connection, job } = await st().addSource(space.id, u.origin + u.pathname, sourceKind, label);
      setConn(connection);
      await settle(connection.id, job.id);
    } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  const signIn = async () => {
    if (!conn || !method) return;
    setError(null);
    setBusy("Вхожу");
    try {
      const origin = new URL(conn.sourceUrl).origin;
      if (method.type === "oauth") {
        const { authorizationUrl } = await st().startOAuth(conn.id, method.id);
        openSource(authorizationUrl);
        setDone("Открыла страницу входа. После входа вернись в Telegram и обнови данные на Главной.");
        return;
      }
      const { job } = await st().saveAuth(conn.id, authBody(origin, method, values));
      setValues({}); // секреты не держим в форме дольше отправки
      await settle(conn.id, job.id);
    } catch (e) { setError(say(e)); } finally { setBusy(null); }
  };

  const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none";
  const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";
  const chip = (on: boolean) => `min-h-11 rounded-2xl px-4 text-m font-bold ${on ? "bg-accent text-on-accent" : "bg-raised text-text"}`;
  const notes = [...new Set([...(method?.notes ?? []), ...(method?.note ? [method.note] : [])])].filter((n) => AUTH_NOTES[n]);

  return (
    <div className="space-ui flex flex-col gap-4 px-1 pt-2 pb-8" data-connect>
      <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Подключить учёбу</h1>
      <a href="#/universities" className="min-h-11 rounded-2xl bg-raised px-4 py-2.5 text-center text-m font-bold text-accent" data-universities-link>Вузы: ВШЭ, МИСИС, ЦУ, свой вуз — вход и данные</a>

      <section className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Вуз">
        <p className="text-m font-bold">1. Вуз</p>
        <div className="flex flex-wrap gap-2">
          {UNIVERSITIES.map((p) => (
            <button key={p.universityId} type="button" disabled={!!busy} aria-pressed={space?.universityId === p.universityId}
              onClick={() => void chooseSpace(p.universityId, p.name)} className={chip(space?.universityId === p.universityId)}>{p.name}</button>
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
        <section className="flex flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Источник">
          <p className="text-m font-bold">2. Учебный сайт</p>
          {presets.length > 0 && (
            <div className="flex flex-col gap-2" role="group" aria-label={`Сайты ${space.name}`}>
              {presets.map((p) => {
                const have = connected.find((c) => host(c.sourceUrl) === host(p.url));
                return (
                  <button key={p.url} type="button" disabled={!!busy} onClick={() => void addSource(p.url, p.kind, p.label)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-raised px-3 py-2 text-left disabled:opacity-50" data-preset={host(p.url)}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-m font-bold">{p.label}</span>
                      <span className="block text-s text-hint">{p.hint}</span>
                    </span>
                    {have && <span className="shrink-0 text-s font-bold text-hint">{STATUS[have.status]}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <form className="flex flex-col gap-2" aria-label="Другой сайт" onSubmit={(e) => { e.preventDefault(); void addSource(url, kind); }}>
            <label className="text-s font-bold text-hint" htmlFor="connect-url">{presets.length ? "Или другой сайт — адрес" : "Адрес сайта"}</label>
            <input id="connect-url" aria-label="Адрес сайта" className={field} inputMode="url" autoComplete="url" placeholder="https://lms.university.ru" value={url} onChange={(e) => setUrl(e.target.value)} />
            <label className="text-s font-bold text-hint" htmlFor="connect-kind">Что это за сайт</label>
            <select id="connect-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
              {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <button type="submit" className={primary} disabled={!url.trim() || !!busy}>Добавить</button>
          </form>
        </section>
      )}

      {conn && method && conn.status !== "ready" && (
        <form ref={authRef} className="flex scroll-mt-4 flex-col gap-2 rounded-[22px] bg-card p-4" aria-label="Вход" data-auth-method={method.id}
          onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
          <p className="text-m font-bold">3. Вход на {host(conn.sourceUrl)}</p>
          {methods.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Способ входа">
              {methods.map((m) => (
                <button key={m.id} type="button" aria-pressed={m.id === method.id} onClick={() => { setMethodId(m.id); setValues({}); }}
                  className={`min-h-11 rounded-2xl px-3 text-s font-bold ${m.id === method.id ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{m.label}</button>
              ))}
            </div>
          )}
          {notes.map((n) => <p key={n} className="rounded-2xl bg-raised px-3 py-2 text-s" data-note={n}>{AUTH_NOTES[n]}</p>)}
          {isBrowserLogin(method) ? (
            // Вход через удалённый браузер и с кодом MFA сделан на экране «Вузы» (задача C, #22) — ведём туда.
            <a href={universitiesLink(space?.universityId ?? "")} className={`${primary} grid place-items-center`} data-browser-login>
              {method.type === "remote_login" ? "Войти через браузер на экране «Вузы»" : "Войти с паролем и кодом на экране «Вузы»"}
            </a>
          ) : method.type === "oauth" ? (
            <button type="submit" className={primary} disabled={!!busy}>Войти: {method.label}</button>
          ) : (
            <>
              {(method.fields ?? []).filter((f) => f !== "service").map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <label className="text-s font-bold text-hint" htmlFor={`connect-${f}`}>{FIELD_LABEL[f]}</label>
                  <input id={`connect-${f}`} className={field} value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                    type={f === "password" ? "password" : f === "calendarUrl" ? "url" : "text"} inputMode={f === "calendarUrl" ? "url" : undefined}
                    autoComplete={f === "password" ? "current-password" : f === "username" ? "username" : "off"} spellCheck={false} />
                </div>
              ))}
              <p className="text-s text-hint">Данные уходят только на сервер Doodle, чтобы войти в этот сайт. В приложении они не сохраняются.</p>
              <button type="submit" className={primary} disabled={!!busy || !authReady(method, values)}>Подключить</button>
            </>
          )}
        </form>
      )}

      {busy && <MascotLoader character={space ? characterFor(space) : "dusya"} label={busy} dark={dark} motion={motion} size={56} />}
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-m font-semibold text-red">{error}</p>}
      {done && <p role="status" className="rounded-2xl bg-green/10 px-3 py-2 text-m font-semibold text-green">{done}</p>}

      {connected.length > 0 && (
        <section className="flex flex-col rounded-[22px] bg-card px-4 py-2" aria-label="Подключённые сайты">
          <p className="py-1 text-m font-bold">Подключено в {space?.name}</p>
          {connected.map((c) => (
            <p key={c.id} className="flex min-h-11 items-center gap-2 border-t border-separator text-m">
              <span className="min-w-0 flex-1 truncate">{c.label || host(c.sourceUrl)}</span>
              <span className="shrink-0 text-s font-bold text-hint">{sourceProblem(c.errorCode) ?? STATUS[c.status]}</span>
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
