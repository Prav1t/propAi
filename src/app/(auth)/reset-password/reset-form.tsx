"use client";
import { useActionState } from "react";
import { resetPasswordAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function ResetForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, initialActionState);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormAlert>{state.error}</FormAlert>
      <Field label="New password" name="password" error={state.fieldErrors?.password} hint="At least 10 characters.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" required autoFocus />}
      </Field>
      <Field label="Confirm password" name="confirm" error={state.fieldErrors?.confirm}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" required />}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Saving…">Set new password</SubmitButton>
    </form>
  );
}
