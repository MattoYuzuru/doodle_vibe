import { Check, FileText, Paperclip } from "lucide-react";
import { useRef, useState } from "react";
import { assignIdOf, MAX_UPLOAD_BYTES, submitOwn, uploadOwnFile, type OwnSubmitResult } from "../store/api";
import type { Deadline } from "../store/types";
import { useAppStore } from "../store/useAppStore";
import { confirmDialog, haptic } from "../telegram/webapp";
import { Tile, TileLabel } from "./Tile";
import { toast } from "./Toast";
import { ProgressBar } from "./ui";

const STATUS: Record<string, string> = { new: "ответа нет", draft: "черновик, на проверку не отправлен", submitted: "отправлено на проверку", reopened: "возвращено на доработку" };
const mb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace(".0", "")} МБ`);
// Окно подтверждения Telegram вмещает 256 знаков — длинные имена файлов сокращаем.
const short = (n: string) => (n.length > 38 ? `${n.slice(0, 26)}…${n.slice(-10)}` : n);

/**
 * «Ваш ответ в Moodle» в карточке работы: что сейчас сдано и кнопка «Прикрепить PDF» — свой файл с телефона уходит в
 * ответ Moodle. Каждое действие — после окна подтверждения, где сказано, что именно произойдёт: черновик или сразу
 * на проверку (у части заданий черновика нет), какой файл заменится. У заданий с черновиком отправка на проверку —
 * отдельной кнопкой. Агент тут не участвует, поэтому кнопка есть у всех вошедших.
 */
export function SubmitOwnFile({ deadline: d, index = 1 }: { deadline: Deadline; index?: number }) {
  const assignId = assignIdOf(d.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<OwnSubmitResult["state"]>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [line, setLine] = useState("");
  const up = d.upload;
  if (!assignId || d.source !== "moodle" || !up?.enabled) return null;

  const sub = local ?? d.submission ?? null;
  const files = sub?.files ?? [];
  const noDrafts = sub?.drafts === false;
  const canEdit = sub?.canEdit ?? true;
  // Та же логика, что на сервере: при одном файле или без места новый встаёт вместо прежних, иначе добавляется.
  const room = up.maxFiles > 1 && files.length < up.maxFiles;
  const label = !files.length ? (noDrafts ? "Сдать PDF в Moodle" : "Прикрепить PDF") : room ? "Добавить PDF" : "Заменить PDF";
  const canSubmit = !noDrafts && canEdit && files.length > 0 && (sub?.status === "draft" || sub?.status === "reopened");
  const limit = up.maxBytes || MAX_UPLOAD_BYTES;

  const pick = () => { setErr(""); haptic.tap(); inputRef.current?.click(); };
  const onFile = async (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = ""; // тот же файл можно выбрать ещё раз
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { setErr("Нужен файл PDF."); haptic.warning(); return; }
    if (file.size > limit) { setErr(`Файл ${mb(file.size)}, а в этом задании можно не больше ${mb(limit)}.`); haptic.warning(); return; }
    const name = /\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`;
    const same = files.includes(name);
    const replaced = same ? [name] : room ? [] : files;
    const was = replaced.length ? (replaced.length === 1 ? `«${short(replaced[0])}» будет заменён` : `прежние файлы (${replaced.length}) будут удалены`) : files.length ? "прежние файлы останутся" : "";
    const f = `«${short(name)}» (${mb(file.size)})`;
    const question = sub?.status === "submitted"
      ? `Работа уже на проверке. ${f} будет добавлен в сданный ответ${was ? `, ${was}` : ""}. Преподаватель увидит изменения. Продолжить?`
      : noDrafts
        ? `В этом задании нет черновика: ${f} сразу уйдёт преподавателю на проверку${was ? `, ${was}` : ""}. Сдать?`
        : `Прикрепить ${f} к ответу как черновик${was ? `, ${was}` : ""}? На проверку это ещё не отправляет.`;
    haptic.warning();
    if (!(await confirmDialog(question))) return;
    setBusy(true); setProgress(0); setErr("");
    try {
      const r = await uploadOwnFile(assignId, new File([file], name, { type: "application/pdf" }), setProgress);
      setLocal(r.state); setLine(r.line);
      haptic.success();
      toast(r.state?.status === "submitted" ? "Сдано в Moodle" : "Прикреплено в Moodle");
      void useAppStore.getState().syncMoodle(true);
    } catch (e) { setErr((e as Error).message); haptic.warning(); }
    finally { setBusy(false); setProgress(null); }
  };
  const submit = async () => {
    haptic.warning();
    const q = `Отправить работу на проверку преподавателю? После этого менять файлы будет нельзя.${up.statement ? " Вы подтверждаете, что работа выполнена вами." : ""}`;
    if (!(await confirmDialog(q))) return;
    setBusy(true); setErr("");
    try {
      const r = await submitOwn(assignId);
      setLocal(r.state); setLine(r.line);
      haptic.success(); toast(r.already ? "Работа уже на проверке" : "Отправлено на проверку");
      void useAppStore.getState().syncMoodle(true);
    } catch (e) { setErr((e as Error).message); haptic.warning(); }
    finally { setBusy(false); }
  };

  return (
    <Tile index={index} className="!min-h-0 py-3">
      <TileLabel className="flex items-center gap-1.5"><FileText size={13} strokeWidth={2.5} />Ваш ответ в Moodle</TileLabel>
      <p className="mt-2 text-s font-semibold">{sub ? STATUS[sub.status] ?? sub.status : "Состояние ещё не загружено"}</p>
      {files.map((n) => <p key={n} className="mt-1 flex items-center gap-1.5 text-s text-hint break-all"><FileText size={14} className="shrink-0" />{n}</p>)}
      {line && <p className="mt-2 text-s leading-[18px] text-hint">{line}</p>}
      {!canEdit && <p className="mt-2 text-s leading-[18px] text-hint">Moodle сейчас не разрешает менять ответ по этой работе (срок закрыт или работа уже оценена).</p>}
      {canEdit && !up.pdf && <p className="mt-2 text-s leading-[18px] text-hint">В этом задании PDF не принимается (разрешено: {up.types}).</p>}
      {canEdit && up.pdf && (
        <>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <button onClick={pick} disabled={busy} className="glass mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent disabled:opacity-40">
            <Paperclip size={18} strokeWidth={2.5} /> {busy && progress != null ? `Загружаю… ${Math.round(progress * 100)}%` : label}
          </button>
          {busy && progress != null && <div className="mt-2"><ProgressBar value={progress} /></div>}
          <p className="mt-2 text-[12px] leading-[16px] text-hint">
            {noDrafts ? "В этом задании нет черновика: прикреплённый файл сразу уходит на проверку. " : ""}
            PDF до {mb(limit)}{up.maxFiles > 1 ? `, файлов в ответе — до ${up.maxFiles}` : ", в ответе один файл"}.
          </p>
        </>
      )}
      {canSubmit && (
        <button onClick={submit} disabled={busy} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-green text-m font-bold text-white disabled:opacity-40">
          <Check size={18} strokeWidth={3} /> Отправить на проверку
        </button>
      )}
      {err && <p className="mt-2 text-s font-semibold text-red">{err}</p>}
    </Tile>
  );
}
