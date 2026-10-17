import { Trash2 } from "lucide-react";
import { useState } from "react";
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
  const existing = tasks.find((t) => t.id === id);
  const [text, setText] = useState(existing?.text ?? "");
  const [day, setDay] = useState(existing?.date ?? date ?? todayKey());
  const [time, setTime] = useState(existing?.time ?? "");
  const canSave = text.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day);

  const close = () => { useUi.setState({ exitDir: 1 }); pop(); };
  const save = () => {
    if (!canSave) return;
    if (existing) updateTask(existing.id, { text: text.trim(), date: day, time });
    else addTask({ text: text.trim(), date: day, time });
    haptic.success();
    toast(existing ? "Сохранено" : "Задача добавлена");
    close();
  };
  const remove = async () => {
    if (!existing) return;
    haptic.warning();
    if (await confirmDialog(`Удалить «${existing.text}»?`)) { deleteTask(existing.id); toast("Удалено"); close(); }
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
          <span className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-hint">День</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-hint">Время</span>
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
