"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Field, FormAlert, Input, Select } from "./form";
import { SubmitButton } from "./button";

export type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "email" | "tel" | "url" | "number" | "date" | "datetime-local" | "textarea" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean | null;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  span?: 1 | 2;
  step?: string;
  autoFocus?: boolean;
  maxLength?: number;
};

type Props = {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  fields: FieldDef[];
  submitLabel: string;
  pendingLabel?: string;
  hidden?: Record<string, string>;
  columns?: 1 | 2;
  resetOnSuccess?: boolean;
  className?: string;
};

// renders a form from field definitions and wires validation errors from a server action
export function SchemaForm({ action, fields, submitLabel, pendingLabel, hidden, columns = 1, resetOnSuccess, className }: Props) {
  const [state, formAction] = useActionState(action, initialActionState);
  // React resets uncontrolled fields after each action; echoed values become the new defaults
  const value = (f: FieldDef) => (state.values && f.name in state.values && !(state.ok && resetOnSuccess) ? state.values[f.name] : f.defaultValue ?? "");
  return (
    <form action={formAction} noValidate className={cn("space-y-4", className)}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <div className={cn("grid gap-4", columns === 2 && "sm:grid-cols-2")}>
        {fields.map((f) => {
          const err = state.fieldErrors?.[f.name];
          const span = columns === 2 && f.span === 2 ? "sm:col-span-2" : undefined;
          if (f.type === "checkbox") {
            const checked = state.values && f.name in state.values ? state.values[f.name] === "on" : !!f.defaultValue;
            return (
              <label key={f.name} className={cn("flex items-start gap-2 text-sm", span)}>
                <input type="checkbox" name={f.name} defaultChecked={checked} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
                <span>{f.label}{f.hint ? <span className="block text-[13px] text-faint">{f.hint}</span> : null}</span>
              </label>
            );
          }
          return (
            <Field key={f.name} label={f.label} name={f.name} error={err} hint={f.hint} className={span}>
              {(p) =>
                f.type === "select" ? (
                  <Select {...p} defaultValue={String(value(f))} required={f.required}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : f.type === "textarea" ? (
                  <textarea {...p} defaultValue={String(value(f))} rows={4} placeholder={f.placeholder} maxLength={f.maxLength}
                    className="block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
                ) : (
                  <Input {...p} type={f.type ?? "text"} defaultValue={String(value(f))} placeholder={f.placeholder} required={f.required} step={f.step} autoFocus={f.autoFocus} maxLength={f.maxLength} />
                )
              }
            </Field>
          );
        })}
      </div>
      <SubmitButton pendingLabel={pendingLabel ?? "Saving…"}>{submitLabel}</SubmitButton>
    </form>
  );
}
