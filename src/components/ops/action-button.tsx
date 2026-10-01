"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { SubmitButton } from "@/components/ui/button";

// single-click server action (no fields); shows the error inline if it fails
export function ActionButton({ action, label, variant = "secondary", hidden }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>; label: string; variant?: "primary" | "secondary" | "ghost" | "danger"; hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {state.error ? <span role="alert" className="text-xs text-danger">{state.error}</span> : null}
      <SubmitButton size="sm" variant={variant} pendingLabel="…">{label}</SubmitButton>
    </form>
  );
}
