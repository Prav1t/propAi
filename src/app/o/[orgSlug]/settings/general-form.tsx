"use client";
import { useActionState } from "react";
import { updateOrgSettingsAction } from "./actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function GeneralForm({ orgSlug, name, timezone, timezones, parkingSecondReviewer }: { orgSlug: string; name: string; timezone: string; timezones: readonly string[]; parkingSecondReviewer: boolean }) {
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
      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium">Parking enforcement</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="parkingSecondReviewer" defaultChecked={state.values ? state.values.parkingSecondReviewer === "on" : parkingSecondReviewer} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
          <span>Require a second staff member to review parking reports before a notice can be issued<span className="block text-xs text-muted">Camera detections always need a person&apos;s review, whatever this setting.</span></span>
        </label>
      </fieldset>
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
