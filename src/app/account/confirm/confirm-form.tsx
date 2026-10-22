"use client";
import { useActionState } from "react";
import { reauthAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function ConfirmForm({ next, method }: { next: string; method: "password" | "code" }) {
  const [state, action] = useActionState(reauthAction.bind(null, next), initialActionState);
  return (
    <form action={action} className="max-w-sm space-y-4">
      <FormAlert>{state.error}</FormAlert>
      {method === "password" ? (
        <Field label="Password" name="password">{(p) => <Input {...p} type="password" autoComplete="current-password" required autoFocus />}</Field>
      ) : (
        <Field label="Authenticator or recovery code" name="code">{(p) => <Input {...p} autoComplete="one-time-code" inputMode="text" required autoFocus />}</Field>
      )}
      <SubmitButton pendingLabel="Checking…">Confirm</SubmitButton>
    </form>
  );
}
