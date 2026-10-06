"use client";
import { useActionState, useRef, useState } from "react";
import { setAiPolicyAction } from "../../assistant/actions";
import { initialActionState } from "@/lib/action-state";
import { FormAlert, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import type { PolicyRow } from "@/server/ai/policies";

const MODE_LABEL = { default: "Default — ask first", auto: "Run without asking", confirm: "Ask first", deny: "Never" } as const;
const RISK = { 2: "Internal change", 3: "Contacts people", 4: "High impact", 5: "Irreversible" } as Record<number, string>;

// one rule = one tiny form that saves as soon as the choice changes
function RuleForm({ orgSlug, action, propertyId, mode, risk, label }: { orgSlug: string; action: string; propertyId: string | null; mode: string; risk: number; label: string }) {
  const [state, submit, pending] = useActionState(setAiPolicyAction, initialActionState);
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} action={submit} className="flex items-center gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="propertyId" value={propertyId ?? ""} />
      <Select name="mode" aria-label={label} defaultValue={mode} disabled={pending} onChange={() => ref.current?.requestSubmit()} className="h-8 w-56 max-w-full text-[13px]">
        {(propertyId ? ["auto", "confirm", "deny", "default"] : ["default", "auto", "confirm", "deny"]).map((m) => (
          <option key={m} value={m} disabled={m === "auto" && risk >= 3}>
            {propertyId && m === "default" ? "Remove override" : MODE_LABEL[m as keyof typeof MODE_LABEL]}{m === "auto" && risk >= 3 ? " (not allowed)" : ""}
          </option>
        ))}
      </Select>
      {pending ? <span className="text-[12px] text-faint">Saving…</span> : state.error ? <span role="alert" className="text-[12px] text-danger">{state.error}</span> : state.ok ? <span className="text-[12px] text-success">Saved</span> : null}
    </form>
  );
}

function AddOverride({ orgSlug, row, properties }: { orgSlug: string; row: PolicyRow; properties: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState(setAiPolicyAction, initialActionState);
  const free = properties.filter((p) => !row.overrides.some((o) => o.propertyId === p.id));
  if (!free.length) return null;
  if (!open) return <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setOpen(true)}>+ Property rule</Button>;
  return (
    <form action={submit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="action" value={row.key} />
      <Select name="propertyId" aria-label={`Property for ${row.label}`} className="h-8 w-44 text-[13px]" required defaultValue="">
        <option value="" disabled>Property…</option>
        {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <Select name="mode" aria-label={`Rule for ${row.label}`} className="h-8 w-40 text-[13px]" defaultValue="confirm">
        <option value="auto" disabled={row.risk >= 3}>Run without asking</option>
        <option value="confirm">Ask first</option>
        <option value="deny">Never</option>
      </Select>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Add"}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      {state.error ? <FormAlert>{state.error}</FormAlert> : null}
    </form>
  );
}

export function PolicyTable({ orgSlug, rows, properties }: { orgSlug: string; rows: PolicyRow[]; properties: { id: string; name: string }[] }) {
  return (
    <div className="divide-y divide-border">
      {rows.map((r) => (
        <div key={r.key} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{r.label} <Badge tone={r.risk >= 3 ? "accent" : "neutral"}>{RISK[r.risk] ?? `Class ${r.risk}`}</Badge></p>
            <p className="mt-0.5 text-[13px] text-muted">{r.help}</p>
            {r.overrides.length ? (
              <ul className="mt-2 space-y-1.5">
                {r.overrides.map((o) => (
                  <li key={o.propertyId} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="w-40 truncate text-muted">{o.propertyName}</span>
                    <RuleForm orgSlug={orgSlug} action={r.key} propertyId={o.propertyId} mode={o.mode} risk={r.risk} label={`${r.label} at ${o.propertyName}`} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1.5"><AddOverride key={r.overrides.length} orgSlug={orgSlug} row={r} properties={properties} /></div>
          </div>
          <div className="md:pt-0.5">
            <RuleForm orgSlug={orgSlug} action={r.key} propertyId={null} mode={r.orgMode ?? "default"} risk={r.risk} label={`${r.label} — whole organization`} />
          </div>
        </div>
      ))}
    </div>
  );
}
