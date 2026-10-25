import { useState } from "react";
import type { Connection, SourceDocument, SourceFreshness, SourceItem } from "../api/v1";

/* Полученная информация: расписание, дедлайны, курсы, документы. У каждого источника видно, когда данные получены и устарели ли они. */

export interface Section { items: SourceItem[]; sources: SourceFreshness[] }
export interface SpaceResults {
  schedule: Section | null; deadlines: Section | null; courses: Section | null;
  documents: SourceDocument[] | null;
  /** Какие запросы не удались: прежние данные остаются на экране. */
  failed: string[];
}
type Tab = "schedule" | "deadlines" | "courses" | "documents";
const TABS: [Tab, string][] = [["schedule", "Расписание"], ["deadlines", "Дедлайны"], ["courses", "Курсы"], ["documents", "Документы"]];
const STALE_MS = 24 * 3600_000;

const day = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const stamp = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const when = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? new Date(t) : null; };
export const fmtStamp = (iso: string) => { const d = when(iso); return d ? stamp.format(d) : "неизвестно"; };

function span(item: SourceItem) {
  const a = when(item.startsAt), b = when(item.endsAt);
  if (!a) return null;
  return `${day.format(a)}, ${clock.format(a)}${b ? `–${clock.format(b)}` : ""}`;
}
const safeUrl = (url?: string) => (url && /^https:\/\//i.test(url) ? url : null);

function Freshness({ sources, labels, now }: { sources: SourceFreshness[]; labels: Map<string, string>; now: number }) {
  if (!sources.length) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label="Свежесть данных">
      {sources.map((s) => {
        const stale = s.stale || now - Date.parse(s.fetchedAt) > STALE_MS;
        return (
          <li key={s.connectionId} data-fresh={stale ? "stale" : "fresh"} className={`text-s font-semibold ${stale ? "text-yellow" : "text-hint"}`}>
            {labels.get(s.connectionId) ?? "Источник"} · получено {fmtStamp(s.fetchedAt)}{stale ? " · данные устарели" : ""}
          </li>
        );
      })}
    </ul>
  );
}

function Row({ title, meta, url, sub }: { title: string; meta?: string | null; url?: string | null; sub?: string | null }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-separator py-2 first:border-t-0">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-m font-semibold text-accent [overflow-wrap:anywhere]">{title}</a> : <span className="text-m font-semibold [overflow-wrap:anywhere]">{title}</span>}
      {meta && <span className="text-s font-semibold text-hint">{meta}</span>}
      {sub && <span className="text-s text-hint [overflow-wrap:anywhere]">{sub}</span>}
    </li>
  );
}

export function Results({ results, connections, now }: { results: SpaceResults; connections: Connection[]; now: number }) {
  const [tab, setTab] = useState<Tab>("schedule");
  const labels = new Map(connections.map((c) => [c.id, c.label || new URL(c.sourceUrl).host]));
  const counts: Record<Tab, number | null> = {
    schedule: results.schedule?.items.length ?? null, deadlines: results.deadlines?.items.length ?? null,
    courses: results.courses?.items.length ?? null, documents: results.documents?.length ?? null,
  };
  const section = tab === "documents" ? null : results[tab];
  const docFresh: SourceFreshness[] = [];
  for (const d of results.documents ?? []) {
    const existing = docFresh.find((f) => f.connectionId === d.connectionId);
    if (!existing) docFresh.push({ connectionId: d.connectionId, fetchedAt: d.fetchedAt, stale: false });
    else if (Date.parse(d.fetchedAt) > Date.parse(existing.fetchedAt)) existing.fetchedAt = d.fetchedAt;
  }
  const items = [...(section?.items ?? [])];
  if (tab === "schedule") items.sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""));
  if (tab === "deadlines") items.sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
  const empty = (counts[tab] ?? 0) === 0;
  return (
    <section className="flex flex-col gap-3 rounded-[22px] bg-card p-4" aria-label="Полученные данные" data-results>
      <h2 className="font-display text-m font-extrabold">Данные</h2>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Что показать">
        {TABS.map(([id, title]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`min-h-11 rounded-2xl px-3 text-s font-bold ${tab === id ? "bg-accent text-on-accent" : "bg-raised text-text"}`}>
            {title}{counts[id] ? ` · ${counts[id]}` : ""}
          </button>
        ))}
      </div>
      {results.failed.length > 0 && (
        <p role="alert" className="rounded-2xl bg-yellow/10 px-3 py-2 text-s font-semibold text-yellow">Не удалось обновить: {results.failed.join(", ")}. Показаны последние полученные данные.</p>
      )}
      <Freshness sources={tab === "documents" ? docFresh : section?.sources ?? []} labels={labels} now={now} />
      {empty ? (
        <p className="text-m text-hint">{counts[tab] === null ? "Загружаю…" : "Пока ничего нет. Данные появятся после подключения источника и первой синхронизации."}</p>
      ) : (
        <ul data-results-list={tab}>
          {tab === "documents"
            ? (results.documents ?? []).map((d) => <Row key={d.id} title={d.title || d.url} url={safeUrl(d.url)} meta={`получено ${fmtStamp(d.fetchedAt)}`} sub={d.text.slice(0, 160)} />)
            : items.map((it) => (
              <Row key={it.id} title={it.title} url={safeUrl(it.url)}
                meta={tab === "deadlines" ? (when(it.dueAt) ? `до ${day.format(when(it.dueAt)!)}, ${clock.format(when(it.dueAt)!)}` : null) : tab === "schedule" ? span(it) : null}
                sub={tab === "schedule" ? it.location : it.description} />
            ))}
        </ul>
      )}
    </section>
  );
}
