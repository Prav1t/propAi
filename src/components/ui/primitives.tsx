import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-lg)] border border-border bg-surface", className)} {...props} />;
}

export function PanelHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted [&_a]:underline [&_a]:underline-offset-2">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted [&_a]:underline [&_a]:underline-offset-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-subtle text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>
  );
}

// stat tile; value must come from real data
export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-faint">{sub}</div> : null}
    </div>
  );
}

// `cards`: on phones each row becomes a card, every cell on its own line with its column name (Td `label`), instead of
// a table squeezed sideways or with columns dropped (see .table-cards in globals.css)
export function Table({ className, cards, ...props }: HTMLAttributes<HTMLTableElement> & { cards?: boolean }) {
  return (
    <div className={cards ? "sm:overflow-x-auto" : "overflow-x-auto"}>
      <table className={cn("w-full border-collapse text-sm [&_tbody_tr:last-child_td]:border-b-0", cards && "table-cards", className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("border-b border-border px-4 py-2 text-left text-xs font-medium text-muted", className)} {...props} />;
}
export function Td({ className, label, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { label?: string }) {
  return <td data-label={label} className={cn("border-b border-border px-4 py-2.5 align-middle", className)} {...props} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

// empty list with the obvious next step: clear the filters that hid everything, or create the first record
export function ListEmpty({ title, filtered, clearHref, create, children }: {
  title: string; filtered?: boolean; clearHref?: string; create?: { href: string; label: string } | null; children?: ReactNode;
}) {
  const action = filtered && clearHref
    ? <Link href={clearHref} className="text-[13px] font-medium text-accent hover:underline">Clear filters</Link>
    : create ? <Link href={create.href} className="inline-flex h-9 items-center rounded-[var(--radius-md)] bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90">{create.label}</Link> : null;
  return (
    <EmptyState title={filtered ? "Nothing matches these filters" : title} action={action}>
      {filtered ? "Try a different search or remove a filter." : children}
    </EmptyState>
  );
}

// true when any list filter (other than the view tab and page) is set
export function hasFilters(q: Record<string, string | string[] | undefined>, ignore: string[] = ["view", "page", "tab"]) {
  return Object.entries(q).some(([k, v]) => !ignore.includes(k) && typeof v === "string" && v !== "");
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span aria-hidden className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent", className)}>
      {initials}
    </span>
  );
}
