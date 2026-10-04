"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { Button, SubmitButton } from "@/components/ui/button";
import { PassCard, type PassCardData } from "./pass-card";

type Opt = { value: string; label: string };

// invite a guest (residents) or register / walk in a visitor (desk); shows the pass once created
export function VisitorForm({ action, staff, homes, buildings, kinds, defaults, base }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>; staff: boolean; homes: Opt[]; buildings: Opt[]; kinds: Opt[];
  defaults: { date: string; from: string; until: string }; base: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [dismissed, setDismissed] = useState<ActionState | null>(null);
  const [multiDay, setMultiDay] = useState(false);
  const err = state.fieldErrors ?? {};
  const v = (k: string, d = "") => (state.ok ? d : state.values?.[k] ?? d);
  const card = state.ok ? (state.data as PassCardData | null) : null;
  if (card && dismissed !== state) {
    return (
      <div className="space-y-4 p-4">
        <FormAlert kind="success">{state.message}</FormAlert>
        <PassCard card={card} guestName={state.values?.name} base={base} />
        <Button type="button" variant="secondary" onClick={() => setDismissed(state)}>{staff ? "Register another visitor" : "Invite someone else"}</Button>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4 p-4" noValidate>
      <FormAlert>{state.error}</FormAlert>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Visitor's name" name="name" error={err.name}>{(p) => <Input {...p} defaultValue={v("name")} autoComplete="off" required />}</Field>
        <Field label="Type of visit" name="kind" error={err.kind}>{(p) => <Select {...p} defaultValue={v("kind", "guest")}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>}</Field>
        {staff ? (
          <>
            <Field label="Building" name="buildingId" error={err.buildingId}>{(p) => <Select {...p} defaultValue={v("buildingId", buildings.length === 1 ? buildings[0].value : "")}><option value="">Choose…</option>{buildings.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</Select>}</Field>
            <Field label="Visiting unit" name="unitNumber" error={err.unitNumber} hint="Leave empty for contractors working in common areas.">{(p) => <Input {...p} defaultValue={v("unitNumber")} inputMode="text" autoComplete="off" />}</Field>
          </>
        ) : homes.length > 1 ? (
          <Field label="Visiting" name="unitId" error={err.unitId} className="sm:col-span-2">{(p) => <Select {...p} defaultValue={v("unitId")}><option value="">Choose your home…</option>{homes.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}</Select>}</Field>
        ) : homes.length === 1 ? <input type="hidden" name="unitId" value={homes[0].value} /> : null}
        <Field label="Company (optional)" name="company" error={err.company}>{(p) => <Input {...p} defaultValue={v("company")} />}</Field>
        <Field label="Phone (optional)" name="phone" error={err.phone}>{(p) => <Input {...p} type="tel" defaultValue={v("phone")} autoComplete="off" />}</Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium">When</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" name="date" error={err.date}>{(p) => <Input {...p} type="date" defaultValue={v("date", defaults.date)} required />}</Field>
          <Field label="From" name="from" error={err.from}>{(p) => <Input {...p} type="time" defaultValue={v("from", defaults.from)} required />}</Field>
          <Field label="Until" name="until" error={err.until}>{(p) => <Input {...p} type="time" defaultValue={v("until", defaults.until)} required />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={multiDay} onChange={(e) => setMultiDay(e.target.checked)} className="size-4 accent-[var(--color-accent)]" /> Staying more than one day</label>
        {multiDay ? <Field label="Through date" name="throughDate" error={err.throughDate} hint={`The pass is valid every day until the "Until" time on this date.`}>{(p) => <Input {...p} type="date" defaultValue={v("throughDate")} />}</Field> : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Licence plate (optional)" name="plate" error={err.plate} hint="Needed for visitor parking.">{(p) => <Input {...p} defaultValue={v("plate")} autoCapitalize="characters" autoComplete="off" />}</Field>
        <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="needsParking" defaultChecked={v("needsParking") === "on"} className="size-4 accent-[var(--color-accent)]" /> Needs visitor parking</label></div>
        {staff ? <Field label="Work order # (contractors)" name="workOrderNumber" error={err.workOrderNumber}>{(p) => <Input {...p} inputMode="numeric" defaultValue={v("workOrderNumber")} />}</Field> : null}
        <Field label="Notes for the desk (optional)" name="purpose" error={err.purpose} className={staff ? undefined : "sm:col-span-2"}>{(p) => <Input {...p} defaultValue={v("purpose")} placeholder={staff ? "e.g. replacing the lobby door closer" : "e.g. my sister, staying for dinner"} />}</Field>
      </div>
      {staff ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="arrivingNow" defaultChecked={v("arrivingNow") === "on"} className="size-4 accent-[var(--color-accent)]" /> They&apos;re here now — check them in</label> : null}
      <SubmitButton pendingLabel="Saving…">{staff ? "Register visitor" : "Create guest pass"}</SubmitButton>
    </form>
  );
}
