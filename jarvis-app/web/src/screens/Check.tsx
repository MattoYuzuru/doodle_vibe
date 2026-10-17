import { CircleAlert, CircleCheck, FileSearch, FileUp, Info, LoaderCircle, RotateCcw, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { EmptyState } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { LABS_OFF_TEXT, labErrorText } from "../lib/labGate";
import { useAuth } from "../store/auth";
import { MAX_UPLOAD_BYTES, assignIdOf, checkApi, type CheckItem, type CheckState } from "../store/api";
import { useAppStore } from "../store/useAppStore";
import { haptic } from "../telegram/webapp";

const LEVEL: Record<CheckItem["level"], { title: string; hint: string; color: string }> = {
  must: { title: "Обязательно исправить", hint: "преподаватель, скорее всего, вернёт работу", color: "text-red" },
  should: { title: "Желательно исправить", hint: "может снизить оценку", color: "text-yellow" },
  minor: { title: "Мелочи", hint: "по желанию", color: "text-hint" },
};
const VERDICT: Record<NonNullable<CheckState["result"]>["verdict"], { text: string; cls: string }> = {
  ok: { text: "Можно сдавать", cls: "bg-green/15 text-green" },
  fix: { text: "Есть что исправить", cls: "bg-yellow/15 text-yellow" },
  serious: { text: "Серьёзные замечания", cls: "bg-red/15 text-red" },
};
const mins = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 1 ? "меньше минуты" : `${m} мин`; };
const when = (at: number) => new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * «Проверка своего отчёта»: студент загружает отчёт, который написал сам; агент сверяет его с заданием, методичкой,
 * оформлением и прежними замечаниями преподавателя и перечисляет, что поправить. Отчёт не переписывается и никуда не уходит.
 */
