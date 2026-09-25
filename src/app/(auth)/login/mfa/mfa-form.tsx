"use client";
import { useActionState } from "react";
import { mfaAction } from "../../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function MfaForm({ next }: { next?: string }) {
  const [state, action] = useActionState(mfaAction, initialActionState);
  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormAlert>{state.error}</FormAlert>
      <Field label="Authentication code" name="code" hint="6-digit code from your authenticator app, or a recovery code.">
        {(p) => <Input {...p} inputMode="text" autoComplete="one-time-code" required autoFocus maxLength={14} />}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Verifying…">Verify</SubmitButton>
    </form>
  );
}
