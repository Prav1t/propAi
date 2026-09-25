"use client";
import { useActionState } from "react";
import { updateProfileAction } from "./actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function ProfileForm({ name, email }: { name: string; email: string }) {
  const [state, action] = useActionState(updateProfileAction, initialActionState);
  return (
    <form action={action} className="max-w-md space-y-4 p-4">
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Name" name="name" error={state.fieldErrors?.name}>{(p) => <Input {...p} defaultValue={name} required />}</Field>
      <Field label="Email" name="email" hint="Contact support to change your sign-in email.">{(p) => <Input {...p} defaultValue={email} disabled />}</Field>
      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
}
