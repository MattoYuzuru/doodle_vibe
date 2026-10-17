import { Check, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Segmented } from "../components/Segmented";
import { toast } from "../components/Toast";
import { SubjectDot } from "../components/ui";
import { useNav } from "../hooks/useNav";
import { useMainButton } from "../hooks/useTelegramButtons";
import { useUi } from "../hooks/useUi";
import { addDays, mskParts, todayKey } from "../lib/dates";
import type { DeadlineKind, Reminder } from "../store/types";
import { useAppStore } from "../store/useAppStore";
import { KINDS } from "../theme/kinds";
import { SUBJECT_COLORS, nextSubjectColor } from "../theme/subjects";
import { haptic } from "../telegram/webapp";
import { fieldClass } from "./TaskForm";

const REMINDERS: { value: Reminder; label: string }[] = [{ value: "day", label: "За сутки" }, { value: "3h", label: "За 3 часа" }, { value: "none", label: "Без" }];
const pad = (n: number) => String(n).padStart(2, "0");
/** Дата и время по Москве → момент в мс (МСК = UTC+3). */
const toMs = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = (time || "23:59").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm);
};
const fromMs = (ms: number) => { const p = mskParts(ms); return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}` }; };

const Label = ({ children }: { children: React.ReactNode }) => <span className="px-1 text-s font-bold text-hint">{children}</span>;

/** Форма дедлайна: название, тип, предмет (с созданием и цветом), дата и время, напоминание, заметка. */
export function DeadlineFormScreen({ id }: { id?: string }) {
  const { deadlines, subjects, addDeadline, updateDeadline, addSubject } = useAppStore();
  const pop = useNav((s) => s.pop);
  const existing = deadlines.find((d) => d.id === id);
  // Форма уже сохранена (проверка 15 окт): двойной тап по «Добавить», пока экран уезжает, создавал два одинаковых
  // дедлайна и два тоста.
  const done = useRef(false);
  const init = existing ? fromMs(existing.due) : { date: addDays(todayKey(), 7), time: "23:59" };
  const [title, setTitle] = useState(existing?.title ?? "");
  const [kind, setKind] = useState<DeadlineKind>(existing?.kind ?? "lab");
  const [subjectId, setSubjectId] = useState(existing?.subjectId ?? subjects[0]?.id ?? "");
  const [creating, setCreating] = useState(subjects.length === 0);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(nextSubjectColor(subjects.map((s) => s.color)));
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [reminder, setReminder] = useState<Reminder>(existing?.reminder ?? "day");
  const note = existing?.note ?? "";
  const [opens, setOpens] = useState(existing?.opensAt ? fromMs(existing.opensAt) : { date: "", time: "09:00" });

  const subjectOk = creating ? newName.trim().length > 0 : !!subjectId;
  const canSave = title.trim().length > 0 && subjectOk && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const close = () => { useUi.setState({ exitDir: 1 }); pop(); };

  const save = () => {
    if (!canSave || done.current) return;
    done.current = true;
    const sid = creating ? addSubject(newName, newColor) : subjectId;
    const due = toMs(date, time);
    const opensAt = kind === "test" && opens.date ? toMs(opens.date, opens.time) : undefined;
    const base = { title: title.trim(), kind, subjectId: sid, due, reminder, note: note.trim(), opensAt };
    if (existing) updateDeadline(existing.id, base);
    else addDeadline({ ...base, status: "open", subtasks: [], source: "local" });
    haptic.success();
    toast(existing ? "Сохранено" : "Дедлайн добавлен");
    close();
  };
  const nativeButton = useMainButton(existing ? "Сохранить" : "Добавить", save, canSave);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-display px-1 text-l font-extrabold tracking-[-0.03em]">{existing ? "Дедлайн" : "Новый дедлайн"}</h1>
      <input autoFocus={!existing} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ЛР2 · Название работы" maxLength={160} className={fieldClass} />

      <div className="flex flex-col gap-1.5">
        <Label>Тип</Label>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {KINDS.map((k) => {
            const active = kind === k.value;
            return (
              <button key={k.value} onClick={() => { haptic.select(); setKind(k.value); }} aria-pressed={active}
                className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-s font-bold transition-colors ${active ? "bg-accent text-on-accent" : "glass text-hint"}`}>
                <k.Icon size={15} strokeWidth={2.5} />{k.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Предмет</Label>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {subjects.map((s) => {
            const active = !creating && subjectId === s.id;
            return (
              <button key={s.id} onClick={() => { haptic.select(); setCreating(false); setSubjectId(s.id); }} aria-pressed={active}
                className={`flex min-h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-s font-bold transition-colors ${active ? "bg-accent text-on-accent" : "glass text-hint"}`}>
                <SubjectDot color={s.color} />{s.short}
              </button>
            );
          })}
          <button onClick={() => { haptic.select(); setCreating(true); }} aria-pressed={creating}
            className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-s font-bold transition-colors ${creating ? "bg-accent text-on-accent" : "glass text-accent"}`}>
            <Plus size={15} strokeWidth={2.5} />Новый
          </button>
        </div>
        {creating && (
          <div className="glass-tile mt-1 flex flex-col gap-3 rounded-[22px] p-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Название предмета" maxLength={80} className={`${fieldClass} min-h-11 py-2`} />
            <div className="flex items-center gap-2 px-1">
              <span className="text-s font-semibold text-hint">Цвет</span>
              <div className="flex gap-2">
                {SUBJECT_COLORS.map((c) => (
                  <button key={c} onClick={() => { haptic.select(); setNewColor(c); }} aria-label={c} aria-pressed={newColor === c}
                    className="grid size-8 place-items-center rounded-full" style={{ background: c }}>
                    {newColor === c && <Check size={16} strokeWidth={3} className="text-white" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1.5"><Label>Срок</Label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} /></label>
        <label className="flex flex-col gap-1.5"><Label>Время</Label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={fieldClass} /></label>
      </div>
      {kind === "test" && (
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1.5"><Label>Открыт с</Label><input type="date" value={opens.date} onChange={(e) => setOpens({ ...opens, date: e.target.value })} className={fieldClass} /></label>
          <label className="flex flex-col gap-1.5"><Label>Время</Label><input type="time" value={opens.time} onChange={(e) => setOpens({ ...opens, time: e.target.value })} className={fieldClass} /></label>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Напоминание</Label>
        <Segmented<Reminder> id="reminder" value={reminder} options={REMINDERS} onChange={setReminder} />
      </div>

      {!nativeButton && (
        <button onClick={save} disabled={!canSave} className="min-h-12 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">
          {existing ? "Сохранить" : "Добавить"}
        </button>
      )}
      <p className="px-1 text-center text-[12px] font-semibold text-hint">Время по Москве. Срок 00:00 показывается как 23:59 накануне.</p>
    </div>
  );
}
