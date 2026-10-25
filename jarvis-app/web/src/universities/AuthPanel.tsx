import { useState } from "react";
import type { ApiV1Client, AuthMethod, AuthRequest, Job, LoginSession } from "../api/v1";
import { tg } from "../telegram/webapp";
import { originOf } from "./catalog";
import { METHOD_ORDER, METHOD_TITLES, sayError, sayNote } from "./messages";

/*
 * Способы входа берём из ответа сервера (authMethods), ничего не угадываем. Секреты (пароль, токен, ссылка календаря)
 * уходят одним запросом на сервер Doodle, поля после отправки очищаются; в хранилище браузера ничего не пишется.
 */

const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none focus-visible:ring-2 focus-visible:ring-accent";
const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";

export interface PresetCredentials { username: string; password: string }
interface Props {
  client: ApiV1Client;
  connectionId: string;
  sourceUrl: string;
  methods: AuthMethod[];
  /** Заполнено в карточке до «Подключить»: подставляется в форму логина и пароля. */
  credentials?: PresetCredentials;
  reauth?: boolean;
  onLogin: (login: LoginSession) => void;
  onSaved: (job: Job) => void;
  onRecheck: () => void;
}

const rank = (m: AuthMethod) => { const i = METHOD_ORDER.indexOf(m.type); return i < 0 ? 99 : i; };

export function AuthPanel({ client, connectionId, sourceUrl, methods, credentials, reauth, onLogin, onSaved, onRecheck }: Props) {
  const ordered = [...methods].sort((a, b) => rank(a) - rank(b));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((m) => m.id === selectedId) ?? ordered[0];
  const [values, setValues] = useState<Record<string, string>>({ username: credentials?.username ?? "", password: credentials?.password ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const wipe = () => setValues({});

  if (!selected) {
    return (
      <div className="flex flex-col gap-2" data-auth-panel="empty">
        <p className="text-m text-hint">Сервер пока не предложил способов входа для этого сайта. Возможно, вход ещё определяется.</p>
        <button type="button" className={primary} onClick={onRecheck}>Проверить сайт снова</button>
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(sayError(e)); } finally { setBusy(false); }
  };
  const origin = originOf(sourceUrl);
  const need = (...keys: string[]) => keys.every((k) => (values[k] ?? "").trim());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      switch (selected.type) {
        case "remote_login": { const { login } = await client.startLogin(connectionId, { mode: "interactive" }); wipe(); onLogin(login); return; }
        case "sso_password": {
          const { login } = await client.startLogin(connectionId, { mode: "password", username: values.username.trim(), password: values.password });
          wipe(); onLogin(login); return;
        }
        case "oauth": {
          const { authorizationUrl } = await client.oauth(connectionId, selected.id);
          if (tg?.openLink) tg.openLink(authorizationUrl); else window.open(authorizationUrl, "_blank", "noopener");
          return;
        }
        default: {
          const request: AuthRequest = selected.type === "token" ? { origin, token: values.token.trim() }
            : selected.type === "password" ? { origin, username: values.username.trim(), password: values.password }
            : selected.type === "calendar_url" ? { origin, calendarUrl: values.calendarUrl.trim() }
            : { origin, identifier: values.identifier.trim() };
          const { job } = await client.auth(connectionId, request);
          wipe(); onSaved(job);
        }
      }
    });
  };

  const notes = [selected.note, ...(selected.notes ?? [])].filter((n): n is string => !!n).map(sayNote).filter(Boolean);
  const valid = selected.type === "remote_login" || selected.type === "oauth" ? true
    : selected.type === "sso_password" || selected.type === "password" ? need("username", "password")
    : selected.type === "token" ? need("token") : selected.type === "calendar_url" ? need("calendarUrl") : need("identifier");
  const label = (id: string, text: string) => <label className="text-s font-bold text-hint" htmlFor={`${connectionId}-${id}`}>{text}</label>;
  const input = (id: string, text: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <>
      {label(id, text)}
      <input id={`${connectionId}-${id}`} className={field} value={values[id] ?? ""} onChange={(e) => set(id, e.target.value)} spellCheck={false} {...props} />
    </>
  );
  const cta = reauth ? "Войти снова" : selected.type === "remote_login" ? "Открыть браузер для входа" : selected.type === "oauth" ? "Продолжить у провайдера" : "Войти";

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} aria-label={reauth ? "Войти снова" : "Вход"} data-auth-panel={selected.type}>
      {ordered.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Способ входа">
          {ordered.map((m) => (
            <button key={m.id} type="button" aria-pressed={m.id === selected.id} onClick={() => { setSelectedId(m.id); setError(null); }}
              className={`min-h-11 rounded-2xl px-3 text-s font-bold ${m.id === selected.id ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>{m.type === "oauth" ? m.label : METHOD_TITLES[m.type] ?? m.label}</button>
          ))}
        </div>
      )}
      <p className="text-s text-hint">{selected.label}</p>
      {selected.type === "remote_login" && <p className="text-s text-hint">Откроется страница входа вуза в браузере на сервере Doodle. Ты входишь сам любым способом — SSO, MFA, капча. Пароль не сохраняется, сохраняется только зашифрованная сессия.</p>}
      {selected.type === "sso_password" && <p className="text-s text-hint">Логин и пароль уходят на сервер Doodle один раз, чтобы заполнить форму вуза; пароль не хранится. Код MFA введёшь на следующем шаге.</p>}
      {(selected.type === "sso_password" || selected.type === "password") && (
        <>
          {input("username", "Логин", { autoComplete: "username", placeholder: "Логин или почта" })}
          {input("password", "Пароль", { type: "password", autoComplete: "current-password", placeholder: "Пароль" })}
        </>
      )}
      {selected.type === "token" && input("token", "Токен", { autoComplete: "off", placeholder: "Токен веб-сервиса" })}
      {selected.type === "calendar_url" && input("calendarUrl", "Ссылка календаря", { type: "password", inputMode: "url", autoComplete: "off", placeholder: "https://…/export_execute.php?…" })}
      {selected.type === "identifier" && input("identifier", "Почта, ФИО или номер", { autoComplete: "off", placeholder: "login@edu.hse.ru" })}
      {notes.map((n) => <p key={n} className="text-s text-hint">{n}</p>)}
      <button type="submit" className={primary} disabled={busy || !valid}>{cta}</button>
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{error}</p>}
    </form>
  );
}
