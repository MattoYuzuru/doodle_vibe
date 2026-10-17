import { Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "../components/Toast";
import { useNav } from "../hooks/useNav";
import { useMainButton } from "../hooks/useTelegramButtons";
import { useUi } from "../hooks/useUi";
import { useAppStore } from "../store/useAppStore";
import { confirmDialog, haptic } from "../telegram/webapp";
import { formatUpdated } from "./Notes";

/** Редактор заметки: заголовок, текст, закрепить, удалить. Сохраняет по кнопке и при закрытии, если что-то менялось. */
export function NoteEditorScreen({ id }: { id?: string }) {
  const { notes, saveNote, deleteNote } = useAppStore();
  const pop = useNav((s) => s.pop);
  const existing = notes.find((n) => n.id === id);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [pinned, setPinned] = useState(existing?.pinned ?? false);
  // Что уже лежит в сторе под этой заметкой (для новой — пусто). После сохранения обновляем, чтобы закрытие не сохраняло
  // второй раз: раньше «Сохранить» у новой заметки создавало её, а размонтирование экрана — ещё одну копию.
  const saved = useRef({ id: existing?.id, title: existing?.title ?? "", body: existing?.body ?? "", pinned: existing?.pinned ?? false });
  const deleted = useRef(false);
  const latest = useRef({ title, body, pinned });
  latest.current = { title, body, pinned };
  const dirty = title !== saved.current.title || body !== saved.current.body || pinned !== saved.current.pinned;
  const canSave = dirty && (title.trim().length > 0 || body.trim().length > 0);

  const close = () => { useUi.setState({ exitDir: 1 }); pop(); };
  const persist = () => {
    const { title: t, body: b, pinned: p } = latest.current;
    const s = saved.current;
    if (!t.trim() && !b.trim()) return false;
    if (t === s.title && b === s.body && p === s.pinned) return false; // ничего не менялось — не трогаем updatedAt
    const id = saveNote({ id: s.id, title: t.trim(), body: b, pinned: p });
    saved.current = { id, title: t, body: b, pinned: p };
    return true;
  };
  const save = () => { if (!canSave) return; persist(); haptic.success(); toast("Сохранено"); close(); };
  const remove = async () => {
    if (!existing) return close();
    haptic.warning();
    if (await confirmDialog("Удалить заметку?")) { deleted.current = true; deleteNote(existing.id); toast("Удалено"); close(); }
  };
  // Закрыли смахиванием или «Назад» — не терять набранное (сохраняется только то, что изменилось).
  useEffect(() => () => { if (!deleted.current) persist(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const nativeButton = useMainButton("Сохранить", save, canSave);

  // Авторост текста под содержимое.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = bodyRef.current; if (el) { el.style.height = "0"; el.style.height = `${Math.max(el.scrollHeight, 200)}px`; } }, [body]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-s font-semibold text-hint">{existing ? `Изменено: ${formatUpdated(existing.updatedAt)}` : "Новая заметка"}</p>
        <div className="flex gap-1">
          <button onClick={() => { haptic.select(); setPinned((p) => !p); }} aria-pressed={pinned} aria-label={pinned ? "Открепить" : "Закрепить"}
            className={`grid size-10 place-items-center rounded-full ${pinned ? "bg-accent text-on-accent" : "glass text-hint"}`}>
            {pinned ? <Pin size={18} strokeWidth={2.5} /> : <PinOff size={18} strokeWidth={2.25} />}
          </button>
          {existing && (
            <button onClick={remove} aria-label="Удалить" className="glass grid size-10 place-items-center rounded-full text-red"><Trash2 size={18} strokeWidth={2.25} /></button>
          )}
        </div>
      </div>
      <input
        autoFocus={!existing}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Заголовок"
        maxLength={120}
        className="font-display w-full bg-transparent px-1 text-[26px] font-extrabold tracking-[-0.02em] outline-none placeholder:text-hint/60"
      />
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Текст заметки"
        maxLength={4000}
        className="glass-tile w-full resize-none rounded-[22px] px-4 py-3 text-m leading-[24px] outline-none placeholder:text-hint focus:ring-2 focus:ring-accent/60"
      />
      {!nativeButton && (
        <button onClick={save} disabled={!canSave} className="min-h-12 rounded-2xl bg-accent text-m font-bold text-on-accent disabled:opacity-40">Сохранить</button>
      )}
    </div>
  );
}
