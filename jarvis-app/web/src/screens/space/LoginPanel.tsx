import { useEffect, useState } from "react";
import { RemoteBrowser } from "../../components/RemoteBrowser";
import { useNow } from "../../hooks/useNow";
import { type LoginSession, MFA_CODE, STATUS_TEXT, isTerminal, mmss, secondsLeft } from "../../lib/remote-login";
import { type AuthMethod, sourceError } from "../../lib/sources";
import { type Connection, PlatformError, usePlatform } from "../../store/platform";

/*
 * Вход через удалённый браузер (ADR-0005, задача C): remote_login — человек входит сам в кадре удалённого браузера
 * (SSO, MFA, капча — всё сам); sso_password — сервер вводит логин и пароль по пресету вуза, код подтверждения вводится
 * здесь, а если форма не распознана — «Войти вручную» переводит в браузер. Пароль и код уходят только в тело запроса
 * и сразу стираются из формы. Состояние входа приходит по потоку и дублируется опросом GET /login/:id.
 */

const LOGIN_ERRORS: Record<string, string> = {
  LOGIN_UNAVAILABLE: "Вход через браузер на сервере сейчас недоступен. Выбери другой способ.",
  LOGIN_COOLDOWN: "Слишком много неудачных входов. Подожди 10 минут.",
  LOGIN_BUSY: "Сервер занят другими входами. Попробуй через минуту.",
  LOGIN_NOT_WAITING_MFA: "Сайт уже не ждёт код. Посмотри на состояние входа.",
  RATE_LIMITED: "Слишком много попыток. Подожди минуту.",
  OFFLINE: "Сервер не отвечает. Проверь интернет.",
};
const say = (e: unknown) => {
  const code = e instanceof PlatformError ? e.code : "INTERNAL_ERROR";
  return LOGIN_ERRORS[code] ?? `Не получилось (${code}).`;
};

type Props = {
  connection: Connection;
  method: AuthMethod;
  /** Активный вход, если сервер его уже ведёт (GET /connections/:id → login). */
  initial?: LoginSession | null;
  /** Вход сохранён: родитель ждёт, пока подключение синхронизируется. */
  onSucceeded(): void;
};

export function LoginPanel({ connection, method, initial = null, onSucceeded }: Props) {
  const st = usePlatform.getState;
  const now = useNow(1000);
  const [login, setLogin] = useState<LoginSession | null>(initial && !isTerminal(initial.status) ? initial : null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Опрос состояния, пока вход не закончен (поток тоже присылает status; опрос — запасной путь).
  useEffect(() => {
    if (!login || isTerminal(login.status)) return;
    const t = window.setInterval(async () => {
      try { setLogin((await st().getLogin(login.id)).login); }
      catch (e) {
        if (e instanceof PlatformError && e.status === 404) { setLogin(null); setError("Вход прервался (сервер мог перезапуститься). Начни заново."); }
      }
    }, 1500);
    return () => clearInterval(t);
  }, [login?.id, login?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!login) return;
    if (login.status === "succeeded") onSucceeded();
    else if (login.status === "failed") setError(sourceError(login.errorCode));
    else if (login.status === "expired") setError("Время на вход истекло. Начни заново.");
  }, [login?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<{ login: LoginSession }>) => {
    setBusy(true); setError(null);
    try { setLogin((await f()).login); } catch (e) { setError(say(e)); } finally { setBusy(false); }
  };
  const start = () => run(() => method.type === "sso_password"
    ? st().startLogin(connection.id, { mode: "password", username: username.trim(), password }).finally(() => setPassword(""))
    : st().startLogin(connection.id, { mode: "interactive" }));
  const restart = () => { setLogin(null); setError(null); setCode(""); };

  const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none";
  const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";
  const secondary = "min-h-11 rounded-2xl bg-raised px-4 text-m font-bold disabled:opacity-50";
  const active = login && !isTerminal(login.status);

  if (!login || login.status === "cancelled" || (isTerminal(login.status) && login.status !== "succeeded")) {
    return (
      <div className="flex flex-col gap-2" data-login-start={method.type}>
        {method.type === "sso_password" ? (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <label className="text-s font-bold text-hint" htmlFor="login-username">Логин вуза</label>
            <input id="login-username" className={field} autoComplete="username" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
            <label className="text-s font-bold text-hint" htmlFor="login-password">Пароль</label>
            <input id="login-password" className={field} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-s text-hint">Сервер Doodle сам введёт их на сайте вуза и сохранит только зашифрованный вход, без пароля. Код подтверждения, если попросят, введёшь здесь.</p>
            <button type="submit" className={primary} disabled={busy || !username.trim() || !password}>Войти</button>
          </form>
        ) : (
          <>
            <p className="text-s">Откроется сайт вуза в браузере на сервере Doodle. Войди как обычно: единый вход, код из приложения, капча — всё сам. Doodle сохранит только зашифрованный вход, без пароля.</p>
            <button type="button" className={primary} disabled={busy} onClick={() => void start()}>Открыть браузер для входа</button>
          </>
        )}
        {login?.status === "cancelled" && <p role="status" className="text-s text-hint">Вход отменён.</p>}
        {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-m font-semibold text-red">{error}</p>}
        {error && login && <button type="button" className={secondary} onClick={restart}>Начать заново</button>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-login-status={login.status}>
      <p role="status" className="text-m font-semibold">
        {STATUS_TEXT[login.status]}
        {active && <span className="ml-1.5 text-s font-bold text-hint tabular">осталось {mmss(secondsLeft(login.expiresAt, now))}</span>}
      </p>
      {login.status === "awaiting_user" && <RemoteBrowser loginId={login.id} onStatus={setLogin} />}
      {login.status === "awaiting_mfa" && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); const c = code.trim(); setCode(""); void run(() => st().sendMfa(login.id, c)); }}>
          <label className="text-s font-bold text-hint" htmlFor="login-mfa">Код подтверждения{login.mfa ? ` · попыток: ${login.mfa.attemptsLeft}` : ""}</label>
          <input id="login-mfa" className={field} inputMode={login.mfa?.kind === "totp" ? "numeric" : "text"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className={primary} disabled={busy || !MFA_CODE.test(code.trim())}>Подтвердить</button>
        </form>
      )}
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-m font-semibold text-red">{error}</p>}
      {active && (
        <div className="flex flex-wrap gap-2">
          {login.mode === "password" && login.status !== "capturing" && (
            <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => st().handoff(login.id))}>Войти вручную</button>
          )}
          <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => st().cancelLogin(login.id))}>Отменить вход</button>
        </div>
      )}
    </div>
  );
}
