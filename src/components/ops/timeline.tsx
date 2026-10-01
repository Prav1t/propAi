import { Badge } from "@/components/ui/primitives";
import { fmtDateTime } from "@/lib/time";

type Ev = { e: { id: string; kind: string; body: string | null; fromStatus: string | null; toStatus: string | null; visibility: string; createdAt: Date }; actorName: string | null };

const VIS: Record<string, string> = { internal: "Internal note", vendor: "Staff & vendor" };

// chronological activity log; visibility tags show who else can read each entry
export function Timeline({ events, statusLabels, tz, showVisibility }: { events: Ev[]; statusLabels: Record<string, { label: string }>; tz: string; showVisibility: boolean }) {
  if (!events.length) return <p className="px-4 py-6 text-center text-[13px] text-faint">No activity yet.</p>;
  return (
    <ol className="space-y-0 px-4 py-3">
      {events.map(({ e, actorName }, i) => (
        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
          {i < events.length - 1 ? <span aria-hidden className="absolute left-[5px] top-3 h-full w-px bg-border" /> : null}
          <span aria-hidden className={`mt-1.5 size-[11px] shrink-0 rounded-full border-2 ${e.kind === "comment" ? "border-accent bg-surface" : "border-border-strong bg-subtle"}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px]">
              <span className="font-medium">{actorName ?? "System"}</span>{" "}
              <span className="text-muted">
                {e.kind === "comment" ? "commented" : e.kind === "status" && e.toStatus ? <>moved this to <strong className="font-medium text-fg">{statusLabels[e.toStatus]?.label ?? e.toStatus}</strong></> :
                  e.kind === "created" ? "created this" : e.kind === "assigned" ? "updated the assignment" : e.kind === "scheduled" ? "scheduled a visit" :
                  e.kind === "attachment" ? "added files" : e.kind === "rule" ? "applied triage rules" : e.kind === "guidance" ? "shared what to do next" : e.kind === "sla" ? "flagged an SLA miss" : e.kind === "escalated" ? "escalated this" : "updated this"}
              </span>
              {showVisibility && VIS[e.visibility] ? <Badge className="ml-2" tone={e.visibility === "internal" ? "warning" : "neutral"}>{VIS[e.visibility]}</Badge> : null}
            </p>
            {e.body ? <p className="mt-1 whitespace-pre-line break-words text-sm">{e.body}</p> : null}
            <time className="text-xs text-faint" dateTime={e.createdAt.toISOString()}>{fmtDateTime(e.createdAt, tz)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
