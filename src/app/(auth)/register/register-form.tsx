"use client";
import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function RegisterForm({ devMailbox }: { devMailbox: boolean }) {
  const [state, action] = useActionState(registerAction, initialActionState);
  if (state.ok) {
    return (
      <div className="space-y-4" role="status">
        <FormAlert kind="success">
          Check <strong>{state.values?.email}</strong> for a verification link. It expires in 24 hours.
        </FormAlert>
        {devMailbox ? (
          <p className="text-[13px] text-muted">
            Development: emails are captured in the <Link className="text-accent hover:underline" href="/dev/mailbox">dev mailbox</Link>.
          </p>
        ) : null}
        <Link href="/login" className="block text-center text-[13px] text-accent hover:underline">Go to sign in</Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert>{state.error}</FormAlert>
      <Field label="Full name" name="name" error={state.fieldErrors?.name}>
        {(p) => <Input {...p} autoComplete="name" required defaultValue={state.values?.name} autoFocus />}
      </Field>
      <Field label="Work email" name="email" error={state.fieldErrors?.email}>
        {(p) => <Input {...p} type="email" autoComplete="email" required defaultValue={state.values?.email} />}
      </Field>
      <Field label="Password" name="password" error={state.fieldErrors?.password} hint="At least 10 characters.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={10} />}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}
