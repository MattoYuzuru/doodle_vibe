import { ChevronRight, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { useNav } from "../hooks/useNav";
import { labApi, type LabSummary } from "../store/api";
import { useAuth } from "../store/auth";
import { confirmDialog, haptic } from "../telegram/webapp";
import { LabPulse } from "./LabPulse";
import { Tile, TileLabel } from "./Tile";
import { toast } from "./Toast";
import { ProgressBar } from "./ui";

/** Что сейчас с лабой — словами и цветом. Всё, где ход за студентом, выделено. */
function labelOf(l: LabSummary): { text: string; cls: string; yours: boolean } {
  if (l.status === "running") return l.queued ? { text: "В очереди", cls: "text-hint", yours: false } : { text: l.revising ? "Исправляет отчёт" : "Агент работает", cls: "text-accent", yours: false };
  if (l.status === "waiting") return { text: l.question ? "Ждёт ваш ответ" : "Ждёт вас: напишите «продолжай»", cls: "text-yellow", yours: true };
  if (l.status === "report") return l.review === "approved" ? { text: "Можно сдать в Moodle", cls: "text-green", yours: true } : { text: "Отчёт готов — проверьте", cls: "text-green", yours: true };
  if (l.status === "attached") return { text: "Черновик в Moodle — отправьте на проверку", cls: "text-green", yours: true };
  if (l.status === "error") return { text: "Ошибка — запустите заново", cls: "text-red", yours: true };
  return { text: "", cls: "text-hint", yours: false };
}

/**
 * Плашка на Главной: лабы с агентом, по которым что-то идёт или ждут студента, — прогресс, этап и что делать.
 * Нажатие открывает чат лабы. Опрос раз в 15 с (пока агент работает — чаще), только тем, кому открыты отчёты.
 * Крестик убирает лабу с Главной (просьба владельца, 4 окт 2026: плашка «ждёт ответа» висела, даже когда отвечать
 * студент не собирался): сама лаба и отчёт остаются в карточке работы, а новое действие по лабе вернёт плашку.
 */
export function ActiveLabs({ index = 1 }: { index?: number }) {
  const labsOk = useAuth((s) => s.profile?.labsAllowed ?? false);
  const push = useNav((s) => s.push);
  const [labs, setLabs] = useState<LabSummary[]>([]);
  const running = labs.some((l) => l.status === "running");
  usePolling(() => { labApi.list().then(setLabs).catch(() => { /* оставим прежнее */ }); }, running ? 5000 : 15000, labsOk);

  const dismiss = async (l: LabSummary) => {
    haptic.select();
    if (!(await confirmDialog(`Убрать «${l.title.length > 60 ? `${l.title.slice(0, 60)}…` : l.title}» с Главной? Переписка и отчёт сохранятся — они открываются из карточки работы. В Moodle ничего не изменится.`))) return;
    try { await labApi.dismiss(l.id); setLabs((all) => all.filter((x) => x.id !== l.id)); toast("Убрано с Главной"); }
    catch (e) { haptic.warning(); toast((e as Error).message); }
  };

  if (!labsOk || !labs.length) return null;
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3">
      <TileLabel className="flex items-center gap-1.5"><Sparkles size={13} strokeWidth={2.5} />Отчёты{labs.length > 1 && <span className="text-hint/70">{labs.length}</span>}</TileLabel>
      {labs.map((l, i) => {
        const s = labelOf(l), p = Math.round(l.progress ?? 0);
        return (
          <div key={l.id} className={`flex items-start gap-1 ${i ? "mt-3 border-t border-separator pt-3" : "mt-2"}`}>
            <button onClick={() => { haptic.tap(); push({ name: "lab", id: `moodle:assign:${l.id}` }); }} className="block min-w-0 flex-1 text-left">
              <span className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-m font-bold">{l.title}</span>
                  <span className={`block truncate text-s font-semibold ${s.cls}`}>
                    {s.yours && <span className="mr-1.5 inline-block size-2 rounded-full bg-current align-middle" />}{s.text}
                    {l.status === "running" && l.stage ? <span className="font-normal text-hint"> · {l.stage}</span> : null}
                  </span>
                </span>
                <span className="font-display shrink-0 text-[20px] font-extrabold tabular">{p}<span className="text-s font-bold text-hint">%</span></span>
                {l.status === "running" && <ChevronRight size={18} className="shrink-0 text-hint" />}
              </span>
              <span className="mt-2 block"><ProgressBar value={p / 100} /></span>
              {l.status === "running" && <LabPulse a={l.activity} className="mt-1.5" />}
            </button>
            {/* Пока агент работает, убирать нечего — плашка показывает ход работы. */}
            {l.status !== "running" && (
              <button onClick={() => void dismiss(l)} aria-label="Убрать с Главной" className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-hint active:bg-raised"><X size={17} strokeWidth={2.5} /></button>
            )}
          </div>
        );
      })}
    </Tile>
  );
}
