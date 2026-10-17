import { CloudOff } from "lucide-react";
import { useRef } from "react";
import { usePolling } from "../hooks/usePolling";
import { api } from "../store/api";
import type { MoodleHealth } from "../store/types";
import { useAppStore } from "../store/useAppStore";
import { Tile } from "./Tile";

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
/** «13:20» для сегодняшнего времени, «3 окт, 13:20» — для другого дня (по Москве, как всё в приложении). */
function when(ms: number) {
  const p = (t: number) => Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const a = p(ms), now = p(Date.now());
  const hm = `${a.hour}:${a.minute}`;
  return a.day === now.day && a.month === now.month ? hm : `${a.day} ${MONTHS[Number(a.month) - 1]}, ${hm}`;
}

/**
 * Плашка «Moodle сейчас не работает» (просьба владельца, 4 окт 2026): при сбое сети МИСИС или техработах студент видит,
 * что проблема на стороне университета, с какого времени и на какой момент показаны данные. Пока плашка на экране,
 * приложение раз в минуту спрашивает у сервера, ожил ли Moodle (сам Moodle при этом не опрашивается), и обновляется само.
 */
export function MoodleDown({ index = 0 }: { index?: number }) {
  const moodle = useAppStore((s) => s.moodle);
  const syncMoodle = useAppStore((s) => s.syncMoodle);
  const down = moodle.down ?? null;
  const shownAt = useRef(0);
  if (down && !shownAt.current) shownAt.current = Date.now();
  if (!down) shownAt.current = 0;
  usePolling(() => {
    // Первый опрос — не сразу: плашка появилась как раз после неудачной синхронизации.
    if (Date.now() - shownAt.current < 45_000) return;
    void api<{ moodle: MoodleHealth }>("api/status").then((s) => { if (!s.moodle.down) void syncMoodle(true); }).catch(() => { /* сервер недоступен — попробуем через минуту */ });
  }, 60_000, !!down);
  if (!down) return null;
  const maintenance = down.reason === "maintenance";
  return (
    <Tile span={2} index={index} className="!min-h-0 py-3" enter="fade">
      <div className="flex items-start gap-3" role="status">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-yellow/15 text-yellow"><CloudOff size={18} strokeWidth={2.5} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-m font-bold">{maintenance ? "В Moodle МИСИС технические работы" : "Moodle МИСИС сейчас не отвечает"}</span>
          <span className="mt-0.5 block text-s leading-[18px] text-hint">
            Это сбой на стороне университета — не у вас и не у Doodle.
            {down.since ? ` Не отвечает с ${when(down.since)}.` : ""}
            {moodle.at ? ` Показаны данные на ${when(moodle.at)}.` : ""}
            {" "}Сдать работу и запустить отчёт пока не получится. Обновлю всё сам, как только Moodle заработает.
          </span>
        </span>
      </div>
    </Tile>
  );
}
