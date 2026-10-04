"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";
import { TrackingInput } from "./tracking-input";

// fast front-desk intake: the building sticks between packages, everything else clears after each save
export function PackageIntake({ action, buildings, carriers, sizes }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  buildings: { value: string; label: string }[]; carriers: readonly string[]; sizes: { value: string; label: string }[];
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [building, setBuilding] = useState(buildings[0]?.value ?? "");
  const [round, setRound] = useState(0);
  const unitRef = useRef<HTMLInputElement>(null);
  const [seen, setSeen] = useState(state);
  if (seen !== state) { setSeen(state); if (state.ok) setRound((r) => r + 1); }
  useEffect(() => { if (state.ok) unitRef.current?.focus(); }, [state]);
  const err = state.fieldErrors ?? {};
  const v = (k: string) => (state.ok ? "" : state.values?.[k] ?? "");
  return (
    <form action={formAction} className="space-y-4 p-4" key={round}>
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Building" name="buildingId" error={err.buildingId}>
          {(p) => <Select {...p} value={building} onChange={(e) => setBuilding(e.target.value)}>{buildings.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</Select>}
        </Field>
        <Field label="Unit" name="unitNumber" error={err.unitNumber}>
          {(p) => <Input {...p} ref={unitRef} defaultValue={v("unitNumber")} placeholder="1204" autoComplete="off" inputMode="text" autoFocus />}
        </Field>
        <Field label="Recipient (optional)" name="recipientName" error={err.recipientName} hint="Defaults to the unit's primary resident.">
          {(p) => <Input {...p} defaultValue={v("recipientName")} autoComplete="off" />}
        </Field>
      </div>
      <TrackingInput carriers={carriers} error={err.trackingNumber} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Size" name="size" error={err.size}>
          {(p) => <Select {...p} defaultValue={v("size") || "small"}>{sizes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}
        </Field>
        <Field label="Shelf / location" name="shelfLocation" error={err.shelfLocation}>
          {(p) => <Input {...p} defaultValue={v("shelfLocation")} placeholder="B3" autoComplete="off" />}
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="perishable" className="size-4 accent-[var(--color-accent)]" /> Perishable / refrigerated
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Notes (optional)" name="notes" error={err.notes}>
          {(p) => <Input {...p} defaultValue={v("notes")} />}
        </Field>
        <div className="space-y-1.5">
          <label htmlFor="pkg-photo" className="block text-[13px] font-medium">Photo (optional)</label>
          <input id="pkg-photo" name="files" type="file" accept="image/*" capture="environment"
            className="block w-full text-[13px] file:mr-3 file:rounded-[var(--radius-md)] file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-[13px]" />
        </div>
      </div>
      <SubmitButton pendingLabel="Logging…">Log package</SubmitButton>
    </form>
  );
}