export function CheckScreen({ id }: { id: string }) {
  const pop = useNav((s) => s.pop);
  const d = useAppStore((s) => s.deadlines.find((x) => x.id === id));
  const assignId = assignIdOf(id);
  const [st, setSt] = useState<CheckState | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  // Лабы выключены на сервере (переезд): проверку не запустить, прежний итог виден.
  const labsOff = useAuth((s) => !!s.profile?.labsOff);

  // Загрузка — отдельной функцией: после ошибки первого запроса (сервер просыпается, туннель не ответил) экран больше не
  // заходит в тупик с одной красной строкой — есть «Повторить» (проверка 15 окт).
  const reload = useCallback(() => {
    if (!assignId) return;
    setErr("");
    checkApi.get(assignId).then((s) => { setSt(s); setErr(""); }).catch((e) => setErr((e as Error).message));
  }, [assignId]);
  useEffect(() => { reload(); }, [reload]);
  // Пока проверка идёт — опрос раз в 5 секунд и счётчик времени.
  const running = st?.status === "running";
  useEffect(() => {
    if (!running || !assignId) return;
    const t = setInterval(() => { setNow(Date.now()); checkApi.get(assignId).then(setSt).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [running, assignId]);

  const pick = () => { haptic.select(); fileRef.current?.click(); };
  const upload = async (file: File | undefined) => {
    if (!file || !assignId) return;
    if (!/\.(pdf|docx)$/i.test(file.name)) { haptic.warning(); toast("Нужен отчёт в формате PDF или DOCX"); return; }
    if (file.size > MAX_UPLOAD_BYTES) { haptic.warning(); toast("Файл больше 20 МБ — сожмите рисунки и попробуйте ещё раз"); return; }
    setSending(true);
    try { setSt(await checkApi.start(assignId, file)); setErr(""); setNow(Date.now()); haptic.success(); }
    catch (e) { haptic.warning(); toast(labErrorText((e as Error).message)); }
    finally { setSending(false); }
  };

  if (!assignId) return <EmptyState icon={FileSearch} title="Проверка недоступна" text="Проверить можно отчёт по заданию из Moodle." action="Назад" onAction={pop} />;
  if (err === "labs_not_allowed") return <EmptyState icon={FileSearch} title="Нужен доступ к отчётам" text="Проверка отчёта доступна тем, кому владелец бота открыл отчёты с агентом." action="Назад" onAction={pop} />;

  const r = st?.status === "done" ? st.result : null;
  const picker = (label: string, primary: boolean) => labsOff ? null : (
    <button onClick={pick} disabled={sending} className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold disabled:opacity-60 ${primary ? "bg-accent text-on-accent" : "glass text-accent"}`}>
      {sending ? <LoaderCircle size={18} strokeWidth={2.5} className="animate-spin" /> : <FileUp size={18} strokeWidth={2.5} />} {sending ? "Отправляю файл…" : label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Проверка отчёта</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">{d?.title ?? st?.title ?? "Задание из Moodle"}</p>
      </div>
      {labsOff && <p className="glass rounded-2xl px-3.5 py-3 text-s leading-[19px]">⏸ {LABS_OFF_TEXT}</p>}
      <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void upload(f); }} />
      {err && err !== "labs_not_allowed" && (
        <>
          <p className="px-1 text-s font-semibold text-red wrap-anywhere">{err}</p>
          <button onClick={() => { haptic.tap(); reload(); }} className="glass flex min-h-12 items-center justify-center gap-2 rounded-2xl text-m font-bold text-accent">
            <RotateCcw size={18} strokeWidth={2.5} /> Повторить
          </button>
        </>
      )}

      {(!st || st.status === "idle") && !err && (
        <>
          <Tile index={0} className="!min-h-0 py-3">
            <p className="flex items-start gap-2 text-m font-semibold"><FileSearch size={18} strokeWidth={2.25} className="mt-0.5 shrink-0 text-accent" />Загрузите отчёт, который вы написали сами, — PDF или DOCX.</p>
            <p className="mt-2 text-s leading-[18px] text-hint">Агент сверит его с заданием и методичкой, с правилами оформления и с тем, что преподаватель уже писал по этому курсу, и перечислит, что поправить до сдачи: где, что не так и что сделать.</p>
            <p className="mt-2 text-s leading-[18px] text-hint">Сам отчёт он не переписывает и никуда не отправляет — в Moodle ничего не меняется. Проверка занимает 5–10 минут; итог придёт и сюда, и сообщением бота.</p>
          </Tile>
          {st && picker("Выбрать файл отчёта", true)}
        </>
      )}

      {running && st && (
        <Tile index={0} className="!min-h-0 py-3">
          <div className="flex items-center gap-3">
            <LoaderCircle size={22} strokeWidth={2.5} className="shrink-0 animate-spin text-accent" />
            <div className="min-w-0">
              <p className="text-m font-bold">{st.stage ?? "Проверяю отчёт"}</p>
              <p className="truncate text-s text-hint">{st.file.name} · идёт {mins(now - st.at)}</p>
            </div>
          </div>
          <p className="mt-2.5 text-s leading-[18px] text-hint">Обычно 5–10 минут. Приложение можно закрыть — итог придёт сообщением бота.</p>
        </Tile>
      )}

      {st?.status === "error" && (
        <>
          <Tile index={0} className="!min-h-0 py-3">
            <p className="flex items-start gap-2 text-m font-semibold text-red wrap-anywhere"><CircleAlert size={18} strokeWidth={2.25} className="mt-0.5 shrink-0" />{st.error}</p>
          </Tile>
          {picker("Загрузить отчёт ещё раз", true)}
        </>
      )}

      {r && st && (
        <>
          <Tile index={0} className="!min-h-0 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className={`rounded-full px-3 py-1 text-s font-bold ${VERDICT[r.verdict].cls}`}>{VERDICT[r.verdict].text}</span>
              <span className="truncate text-[12px] font-semibold text-hint">{st.doneAt ? when(st.doneAt) : ""}</span>
            </div>
            {/* wrap-anywhere: длинный путь, ссылка или имя файла в выводах агента переносятся, а не уводят экран вбок (проверка 15 окт). */}
            <p className="mt-2.5 text-m leading-[21px] wrap-anywhere">{r.summary}</p>
            <p className="mt-2 truncate text-s text-hint">{st.file.name}{st.n > 1 ? ` · проверка № ${st.n}` : ""}</p>
          </Tile>

          {(["must", "should", "minor"] as const).map((lv) => {
            const list = r.items.filter((x) => x.level === lv);
            if (!list.length) return null;
            return (
              <div key={lv} className="flex flex-col gap-2">
                <TileLabel className={`px-1 pt-1 ${LEVEL[lv].color}`}>{LEVEL[lv].title} · {list.length}<span className="pl-1.5 font-semibold normal-case tracking-normal text-hint">{LEVEL[lv].hint}</span></TileLabel>
                {list.map((x, i) => (
                  <Tile key={`${lv}${i}`} index={i + 1} className="!min-h-0 py-3">
                    {(x.where || x.area) && <p className="text-[12px] font-bold uppercase tracking-wide text-hint wrap-anywhere">{[x.where, x.area].filter(Boolean).join(" · ")}</p>}
                    <p className="mt-1 text-m leading-[21px] wrap-anywhere">{x.what}</p>
                    {x.fix && <p className="mt-1.5 flex items-start gap-1.5 text-s leading-[18px] font-semibold text-accent wrap-anywhere"><CircleCheck size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" />{x.fix}</p>}
                  </Tile>
                ))}
              </div>
            );
          })}
          {r.items.length === 0 && (
            <Tile index={1} className="!min-h-0 py-3"><p className="flex items-center gap-2 text-m font-semibold text-green"><CircleCheck size={18} strokeWidth={2.5} />Замечаний не нашлось.</p></Tile>
          )}

          {r.good.length > 0 && (
            <Tile index={2} className="!min-h-0 py-3">
              <TileLabel className="flex items-center gap-1.5 text-green"><ThumbsUp size={13} strokeWidth={2.5} />Что хорошо</TileLabel>
              <ul className="mt-1.5 flex flex-col gap-1 wrap-anywhere">{r.good.map((g, i) => <li key={i} className="text-s leading-[18px]">— {g}</li>)}</ul>
            </Tile>
          )}
          {r.unchecked.length > 0 && (
            <Tile index={3} className="!min-h-0 py-3">
              <TileLabel className="flex items-center gap-1.5"><Info size={13} strokeWidth={2.5} />Что проверить не удалось</TileLabel>
              <ul className="mt-1.5 flex flex-col gap-1 wrap-anywhere">{r.unchecked.map((g, i) => <li key={i} className="text-s leading-[18px] text-hint">— {g}</li>)}</ul>
            </Tile>
          )}
          {picker("Проверить исправленный отчёт", false)}
          <p className="px-2 text-s text-hint">Это проверка программой и агентом, а не преподавателем: она ловит оформление и расхождения с заданием, но оценку не обещает.</p>
        </>
      )}
    </div>
  );
}
