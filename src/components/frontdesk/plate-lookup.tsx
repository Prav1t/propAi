"use client";
import Link from "next/link";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Result = {
  plate: string; validPermitNow: boolean;
  vehicles: { id: string; make: string | null; model: string | null; color: string | null; unitNumber: string; buildingName: string; propertyName: string }[];
  permits: { id: string; number: number; kind: string; state: string; validUntil: string | Date | null; spaceCode: string | null; unitNumber: string | null; propertyName: string }[];
  visitors: { id: string; name: string; status: string; unitNumber: string | null }[];
  violations: { id: string; number: number; kind: string; status: string }[];
};

// patrol / desk lookup: facts about a plate for a person to act on
export function PlateLookup({ action, base }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; base: string }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const r = state.ok ? (state.data as Result) : null;
  return (
    <div className="space-y-3">
      <form action={formAction} className="flex gap-2" role="search" aria-label="Plate lookup">
        <label htmlFor="plate-q" className="sr-only">Licence plate</label>
        <Input id="plate-q" name="plate" placeholder="Licence plate" autoCapitalize="characters" autoComplete="off" defaultValue={state.values?.plate ?? ""} />
        <SubmitButton variant="secondary" pendingLabel="…">Look up</SubmitButton>
      </form>
      <FormAlert>{state.error}</FormAlert>
      {r ? (
        <div className="space-y-2 text-[13px]" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base font-semibold">{r.plate}</span>
            <span className={r.validPermitNow ? "font-medium text-success" : "font-medium text-warning"}>{r.validPermitNow ? "Valid permit right now" : "No permit valid right now"}</span>
          </p>
          {r.vehicles.map((v) => <p key={v.id}>Registered to Unit {v.unitNumber}, {v.buildingName} ({[v.color, v.make, v.model].filter(Boolean).join(" ") || "vehicle"})</p>)}
          {r.permits.slice(0, 3).map((x) => <p key={x.id} className="text-muted">Permit #{x.number} · {x.kind} · {x.state}{x.spaceCode ? ` · space ${x.spaceCode}` : ""}</p>)}
          {r.visitors.map((v) => <p key={v.id}><Link className="text-accent hover:underline" href={`${base}/visitors/${v.id}`}>Visitor {v.name}</Link> · {v.status === "checked_in" ? "on site" : "expected"}{v.unitNumber ? ` for Unit ${v.unitNumber}` : ""}</p>)}
          {r.violations.map((v) => <p key={v.id}><Link className="text-accent hover:underline" href={`${base}/parking/violations/${v.id}`}>Report #{v.number}</Link> · {v.kind.replace(/_/g, " ")} · {v.status}</p>)}
          {!r.vehicles.length && !r.permits.length && !r.visitors.length && !r.violations.length ? <p className="text-muted">Nothing on record for this plate.</p> : null}
          <p className="text-xs text-faint">Information only — decide what to do from what you see on site.</p>
          <Link href={`${base}/parking/violations/new?plate=${r.plate}`} className="text-accent hover:underline">Report a violation for {r.plate} →</Link>
        </div>
      ) : null}
    </div>
  );
}
