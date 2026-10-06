"use client";
import { useActionState } from "react";
import { updateAiSettingsAction } from "../../assistant/actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function AiSettingsForm({ orgSlug, enabled, cap, used }: { orgSlug: string; enabled: boolean; cap: number | null; used: number }) {
  const [state, action] = useActionState(updateAiSettingsAction, initialActionState);
  return (
    <form action={action} className="max-w-md space-y-4 p-4" noValidate>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={state.values ? state.values.enabled === "on" : enabled} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
        <span>Let people in this organization use the assistant<span className="block text-xs text-muted">It works only with what each person&apos;s role allows, and changes wait for their approval unless a rule below says otherwise.</span></span>
      </label>
      <Field label="Monthly request limit" name="monthlyRequestCap" error={state.fieldErrors?.monthlyRequestCap}
        hint={`Leave blank for no limit. Used so far this month: ${used.toLocaleString("en-CA")}. When the limit is reached, questions are refused until next month.`}>
        {(p) => <Input {...p} type="number" min={1} inputMode="numeric" defaultValue={state.values?.monthlyRequestCap ?? (cap ?? "")} className="max-w-40" />}
      </Field>
      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
}
