"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { SubmitButton } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form";
import { cn } from "@/lib/cn";

// a one-button form that reports both the error and the success message (plan changes explain what happened)
export function ResultButton({ action, label, pendingLabel, variant = "secondary", hidden, className, disabled }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>; label: string; pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger"; hidden?: Record<string, string>; className?: string; disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className={cn("space-y-2", className)}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton size="sm" variant={variant} pendingLabel={pendingLabel ?? "Working…"} disabled={disabled}>{label}</SubmitButton>
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
    </form>
  );
}
