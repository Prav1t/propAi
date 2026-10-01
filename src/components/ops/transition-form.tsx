"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

const area = "block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

// pick one allowed next status; completion asks for resolution notes and cost
export function TransitionForm({ action, options, askCost }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  options: { value: string; label: string; danger?: boolean }[];
  askCost: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [picked, setTo] = useState(options[0]?.value ?? "");
  // after a change the allowed options move on; fall back to the first valid one
  const to = options.some((o) => o.value === picked) ? picked : options[0]?.value ?? "";
  if (!options.length) return <p className="px-4 py-3 text-[13px] text-faint">No status changes available.</p>;
  const err = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-3 p-4">
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <input type="hidden" name="to" value={to} />
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">Move to</legend>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <label key={o.value} className={cn("cursor-pointer rounded-[var(--radius-md)] border px-2.5 py-1 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40",
              to === o.value ? (o.danger ? "border-danger bg-danger-soft text-danger" : "border-accent bg-accent-soft text-accent") : "border-border-strong hover:bg-subtle")}>
              {/* unnamed: React's post-action form reset can desync controlled radios from state, so the value posts via the hidden input */}
              <input type="radio" name="_to" value={o.value} checked={to === o.value} onChange={() => setTo(o.value)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      {to === "completed" && askCost ? (
        <>
          <Field label="What was done?" name="resolutionNotes" error={err.resolutionNotes}>
            {(p) => <textarea {...p} rows={3} className={area} defaultValue={state.values?.resolutionNotes ?? ""} />}
          </Field>
          <Field label="Cost (optional)" name="cost" error={err.cost} hint="Parts and labour, before tax.">
            {(p) => <Input {...p} type="number" step="0.01" min="0" defaultValue={state.values?.cost ?? ""} />}
          </Field>
        </>
      ) : null}
      <Field label={to === "completed" && askCost ? "Note to the requester (optional)" : "Note (optional)"} name="note" error={err.note}>
        {(p) => <Input {...p} defaultValue="" placeholder={to === "awaiting_resident" ? "What do you need from the resident?" : ""} />}
      </Field>
      <SubmitButton size="sm" pendingLabel="Saving…">Update status</SubmitButton>
    </form>
  );
}
