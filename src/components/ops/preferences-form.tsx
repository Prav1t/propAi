"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Pref = { kind: string; label: string; email: boolean; inApp: boolean };

export function PreferencesForm({ action, prefs }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; prefs: Pref[] }) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-3 p-4">
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[13px] text-muted"><th className="py-1.5 font-medium">Event</th><th className="w-20 py-1.5 text-center font-medium">In app</th><th className="w-20 py-1.5 text-center font-medium">Email</th></tr></thead>
        <tbody className="divide-y divide-border">
          {prefs.map((p) => (
            <tr key={p.kind}>
              <td className="py-2 pr-2">{p.label}</td>
              <td className="text-center"><input type="checkbox" name={`app:${p.kind}`} defaultChecked={p.inApp} aria-label={`${p.label}: in app`} className="size-4 accent-[var(--color-accent)]" /></td>
              <td className="text-center"><input type="checkbox" name={`email:${p.kind}`} defaultChecked={p.email} aria-label={`${p.label}: email`} className="size-4 accent-[var(--color-accent)]" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <SubmitButton pendingLabel="Saving…">Save preferences</SubmitButton>
    </form>
  );
}
