import { m } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatLeftWords } from "../lib/dates";
import { badgeClass, urgencyOf } from "../theme/urgency";
import type { Deadline } from "../store/types";

/** Оценка без лишних нулей: 4.00000 → «4», 3.5 → «3,5». */
export const fmtGrade = (g: number) => (Number.isInteger(g) ? String(g) : g.toFixed(1).replace(".", ","));

export function SubjectDot({ color, className = "" }: { color?: string; className?: string }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${className}`} style={{ background: color ?? "var(--c-hint)" }} />;
}

export function UrgencyBadge({ deadline, now }: { deadline: Pick<Deadline, "due" | "status" | "grade" | "gradeMax">; now: number }) {
  const u = urgencyOf(deadline, now);
  const text = u === "done" ? (deadline.grade != null ? `${fmtGrade(deadline.grade)}${deadline.gradeMax ? ` / ${fmtGrade(deadline.gradeMax)}` : ""}` : "сдано")
    : u === "overdue" ? "просрочено" : formatLeftWords(deadline.due, now);
  return <span className={`tabular inline-flex h-6 items-center rounded-full px-2 text-s font-semibold whitespace-nowrap ${badgeClass[u]}`}>{text}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card bg-card px-4 ${className}`}>{children}</section>;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex min-h-11 items-center justify-between pt-1">
      <h2 className="text-m font-semibold">{title}</h2>
      {action && (
        <button onClick={onAction} className="-mr-2 min-h-11 px-2 text-m font-medium text-accent">{action}</button>
      )}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
      <m.div className="h-full rounded-full bg-accent" initial={false} animate={{ width: `${Math.round(value * 100)}%` }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }} />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded-card bg-raised motion-safe:animate-pulse ${className}`} />;
}

export function EmptyState({ icon: Icon, title, text, action, onAction }: {
  icon: LucideIcon; title: string; text: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-full bg-raised text-hint">
        <Icon size={24} strokeWidth={1.75} />
      </div>
      <p className="text-m font-semibold">{title}</p>
      <p className="mt-1 text-s text-hint">{text}</p>
      {action && (
        <button onClick={onAction} className="mt-4 min-h-11 rounded-card bg-accent px-6 text-m font-semibold text-on-accent">{action}</button>
      )}
    </div>
  );
}

export function Avatar({ name, photoUrl, size = 40 }: { name: string; photoUrl?: string; size?: number }) {
  const s = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (photoUrl) return <img src={photoUrl} alt="" style={s} className="shrink-0 rounded-full object-cover" />;
  return (
    <div style={s} className="grid shrink-0 place-items-center rounded-full bg-accent font-bold text-on-accent">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
