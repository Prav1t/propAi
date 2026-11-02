import { cn } from "@/lib/cn";

// placeholders while a section streams in; announced once to screen readers, the shapes themselves are hidden
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden style={style} className={cn("animate-pulse rounded-[var(--radius-md)] bg-subtle motion-reduce:animate-none", className)} />;
}

export function SectionLoading({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" data-loading={label}>
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

export function StatsSkeleton({ label, count = 4, className }: { label: string; count?: number; className?: string }) {
  return (
    <SectionLoading label={label}>
      <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-4", className)}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-2.5 h-6 w-14" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
    </SectionLoading>
  );
}

export function ListSkeleton({ label, rows = 5, title = true, className }: { label: string; rows?: number; title?: boolean; className?: string }) {
  return (
    <SectionLoading label={label}>
      <div className={cn("rounded-[var(--radius-lg)] border border-border bg-surface", className)}>
        {title ? <div className="border-b border-border px-4 py-3"><Skeleton className="h-4 w-36" /></div> : null}
        <ul className="divide-y divide-border">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="flex-1 space-y-2"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-2/5" /></span>
              <Skeleton className="h-5 w-16 rounded-full" />
            </li>
          ))}
        </ul>
      </div>
    </SectionLoading>
  );
}

export function ChartSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <SectionLoading label={label}>
      <div className={cn("rounded-[var(--radius-lg)] border border-border bg-surface p-4", className)}>
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 flex h-40 items-end gap-2">
          {[40, 65, 50, 80, 55, 70, 45, 60].map((h, i) => <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />)}
        </div>
      </div>
    </SectionLoading>
  );
}
