import { useEffect, useRef, useState } from "react";
import type { ApiV1Client, LoginSession } from "../api/v1";
import { ApiV1Error } from "../api/v1";
import { RemoteBrowserViewer } from "./RemoteBrowserViewer";
import { LOGIN_PROGRESS, sayCode, sayError } from "./messages";

/*
 * Ход входа: удалённый браузер (человек входит сам) либо вход паролем с кодом MFA из этого экрана. Пароль и код живут
 * только в полях формы и уходят одним запросом; после отправки поля очищаются. Состояние берём из опроса и из потока кадров.
 */

const TERMINAL = new Set<LoginSession["status"]>(["succeeded", "failed", "cancelled", "expired"]);
const MANUAL_HINT = new Set(["source_login_unrecognized", "source_login_form_ambiguous", "source_bot_protection", "source_login_failed"]);
const field = "min-h-11 w-full rounded-2xl bg-raised px-3 text-m text-text outline-none focus-visible:ring-2 focus-visible:ring-accent";
const primary = "min-h-11 rounded-2xl bg-accent px-4 text-m font-bold text-on-accent disabled:opacity-50";
const secondary = "min-h-11 rounded-2xl bg-raised px-4 text-m font-bold text-text disabled:opacity-50";

interface Props {
  client: ApiV1Client;
  login: LoginSession;
  onChange: (login: LoginSession | null) => void;
  /** Вход закончился успешно: сессия сохранена, сервер ставит синхронизацию. */
  onSucceeded: () => void;
  /** Вернуться к выбору способа входа. */
  onRestart: () => void;
  /** Войти вручную в удалённом браузере (после неудачи входа паролем). */
  onManual: () => void;
  pollMs?: number;
}

export function LoginFlow({ client, login, onChange, onSucceeded, onRestart, onManual, pollMs = 1500 }: Props) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const succeeded = useRef(false);
  const latest = useRef(login);
  latest.current = login;

  useEffect(() => {
    if (login.status === "succeeded" && !succeeded.current) { succeeded.current = true; onSucceeded(); }
  }, [login.status, onSucceeded]);

  // Опрос состояния, пока вход не закончился: поток кадров может не быть открыт (пароль), да и статус полезно сверять.
  useEffect(() => {
    if (TERMINAL.has(login.status)) return;
    let stop = false;
    const timer = setInterval(async () => {
      try {
        const { login: next } = await client.login(login.id);
        if (!stop) onChange(next);
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiV1Error && e.status === 404) { onChange(null); setError(sayCode("NOT_FOUND")); }
      }
    }, pollMs);
    return () => { stop = true; clearInterval(timer); };
  }, [client, login.id, login.status, onChange, pollMs]);

  const act = async (run: () => Promise<{ login: LoginSession }>) => {
    setBusy(true); setError(null);
    try { onChange((await run()).login); } catch (e) { setError(sayError(e)); } finally { setBusy(false); }
  };
  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    setCode("");
    void act(() => client.submitMfa(login.id, { code: value }));
  };

  const where = login.url ? login.url.replace(/^https?:\/\//, "") : null;
  const progress = LOGIN_PROGRESS[login.status];
  const manualView = login.status === "awaiting_user" || (login.mode === "interactive" && login.status === "awaiting_mfa");
  const cancel = <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => client.cancelLogin(login.id))}>Отмена</button>;

  return (
    <div className="flex flex-col gap-3" data-login-status={login.status} data-login-mode={login.mode}>
      {progress && <p role="status" className="text-m font-semibold">{progress}</p>}

      {manualView && (
        <>
          <p role="status" className="text-m font-bold">Войди на странице вуза{where ? <span className="font-semibold text-hint"> · {where}</span> : null}</p>
          <RemoteBrowserViewer client={client} loginId={login.id} onStatus={onChange} />
          <div className="flex gap-2">{cancel}</div>
        </>
      )}

      {login.status === "awaiting_mfa" && login.mode === "password" && (
        <form className="flex flex-col gap-2" aria-label="Код подтверждения" onSubmit={submitCode}>
          <p className="text-m font-bold">Нужен код подтверждения</p>
          <p className="text-s text-hint">{login.mfa?.kind === "totp" ? "Код из приложения-аутентификатора." : "Код из SMS, письма или приложения вуза."}{login.mfa ? ` Осталось попыток: ${login.mfa.attemptsLeft}.` : ""}</p>
          <label className="sr-only" htmlFor={`mfa-${login.id}`}>Код подтверждения</label>
          <input id={`mfa-${login.id}`} className={field} inputMode="numeric" autoComplete="one-time-code" maxLength={12} placeholder="Код" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primary} disabled={busy || !/^[0-9A-Za-z -]{4,12}$/.test(code.trim())}>Отправить код</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => client.handoff(login.id))}>Войти вручную в браузере</button>
            {cancel}
          </div>
        </form>
      )}

      {login.status === "filling" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => client.handoff(login.id))}>Войти вручную в браузере</button>{cancel}
        </div>
      )}

      {login.status === "succeeded" && <p role="status" className="rounded-2xl bg-green/10 px-3 py-2 text-m font-semibold text-green">Вход выполнен. Сессия сохранена, загружаю данные…</p>}

      {(login.status === "failed" || login.status === "cancelled" || login.status === "expired") && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-m font-semibold text-red">
            {login.status === "cancelled" ? "Вход отменён." : login.status === "expired" ? "Время на вход вышло. Начни заново." : sayCode(login.errorCode) || "Вход не удался."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={onRestart}>Попробовать снова</button>
            {login.mode === "password" && login.status === "failed" && (!login.errorCode || MANUAL_HINT.has(login.errorCode)) && (
              <button type="button" className={secondary} onClick={onManual}>Войти вручную в браузере</button>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-2xl bg-red/10 px-3 py-2 text-s font-semibold text-red">{error}</p>}
    </div>
  );
}
