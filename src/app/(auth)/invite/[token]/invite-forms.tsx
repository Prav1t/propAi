"use client";
import { useActionState } from "react";
import { acceptInviteAction, acceptInviteNewUserAction } from "./actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInviteAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <FormAlert>{state.error}</FormAlert>
      <SubmitButton className="w-full" pendingLabel="Joining…">Accept invitation</SubmitButton>
    </form>
  );
}

export function NewUserInviteForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(acceptInviteNewUserAction, initialActionState);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormAlert>{state.error}</FormAlert>
      <Field label="Email" name="email_display">
        {(p) => <Input {...p} value={email} readOnly disabled />}
      </Field>
      <Field label="Full name" name="name" error={state.fieldErrors?.name}>
        {(p) => <Input {...p} autoComplete="name" required autoFocus defaultValue={state.values?.name} />}
      </Field>
      <Field label="Password" name="password" error={state.fieldErrors?.password} hint="At least 10 characters.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" required />}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating account…">Create account and join</SubmitButton>
    </form>
  );
}
