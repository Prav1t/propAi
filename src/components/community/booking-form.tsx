"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Opt = { value: string; label: string; disabled?: boolean };

// start/duration choices come from the amenity's rules; the server re-checks everything
export function BookingForm({ action, amenityId, date, starts, durations, units, staff, capacity, approval, money, buildings = [] }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  amenityId: string; date: string; starts: Opt[]; durations: Opt[]; units: Opt[]; staff: boolean; capacity: number | null; approval: boolean; money: string | null;
  buildings?: Opt[]; // staff, property-wide amenity: which building the unit is in
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const err = state.fieldErrors ?? {};
  const v = (k: string, d = "") => state.values?.[k] ?? d;
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="amenityId" value={amenityId} />
      <input type="hidden" name="date" value={date} />
      <FormAlert>{state.error ? `This booking can't be made:\n${state.error}` : null}</FormAlert>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start" name="start" error={err.start}>
          {(p) => <Select {...p} defaultValue={v("start", starts.find((s) => !s.disabled)?.value)}>{starts.map((s) => <option key={s.value} value={s.value} disabled={s.disabled}>{s.label}</option>)}</Select>}
        </Field>
        <Field label="Length" name="durationMinutes" error={err.durationMinutes}>
          {(p) => <Select {...p} defaultValue={v("durationMinutes", durations[0]?.value)}>{durations.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}
        </Field>
        <Field label={capacity ? `People (max ${capacity})` : "People"} name="guests" error={err.guests}>
          {(p) => <Input {...p} type="number" min={1} max={capacity ?? undefined} defaultValue={v("guests", "1")} />}
        </Field>
        {staff ? (
          <div className="flex gap-2">
            {buildings.length > 1 ? (
              <Field label="Building" name="buildingId" error={err.buildingId} className="w-1/2">
                {(p) => <Select {...p} defaultValue={v("buildingId")}><option value="">Any</option>{buildings.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</Select>}
              </Field>
            ) : null}
            <Field label="For unit (optional)" name="unitNumber" error={err.unitNumber} hint="Blank for a staff booking." className="flex-1">
              {(p) => <Input {...p} defaultValue={v("unitNumber")} placeholder="1204" />}
            </Field>
          </div>
        ) : units.length > 1 ? (
          <Field label="Unit" name="unitId" error={err.unitId}>
            {(p) => <Select {...p} defaultValue={v("unitId", units[0].value)}>{units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</Select>}
          </Field>
        ) : <input type="hidden" name="unitId" value={units[0]?.value ?? ""} />}
        <Field label="Purpose (optional)" name="purpose" error={err.purpose} className="sm:col-span-2">
          {(p) => <Input {...p} defaultValue={v("purpose")} placeholder="e.g. Birthday dinner" maxLength={300} />}
        </Field>
      </div>
      {!staff && (approval || money) ? (
        <p className="text-[13px] text-muted">{[approval ? "Management will review this request before it's confirmed." : null, money].filter(Boolean).join(" ")}</p>
      ) : null}
      <SubmitButton pendingLabel="Checking…">{staff ? "Book" : approval ? "Request booking" : "Book now"}</SubmitButton>
    </form>
  );
}
