"use client";
import { useActionState } from "react";
import { updateOrgSettingsAction } from "./actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function GeneralForm({ orgSlug, name, timezone, timezones }: { orgSlug: string; name: string; timezone: string; timezones: readonly string[] }) {
  const [state, action] = useActionState(updateOrgSettingsAction, initialActionState);
  return (
    <form action={action} className="max-w-md space-y-4 p-4" noValidate>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Organization name" name="name" error={state.fieldErrors?.name}>
        {(p) => <Input {...p} defaultValue={state.values?.name ?? name} required />}
      </Field>
      <Field label="Time zone" name="timezone" error={state.fieldErrors?.timezone} hint="Used for SLAs, schedules and timestamps.">
        {(p) => <Select {...p} defaultValue={state.values?.timezone ?? timezone}>{timezones.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</Select>}
      </Field>
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
