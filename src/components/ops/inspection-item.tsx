"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

// pass / fail / n.a. with severity and notes for failures; saves one item at a time
export function InspectionItemForm({ action, item }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; item: { result: string | null; severity: string | null; notes: string | null } }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [result, setResult] = useState(item.result ?? "");
  return (
    <form action={formAction} className="mt-2 space-y-2">
      <input type="hidden" name="result" value={result} />
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Result">
        {[["pass", "Pass"], ["fail", "Fail"], ["na", "N/A"]].map(([v, l]) => (
          <label key={v} className={cn("cursor-pointer rounded-[var(--radius-md)] border px-2.5 py-1 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40",
            result === v ? (v === "fail" ? "border-danger bg-danger-soft text-danger" : v === "pass" ? "border-success bg-success-soft text-success" : "border-accent bg-accent-soft text-accent") : "border-border-strong hover:bg-subtle")}>
            <input type="radio" name="_result" value={v} checked={result === v} onChange={() => setResult(v)} className="sr-only" />{l}
          </label>
        ))}
        {result === "fail" ? (
          <Select name="severity" aria-label="Severity" defaultValue={item.severity ?? ""} className="h-8 w-auto text-[13px]">
            <option value="">Severity…</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
          </Select>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Input name="notes" aria-label="Notes" defaultValue={item.notes ?? ""} placeholder="Notes (optional)" className="h-8 text-[13px]" />
        <SubmitButton size="sm" variant="secondary" pendingLabel="…" disabled={!result}>Save</SubmitButton>
      </div>
      {state.error ? <p role="alert" className="text-xs text-danger">{state.fieldErrors?.severity ?? state.error}</p> : state.ok ? <p className="text-xs text-success">Saved</p> : null}
    </form>
  );
}
