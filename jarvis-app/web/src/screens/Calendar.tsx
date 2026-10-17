import { CalendarPlus, Copy, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Tile, TileLabel } from "../components/Tile";
import { toast } from "../components/Toast";
import { api } from "../store/api";
import { confirmDialog, haptic, tg } from "../telegram/webapp";

/** Ссылки подписки (GET api/calendar): stable — у сервера есть постоянный адрес, подписка обновляется сама. */
interface CalLinks { stable: boolean; url: string; webcal: string; apple: string; google: string; file: string }

/**
 * «Календарь в телефоне»: пары группы и сроки сдачи из Moodle — подпиской в обычном календаре (iPhone, Google).
 * Ссылка личная, с секретом; «Выдать новую» отключает старую. Без постоянного адреса у сервера — только разовый файл.
 */
export function CalendarScreen() {
  const [l, setL] = useState<CalLinks | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<CalLinks>("api/calendar").then(setL).catch((e) => setErr((e as Error).message)); }, []);

  const open = (u: string) => { haptic.tap(); if (tg?.openLink) tg.openLink(u); else window.open(u, "_blank"); };
  const copy = async () => {
    if (!l) return;
    haptic.select();
    try { await navigator.clipboard.writeText(l.url); toast("Ссылка скопирована"); }
    catch { toast("Не получилось скопировать — выделите ссылку ниже"); }
  };
  const reset = async () => {
    haptic.warning();
    if (!(await confirmDialog("Выдать новую ссылку? Старая перестанет работать: подписку в календаре придётся добавить заново."))) return;
    setBusy(true);
    try { setL(await api<CalLinks>("api/calendar", { reset: true })); toast("Новая ссылка готова"); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const btn = "flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-m font-bold disabled:opacity-40";
  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <h1 className="font-display text-l font-extrabold tracking-[-0.03em]">Календарь в телефоне</h1>
        <p className="mt-0.5 text-s font-semibold text-hint">Пары и сроки сдачи — в обычном календаре</p>
      </div>
      {!l && !err && <p className="px-1 text-s text-hint">Загружаю…</p>}
      {err && <p className="px-1 text-s font-semibold text-red">{err}</p>}
      {l && (
        <>
          <Tile index={0} className="!min-h-0 py-3">
            <TileLabel>Что появится в календаре</TileLabel>
            <p className="mt-2 text-s leading-[19px]">Пары вашей группы и подгруппы на шесть недель вперёд — с аудиториями и переносами. И сроки сдачи работ и тестов из Moodle.</p>
            <p className="mt-2 text-s leading-[19px] text-hint">{l.stable
              ? "Календарь обновляется сам: новые работы и изменения расписания появятся без вашего участия."
              : "Сейчас у сервера нет постоянного адреса, поэтому подписка недоступна. Можно скачать календарь файлом — он не обновляется сам, его придётся скачивать заново."}</p>
          </Tile>
          {l.stable ? (
            <>
              <button onClick={() => open(l.apple)} className={`${btn} bg-accent text-on-accent`}><CalendarPlus size={18} strokeWidth={2.5} /> iPhone, iPad, Mac</button>
              <button onClick={() => open(l.google)} className={`${btn} glass text-accent`}><CalendarPlus size={18} strokeWidth={2.5} /> Google Календарь</button>
              <p className="px-2 text-s leading-[18px] text-hint">В Google подписку добавляет сайт, а не приложение. Если на телефоне ничего не произошло, откройте на компьютере calendar.google.com → «Другие календари» → «Добавить по URL» и вставьте ссылку.</p>
              <Tile index={1} className="!min-h-0 py-3">
                <TileLabel>Ссылка для подписки</TileLabel>
                <p className="mt-2 select-all break-all text-s leading-[18px]">{l.url}</p>
                <button onClick={copy} className="mt-3 flex min-h-10 items-center gap-2 text-s font-bold text-accent"><Copy size={16} strokeWidth={2.5} /> Скопировать ссылку</button>
              </Tile>
              <p className="px-2 text-s leading-[18px] text-hint">iPhone обновляет подписку примерно раз в час, Google — раз в несколько часов. Срочные изменения по-прежнему присылает бот.</p>
              <p className="px-2 text-s leading-[18px] text-hint">Ссылка личная: по ней видно ваше расписание и названия работ. Если она попала к постороннему, выдайте новую.</p>
              <button onClick={reset} disabled={busy} className="flex min-h-10 items-center gap-2 px-2 text-s font-bold text-hint disabled:opacity-40"><RefreshCw size={15} strokeWidth={2.5} /> Выдать новую ссылку</button>
            </>
          ) : (
            <button onClick={() => open(l.file)} className={`${btn} bg-accent text-on-accent`}><Download size={18} strokeWidth={2.5} /> Скачать файл календаря</button>
          )}
        </>
      )}
    </div>
  );
}
