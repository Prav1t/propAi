"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";
import { SignaturePad } from "./signature-pad";

// release form; package checkboxes elsewhere on the page join it via form="release-form"
export function ReleasePanel({ action, single }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; single?: { id: string; recipient: string | null } }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [round, setRound] = useState(0);
  const [seen, setSeen] = useState(state);
  if (seen !== state) { setSeen(state); if (state.ok) setRound((r) => r + 1); }
  const err = state.fieldErrors ?? {};
  return (
    <form id="release-form" action={formAction} className="space-y-3 p-4" key={round}>
      {single ? <input type="hidden" name="ids" value={single.id} /> : <p className="text-[13px] text-muted">Tick the packages being handed over, then confirm who took them.</p>}
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Picked up by" name="pickedUpByName" error={err.pickedUpByName}>
        {(p) => <Input {...p} defaultValue={state.ok ? "" : state.values?.pickedUpByName ?? single?.recipient ?? ""} autoComplete="off" />}
      </Field>
      {single ? (
        <Field label="Pickup code (optional)" name="pickupCode" error={err.pickupCode} hint="Ask for the 6-digit code from their notification.">
          {(p) => <Input {...p} inputMode="numeric" maxLength={6} autoComplete="off" />}
        </Field>
      ) : null}
      <SignaturePad />
      <SubmitButton pendingLabel="Releasing…">{single ? "Release package" : "Release selected"}</SubmitButton>
    </form>
  );
}
