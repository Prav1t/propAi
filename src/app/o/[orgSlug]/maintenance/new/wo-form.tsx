"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Opt = { value: string; label: string };
const area = "block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

// one form for residents (their unit) and staff (any building/unit in scope); photos upload with the request
export function WorkOrderForm({ action, mode, units, buildings, categories, priorities }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  mode: "resident" | "staff"; units: Opt[]; buildings: Opt[]; categories: Opt[]; priorities: Opt[];
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const v = (k: string, d = "") => state.values?.[k] ?? d;
  const err = state.fieldErrors ?? {};
  const [emergency, setEmergency] = useState(v("isEmergency") === "on");
  // React resets the form after each action; keep the warning in sync with the echoed checkbox value
  const echoed = state.values?.isEmergency === "on";
  const [seen, setSeen] = useState(state);
  if (seen !== state) { setSeen(state); setEmergency(echoed); }
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormAlert>{state.error}</FormAlert>
      <div className="grid gap-4 sm:grid-cols-2">
        {mode === "resident" ? (
          <Field label="Unit" name="unitId" error={err.unitId} className="sm:col-span-2">
            {(p) => units.length === 1
              ? <><input type="hidden" name="unitId" value={units[0].value} /><p className="text-sm">{units[0].label}</p></>
              : <Select {...p} defaultValue={v("unitId", units[0]?.value)}>{units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</Select>}
          </Field>
        ) : (
          <>
            <Field label="Building" name="buildingId" error={err.buildingId}>
              {(p) => <Select {...p} defaultValue={v("buildingId")}><option value="">Choose a building…</option>{buildings.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</Select>}
            </Field>
            <Field label="Unit (optional)" name="unitNumber" error={err.unitNumber} hint="Leave blank for common areas.">
              {(p) => <Input {...p} defaultValue={v("unitNumber")} placeholder="e.g. 1204" />}
            </Field>
          </>
        )}
        <Field label="What's the problem?" name="title" error={err.title} className="sm:col-span-2">
          {(p) => <Input {...p} defaultValue={v("title")} placeholder="e.g. Kitchen sink leaking under the cabinet" maxLength={160} autoFocus />}
        </Field>
        <Field label="Category" name="category" error={err.category}>
          {(p) => <Select {...p} defaultValue={v("category", "general")}>{categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}
        </Field>
        {mode === "staff" ? (
          <Field label="Priority" name="priority" error={err.priority} hint="Leave on automatic to apply your triage rules.">
            {(p) => <Select {...p} defaultValue={v("priority")}><option value="">Automatic</option>{priorities.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}
          </Field>
        ) : <div className="hidden sm:block" />}
        {mode === "staff" ? (
          <Field label="Area (optional)" name="area" error={err.area}>
            {(p) => <Input {...p} defaultValue={v("area")} placeholder="e.g. Lobby, P2 parkade, Roof" />}
          </Field>
        ) : null}
        <Field label="Details" name="description" error={err.description} className="sm:col-span-2" hint="When did it start? Where exactly? Anything you've already tried?">
          {(p) => <textarea {...p} rows={4} defaultValue={v("description")} className={area} maxLength={5000} />}
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="isEmergency" defaultChecked={echoed} onChange={(e) => setEmergency(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
        <span>This is an emergency<span className="block text-[13px] text-faint">Active flooding, no heat in winter, gas smell, sparking, or someone trapped.</span></span>
      </label>
      {emergency ? (
        <div role="note" className="rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          If anyone is in danger, or you smell gas or see fire or smoke, call 911 first. Then submit this request so building staff are alerted.
        </div>
      ) : null}

      <fieldset className="space-y-3 rounded-[var(--radius-md)] border border-border p-3">
        <legend className="px-1 text-[13px] font-medium">Access</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="permissionToEnter" defaultChecked={v("permissionToEnter") === "on"} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
          <span>Staff or a contractor may enter {mode === "resident" ? "my" : "the"} unit if nobody is home</span>
        </label>
        <Field label="Entry notes (optional)" name="entryNotes" error={err.entryNotes}>
          {(p) => <Input {...p} defaultValue={v("entryNotes")} placeholder="Pets, alarm codes, best times…" maxLength={500} />}
        </Field>
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="wo-files" className="block text-[13px] font-medium">Photos or video (optional)</label>
        <input id="wo-files" name="files" type="file" multiple accept="image/*,application/pdf,video/mp4,video/quicktime"
          className="block w-full text-[13px] file:mr-3 file:rounded-[var(--radius-md)] file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-[13px]" />
        <p className="text-xs text-faint">Up to 5 files · images 10 MB, video 25 MB.</p>
      </div>
      <SubmitButton pendingLabel="Submitting…">Submit request</SubmitButton>
    </form>
  );
}
