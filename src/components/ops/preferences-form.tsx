"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Pref = { kind: string; label: string; email: boolean; inApp: boolean; push: boolean };

// `push`: show the push column (the person has at least one device subscribed)
export function PreferencesForm({ action, prefs, push = false }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; prefs: Pref[]; push?: boolean }) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-3 p-4">
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      {push ? <input type="hidden" name="withPush" value="1" /> : null}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[13px] text-muted"><th className="py-1.5 font-medium">Event</th><th className="w-16 py-1.5 text-center font-medium sm:w-20">In app</th><th className="w-16 py-1.5 text-center font-medium sm:w-20">Email</th>{push ? <th className="w-16 py-1.5 text-center font-medium sm:w-20">Push</th> : null}</tr></thead>
        <tbody className="divide-y divide-border">
          {prefs.map((p) => (
            <tr key={p.kind}>
              <td className="py-2 pr-2">{p.label}</td>
              <td className="text-center"><input type="checkbox" name={`app:${p.kind}`} defaultChecked={p.inApp} aria-label={`${p.label}: in app`} className="size-4 accent-[var(--color-accent)]" /></td>
              <td className="text-center"><input type="checkbox" name={`email:${p.kind}`} defaultChecked={p.email} aria-label={`${p.label}: email`} className="size-4 accent-[var(--color-accent)]" /></td>
              {push ? <td className="text-center"><input type="checkbox" name={`push:${p.kind}`} defaultChecked={p.push} aria-label={`${p.label}: push`} className="size-4 accent-[var(--color-accent)]" /></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <SubmitButton pendingLabel="Saving…">Save preferences</SubmitButton>
    </form>
  );
}
