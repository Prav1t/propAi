"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";

const CHOICES = [["for", "For"], ["against", "Against"], ["abstain", "Abstain"]] as const;

// a council member's own vote on one motion; pressing another choice changes it until the motion is decided
export function VoteButtons({ action, mine, motion }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; mine: string | null; motion: number }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" aria-label={`Your vote on motion ${motion}`}>
      {CHOICES.map(([value, label]) => (
        <button key={value} name="choice" value={value} disabled={pending} aria-pressed={mine === value}
          className={cn("min-h-9 rounded-[var(--radius-md)] border px-3 text-[13px] font-medium pointer-coarse:min-h-11", mine === value ? "border-accent bg-accent text-accent-fg" : "border-border-strong hover:bg-subtle")}>
          {label}
        </button>
      ))}
      <span className="text-[13px] text-muted" role="status">{state.error ? <span className="text-danger">{state.error}</span> : mine ? `You voted ${mine === "abstain" ? "to abstain" : mine}. You can change it until the result is recorded.` : "You haven't voted."}</span>
    </form>
  );
}
