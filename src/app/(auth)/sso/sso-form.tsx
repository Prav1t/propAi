"use client";
import { useActionState, useEffect } from "react";
import { startSsoAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function SsoForm({ next }: { next?: string }) {
  const [state, action] = useActionState(startSsoAction, initialActionState);
  const url = (state.data as { url?: string } | undefined)?.url;
  // the identity provider is another site: navigate there directly (see startSsoAction)
  useEffect(() => {
    if (url) window.location.assign(url);
  }, [url]);
  return (
    <form action={action} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormAlert>{state.error}</FormAlert>
      {url ? <FormAlert kind="info">Taking you to your organization&apos;s sign-in…</FormAlert> : null}
      <Field label="Work email" name="email" error={state.fieldErrors?.email}>
        {(p) => <Input {...p} type="email" autoComplete="email" required defaultValue={state.values?.email} autoFocus />}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Finding your sign-in…">Continue</SubmitButton>
    </form>
  );
}
