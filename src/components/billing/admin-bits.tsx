"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { SubmitButton } from "@/components/ui/button";
import { Select } from "@/components/ui/form";

// one feature flag: default / on / off, saved on its own
export function FlagControl({ action, flagKey, label, current, inherited }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>; flagKey: string; label: string; current: boolean | undefined; inherited: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const id = `flag-${flagKey}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="key" value={flagKey} />
      <label htmlFor={id} className="sr-only">{label}</label>
      <Select id={id} name="value" className="h-8 w-48! text-[13px]" defaultValue={current === undefined ? "default" : current ? "on" : "off"}>
        <option value="default">Default ({inherited ? "on" : "off"})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </Select>
      <SubmitButton size="sm" variant="secondary" pendingLabel="…">Save</SubmitButton>
      {state.error ? <span role="alert" className="text-xs text-danger">{state.error}</span> : state.ok ? <span role="status" className="text-xs text-success">Saved</span> : null}
    </form>
  );
}
