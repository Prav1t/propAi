import { cn } from "@/lib/cn";

type Step = { type: string; text: string };

// A rule drawn as the path an event takes: what starts it, the checks it must pass, then each step in order. Steps
// after "Ask for approval" are shown as waiting behind that gate. It's an ordered list underneath, so the reading
// order is the same for everyone; the connecting lines are decoration.
export function FlowView({ when, conditions, steps }: { when: string; conditions: string[]; steps: Step[] }) {
  const gate = steps.findIndex((s) => s.type === "request_approval");
  return (
    <ol aria-label="How this rule runs" className="relative space-y-0 px-4 py-4" data-testid="rule-flow">
      <Node kind="when" title="When" first>{when}</Node>
      <Node kind="if" title={conditions.length ? "Only if" : "Every time"}>
        {conditions.length ? (
          <ul className="space-y-0.5">{conditions.map((c, i) => <li key={i}>{i ? <span className="mr-1 text-[11px] font-semibold uppercase text-faint">and</span> : null}{c}</li>)}</ul>
        ) : <span className="text-muted">No conditions: it runs for everything that matches above.</span>}
      </Node>
      {steps.map((s, i) => (
        <Node key={i} kind={s.type === "request_approval" ? "gate" : s.type === "assistant_draft" ? "ai" : "then"} last={i === steps.length - 1}
          title={s.type === "request_approval" ? "Pause for approval" : `Then${steps.length > 1 ? ` · step ${i + 1}` : ""}`}
          waiting={gate >= 0 && i > gate}>
          {s.text}
          {s.type === "assistant_draft" ? <span className="mt-1 block text-[12px] text-muted">Written by the assistant as a draft note; nothing is sent.</span> : null}
          {s.type === "request_approval" ? <span className="mt-1 block text-[12px] text-muted">The steps below run only after someone approves.</span> : null}
        </Node>
      ))}
    </ol>
  );
}

const TONE = {
  when: "border-accent/50 bg-accent-soft/40",
  if: "border-border-strong bg-surface",
  then: "border-border bg-surface",
  gate: "border-warning/60 bg-warning-soft/60",
  ai: "border-accent/40 bg-surface",
} as const;
const LABEL_TONE = { when: "text-accent", if: "text-muted", then: "text-muted", gate: "text-warning", ai: "text-accent" } as const;

function Node({ kind, title, children, first, last, waiting }: { kind: keyof typeof TONE; title: string; children: React.ReactNode; first?: boolean; last?: boolean; waiting?: boolean }) {
  return (
    <li className="relative pl-7">
      {/* the line through the flow, and the dot marking this step */}
      {!first ? <span aria-hidden className="absolute left-[9px] top-0 h-3 w-px bg-border-strong" /> : null}
      {!last ? <span aria-hidden className={cn("absolute bottom-0 left-[9px] top-3 w-px", waiting ? "border-l border-dashed border-warning/70 bg-transparent" : "bg-border-strong")} /> : null}
      <span aria-hidden className={cn("absolute left-[4px] top-[18px] size-[11px] rounded-full border-2 bg-surface", kind === "gate" ? "rounded-sm border-warning" : kind === "when" ? "border-accent bg-accent" : "border-border-strong")} />
      <div className={cn("my-1.5 rounded-[var(--radius-md)] border px-3 py-2 text-sm", TONE[kind], waiting && "border-dashed")}>
        <p className={cn("mb-0.5 text-[11px] font-semibold uppercase tracking-wide", LABEL_TONE[kind])}>
          {title}{kind === "ai" ? <span className="ml-1.5 rounded bg-accent-soft px-1 py-px text-[10px] normal-case tracking-normal text-accent">Assistant</span> : null}
          {waiting ? <span className="ml-1.5 font-normal normal-case tracking-normal text-faint">after approval</span> : null}
        </p>
        {children}
      </div>
    </li>
  );
}
