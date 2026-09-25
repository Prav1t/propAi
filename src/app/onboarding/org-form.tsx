"use client";
import { useActionState } from "react";
import { createOrgAction } from "./actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

const KINDS: [string, string][] = [
  ["property_management", "Property management company"], ["strata", "Strata / HOA / condo corporation"],
  ["rental", "Rental operator / landlord"], ["facility", "Facility management"],
  ["concierge", "Concierge / security company"], ["owner_operator", "Building owner / operator"],
];

export function OrgForm({ timezones }: { timezones: readonly string[] }) {
  const [state, action] = useActionState(createOrgAction, initialActionState);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert>{state.error}</FormAlert>
      <Field label="Organization name" name="name" error={state.fieldErrors?.name}>
        {(p) => <Input {...p} required autoFocus placeholder="e.g. Pacific Properties Management" defaultValue={state.values?.name} />}
      </Field>
      <Field label="Type" name="kind" error={state.fieldErrors?.kind}>
        {(p) => (
          <Select {...p} defaultValue={state.values?.kind ?? "property_management"}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Time zone" name="timezone" error={state.fieldErrors?.timezone}>
        {(p) => (
          <Select {...p} defaultValue={state.values?.timezone ?? "America/Vancouver"}>
            {timezones.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </Select>
        )}
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating…">Create organization</SubmitButton>
    </form>
  );
}
