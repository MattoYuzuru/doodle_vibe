import { m } from "framer-motion";
import { Eye, EyeOff, LogIn, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Tile } from "../components/Tile";
import { useMainButton } from "../hooks/useTelegramButtons";
import { useAuth } from "../store/auth";
import { useAppStore } from "../store/useAppStore";
import { spring } from "../theme/motion";
import { haptic } from "../telegram/webapp";
import { fieldClass } from "./TaskForm";

/** Вход: логин и пароль Moodle МИСИС → сервер получает персональный токен; пароль хранится зашифрованно только для журнала. */
export function LoginScreen() {
  const { login, error: loadError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const canSubmit = username.trim().length > 1 && password.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      await login(username.trim(), password);
      setPassword("");
      haptic.success();
      void useAppStore.getState().refresh();
    } catch (e) {
      setErr((e as Error).message === "login_required" ? "Неверный логин или пароль" : (e as Error).message);
      haptic.warning();
    } finally { setBusy(false); }
  };
  const nativeButton = useMainButton("Войти", submit, canSubmit);

  return (
    <div className="flex min-h-[70vh] flex-col justify-center gap-4">
      <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring(380, 30)} className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Вход в Moodle</h1>
        <p className="mt-1 text-m text-hint">Дедлайны, оценки и расписание появятся после входа с учётной записью Moodle МИСИС.</p>
      </m.div>

      <Tile index={1} className="!min-h-0 flex flex-col gap-3">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Логин Moodle" autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} className={fieldClass} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        <div className="relative">
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль" type={show ? "text" : "password"} autoComplete="current-password"
            className={`${fieldClass} pr-12`} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          <button onClick={() => setShow((s) => !s)} aria-label={show ? "Скрыть пароль" : "Показать пароль"} className="absolute top-1/2 right-2 grid size-10 -translate-y-1/2 place-items-center text-hint">
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        {(err || loadError) && <p className="text-s font-semibold text-red">{err || loadError}</p>}
        {!nativeButton && (
          <button onClick={submit} disabled={!canSubmit} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">
            <LogIn size={18} strokeWidth={2.5} /> {busy ? "Входим…" : "Войти"}
          </button>
        )}
      </Tile>

      <p className="flex items-start gap-2 px-2 text-s text-hint">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" strokeWidth={2.25} />
        <span>Для Moodle приложение хранит зашифрованный токен доступа, как мобильное приложение Moodle. Пароль хранится в зашифрованном виде только для входа в электронный журнал МИСИС — чтобы журнал не просил его каждые двое суток. Выйти можно в любой момент — тогда пароль и токен удаляются. Входя, вы принимаете <a href="terms" target="_blank" rel="noreferrer" className="underline">условия использования</a> и <a href="privacy" target="_blank" rel="noreferrer" className="underline">политику конфиденциальности</a>.</span>
      </p>
    </div>
  );
}
