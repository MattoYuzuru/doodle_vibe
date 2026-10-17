import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "../components/Toast";
import { useNav } from "../hooks/useNav";
import { useMainButton } from "../hooks/useTelegramButtons";
import { useUi } from "../hooks/useUi";
import { todayKey } from "../lib/dates";
import { useAppStore } from "../store/useAppStore";
import { confirmDialog, haptic } from "../telegram/webapp";

export const fieldClass = "glass-tile block w-full rounded-2xl px-4 py-3 text-m outline-none placeholder:text-hint focus:ring-2 focus:ring-accent/60";

/** Форма задачи: текст, день, время. «Сохранить» — системная кнопка Telegram, вне его — своя внизу. */
export function TaskFormScreen({ id, date }: { id?: string; date?: string }) {
  const { tasks, addTask, updateTask, deleteTask } = useAppStore();
  const pop = useNav((s) => s.pop);
  const found = tasks.find((t) => t.id === id);
  // Уезжающий экран (проверка 15 окт): после «Удалить» задачи в сторе уже нет, а экран ещё ~0,4 с уезжает — без снимка он
  // на глазах становился «Новой задачей» с активной «Добавить», и нажатие возвращало удалённую задачу.
  const last = useRef(found);
  if (found) last.current = found;
  // Форма уже сохранена или задача удалена: двойной тап по «Сохранить» больше не добавляет вторую такую же задачу.
  const done = useRef(false);
  const existing = found ?? (done.current ? last.current : undefined);
  const [text, setText] = useState(existing?.text ?? "");
  const [day, setDay] = useState(existing?.date ?? date ?? todayKey());
  const [time, setTime] = useState(existing?.time ?? "");
  const canSave = text.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day);

  const close = () => { useUi.setState({ exitDir: 1 }); pop(); };
  const save = () => {
    if (!canSave || done.current) return;
    done.current = true;
    if (existing) updateTask(existing.id, { text: text.trim(), date: day, time });
    else addTask({ text: text.trim(), date: day, time });
    haptic.success();
    toast(existing ? "Сохранено" : "Задача добавлена");
    close();
  };
  const remove = async () => {
    if (!existing || done.current) return;
    done.current = true; // пока открыт вопрос, «Сохранить» и второе «Удалить» не срабатывают
    haptic.warning();
    if (await confirmDialog(`Удалить «${existing.text}»?`)) { deleteTask(existing.id); toast("Удалено"); close(); }
    else done.current = false;
  };
  const nativeButton = useMainButton(existing ? "Сохранить" : "Добавить", save, canSave);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-display px-1 text-l font-extrabold tracking-[-0.03em]">{existing ? "Задача" : "Новая задача"}</h1>
      <input
        autoFocus={!existing}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        placeholder="Что нужно сделать"
        maxLength={200}
        className={fieldClass}
      />
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="px-1 text-s font-bold text-hint">День</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="px-1 text-s font-bold text-hint">Время</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={fieldClass} />
        </label>
      </div>
      {!nativeButton && (
        <button onClick={save} disabled={!canSave} className="min-h-12 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">
          {existing ? "Сохранить" : "Добавить"}
        </button>
      )}
      {existing && (
        <button onClick={remove} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-red/15 text-m font-bold text-red">
          <Trash2 size={18} strokeWidth={2.5} /> Удалить задачу
        </button>
      )}
    </div>
  );
}
