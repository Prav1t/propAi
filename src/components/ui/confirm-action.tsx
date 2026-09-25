"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Button, SubmitButton } from "./button";
import { FormAlert, Input } from "./form";

// two-step destructive action; optionally requires typing a confirmation word
export function ConfirmAction({ action, label, confirmLabel, hidden, requireText, description, variant = "danger" }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  label: string; confirmLabel?: string; hidden?: Record<string, string>; requireText?: string; description?: string;
  variant?: "danger" | "secondary";
}) {
  const [armed, setArmed] = useState(false);
  const [state, formAction] = useActionState(action, initialActionState);
  if (!armed) return <Button type="button" variant={variant} size="sm" onClick={() => setArmed(true)}>{label}</Button>;
  return (
    <form action={formAction} className="space-y-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft/40 p-3">
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {description ? <p className="text-[13px]">{description}</p> : null}
      <FormAlert>{state.error}</FormAlert>
      {requireText ? (
        <label className="block text-[13px]">Type <strong className="font-mono">{requireText}</strong> to confirm
          <Input name="confirm" autoFocus className="mt-1 h-8" autoComplete="off" />
        </label>
      ) : null}
      <div className="flex gap-2">
        <SubmitButton size="sm" variant="danger" pendingLabel="Working…">{confirmLabel ?? "Confirm"}</SubmitButton>
        <Button type="button" size="sm" variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
      </div>
    </form>
  );
}
