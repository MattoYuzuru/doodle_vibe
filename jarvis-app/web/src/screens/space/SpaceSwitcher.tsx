import { Plus } from "lucide-react";
import { useNav } from "../../hooks/useNav";
import { usePlatform } from "../../store/platform";
import { haptic } from "../../telegram/webapp";

/** Переключатель вуза: данные всех вкладок и маскот меняются вместе с ним. «+» — подключить ещё один вуз или сайт. */
export function SpaceSwitcher() {
  const spaces = usePlatform((s) => s.spaces);
  const activeId = usePlatform((s) => s.activeId);
  const setActive = usePlatform((s) => s.setActive);
  const push = useNav((s) => s.push);
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Вуз">
      {spaces.map((s) => (
        <button key={s.id} type="button" aria-pressed={s.id === activeId}
          onClick={() => { haptic.select(); setActive(s.id); }}
          className={`min-h-11 rounded-2xl px-4 text-m font-bold ${s.id === activeId ? "bg-accent text-on-accent" : "bg-card text-text"}`}>
          {s.name}
        </button>
      ))}
      <button type="button" aria-label="Подключить вуз или сайт" onClick={() => { haptic.tap(); push({ name: "connect" }); }}
        className="grid size-11 place-items-center rounded-2xl bg-card text-accent">
        <Plus size={20} strokeWidth={2.5} />
      </button>
    </div>
  );
}
