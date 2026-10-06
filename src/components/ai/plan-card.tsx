"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { PlanView } from "@/server/ai/approvals";
import { approvePlanAction, rejectPlanAction, revisePlanStepAction, type PlanActionResult } from "@/app/o/[orgSlug]/assistant/actions";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FormAlert, Input, Select } from "@/components/ui/form";
import { Icon } from "@/components/shell/icons";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/labels";

// dates arrive as strings over the stream and as Dates from the page
export type PlanUi = Omit<PlanView, "createdAt" | "expiresAt" | "decidedAt"> & { createdAt: string | Date; expiresAt: string | Date; decidedAt: string | Date | null };
type StepUi = PlanUi["steps"][number];

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for your approval", tone: "warning" },
  executing: { label: "Running", tone: "accent" },
  executed: { label: "Done", tone: "success" },
  partially_failed: { label: "Partly done", tone: "warning" },
  failed: { label: "Didn't run", tone: "danger" },
  rejected: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  superseded: { label: "Replaced by a newer plan", tone: "neutral" },
};
const RISK_TONE: Record<number, Tone> = { 1: "neutral", 2: "neutral", 3: "accent", 4: "danger", 5: "danger" };

function untilText(d: string | Date): string {
  const ms = new Date(d).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  return h >= 1 ? `expires in ${h} h` : `expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

function StepResultLine({ s }: { s: StepUi }) {
  const r = s.result;
  if (!r) return null;
  const tone = r.status === "executed" ? (r.warning || r.verified === false ? "text-warning" : "text-success") : r.status === "failed" ? "text-danger" : "text-faint";
  return (
    <div className="mt-2 space-y-1 rounded-[var(--radius-md)] bg-subtle px-2.5 py-2 text-[13px]">
      <p className={cn("flex items-start gap-1.5 font-medium", tone)}>
        <Icon name={r.status === "executed" ? "check" : r.status === "failed" ? "alert" : "clock"} className="mt-0.5 size-3.5 shrink-0" />
        <span>{r.summary}{r.record ? <> <Link href={r.record.href} className="text-accent underline-offset-2 hover:underline">Open {r.record.ref}</Link></> : null}</span>
      </p>
      {r.warning ? <p className="text-warning">{r.warning}</p> : null}
      {r.status === "executed" && r.check ? <p className="text-muted">{r.verified ? "Checked: " : "Couldn't confirm: "}{r.check}</p> : null}
    </div>
  );
}

function StepEditor({ s, busy, onSave, onCancel, error, field }: {
  s: StepUi; busy: boolean; error: string | null; field: string | null;
  onSave: (edits: Record<string, string>) => void; onCancel: () => void;
}) {
  const id = useId();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(s.editable.map((f) => [f.key, f.value])));
  return (
    <form className="mt-2 space-y-3 rounded-[var(--radius-md)] border border-border bg-bg p-3" onSubmit={(e) => { e.preventDefault(); onSave(vals); }}>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {s.editable.map((f) => {
          const fid = `${id}-${f.key}`;
          const common = { id: fid, name: f.key, value: vals[f.key] ?? "", "aria-invalid": field === f.key ? true : undefined, disabled: busy };
          const set = (v: string) => setVals((x) => ({ ...x, [f.key]: v }));
          return (
            <div key={f.key} className={cn("space-y-1", f.type === "textarea" && "sm:col-span-2")}>
              <label htmlFor={fid} className="block text-[12px] font-medium text-muted">{f.label}</label>
              {f.type === "textarea" ? (
                <textarea {...common} rows={f.key === "body" ? 7 : 3} onChange={(e) => set(e.target.value)}
                  className="block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-danger" />
              ) : f.type === "select" ? (
                <Select {...common} onChange={(e) => set(e.target.value)}>
                  <option value="">—</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : (
                <Input {...common} type={f.type === "number" ? "number" : f.type} onChange={(e) => set(e.target.value)} />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Checking…" : "Save changes"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Discard</Button>
      </div>
      <p className="text-[11px] text-faint">Changes are checked against the same rules again before the plan can be approved.</p>
    </form>
  );
}

export function PlanCard({ plan: initial, orgSlug, onChange }: { plan: PlanUi; orgSlug: string; onChange?: (p: PlanUi) => void }) {
  const router = useRouter();
  const [plan, setPlan] = useState<PlanUi>(initial);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "edit">(null);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const ackId = useId();
  const typedId = useId();
  if (initial.id !== plan.id || (initial.status !== plan.status && initial.status !== "pending")) {
    // the parent learned something newer (e.g. superseded by a later plan)
    setPlan(initial);
  }

  const apply = (r: PlanActionResult) => {
    if (r.plan) {
      setPlan(r.plan);
      onChange?.(r.plan);
    }
    if (!r.ok) setError({ message: r.error, field: r.field });
    else setError(null);
    router.refresh();
    return r.ok;
  };
  const run = async (kind: "approve" | "reject" | "edit", fn: () => Promise<PlanActionResult>) => {
    setBusy(kind);
    try {
      return apply(await fn());
    } catch {
      setError({ message: "Connection lost. Please try again." });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const status = STATUS[plan.status] ?? { label: plan.status, tone: "neutral" as Tone };
  const pending = plan.status === "pending" && plan.canDecide;
  const ready = plan.confirm === "click" || (plan.confirm === "acknowledge" && ack) || (plan.confirm === "typed" && typed.trim().toUpperCase() === "CONFIRM");
  const n = plan.steps.length;

  return (
    <section aria-label="Prepared changes" className={cn("overflow-hidden rounded-[var(--radius-lg)] border bg-surface", pending ? "border-accent/40 shadow-sm" : "border-border")}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="clipboard" className="size-4 text-accent" /> {n === 1 ? "1 change" : `${n} changes`} {plan.status === "pending" ? "prepared" : ""}
        </p>
        <span className="flex items-center gap-2">
          {busy === "approve" ? <Badge tone="accent">Running…</Badge> : <Badge tone={status.tone}>{status.label}</Badge>}
          {plan.mode === "auto" ? <Badge>By policy</Badge> : null}
        </span>
      </header>

      <ol className="divide-y divide-border">
        {plan.steps.map((s, i) => (
          <li key={s.id} className="px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium"><span className="mr-1.5 text-faint">{i + 1}.</span><span>{s.title}</span></p>
                {s.details.length ? (
                  <ul className="mt-1 space-y-0.5 text-[13px] text-muted">{s.details.map((d, k) => <li key={k} className="break-words">{d}</li>)}</ul>
                ) : null}
                {s.effects.length ? (
                  <ul className="mt-1.5 space-y-0.5 text-[12px] text-faint">{s.effects.map((e, k) => <li key={k} className="flex gap-1.5"><span aria-hidden>→</span><span>{e}</span></li>)}</ul>
                ) : null}
              </div>
              <span className="flex shrink-0 flex-col items-end gap-1.5">
                <Badge tone={RISK_TONE[s.riskClass] ?? "neutral"}>{s.riskLabel}</Badge>
                {pending && s.editable.length && editing !== s.id ? (
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setEditing(s.id); setError(null); }} disabled={!!busy} aria-label={`Edit step ${i + 1}`}>Edit</Button>
                ) : null}
              </span>
            </div>
            {s.draft && editing !== s.id ? (
              <figure className="mt-2 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5">
                <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Draft{s.draft.title ? "" : " text"}</figcaption>
                {s.draft.title ? <p className="text-sm font-semibold">{s.draft.title}</p> : null}
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{s.draft.body}</p>
              </figure>
            ) : null}
            {editing === s.id ? (
              <StepEditor s={s} busy={busy === "edit"} error={error?.message ?? null} field={error?.field ?? null}
                onCancel={() => { setEditing(null); setError(null); }}
                onSave={async (edits) => { if (await run("edit", () => revisePlanStepAction({ orgSlug, planId: plan.id, stepId: s.id, edits }))) setEditing(null); }} />
            ) : null}
            <StepResultLine s={s} />
          </li>
        ))}
      </ol>

      {pending ? (
        <footer className="space-y-3 border-t border-border bg-subtle/50 px-3 py-3">
          {error && !editing ? <FormAlert>{error.message}</FormAlert> : null}
          {plan.confirm === "acknowledge" ? (
            <label htmlFor={ackId} className="flex items-start gap-2 text-[13px]">
              <input id={ackId} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
              <span>I understand this has a bigger impact and may be hard to undo.</span>
            </label>
          ) : null}
          {plan.confirm === "typed" ? (
            <div className="space-y-1">
              <label htmlFor={typedId} className="block text-[13px]">Type <strong>CONFIRM</strong> to approve. This can&apos;t be undone.</label>
              <Input id={typedId} value={typed} onChange={(e) => setTyped(e.target.value)} className="max-w-40" autoComplete="off" />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!!busy || !ready || !!editing}
              onClick={() => run("approve", () => approvePlanAction({ orgSlug, planId: plan.id, acknowledge: ack, typed }))}>
              <Icon name="check" /> {busy === "approve" ? "Running…" : n === 1 ? "Approve" : `Approve all ${n}`}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => run("reject", () => rejectPlanAction({ orgSlug, planId: plan.id }))}>
              {busy === "reject" ? "Cancelling…" : "Cancel plan"}
            </Button>
            <span className="text-[11px] text-faint">Nothing changes until you approve · {untilText(plan.expiresAt)}</span>
          </div>
        </footer>
      ) : plan.status === "pending" ? (
        <footer className="border-t border-border px-3 py-2 text-[12px] text-faint">Only the person who asked can approve this.</footer>
      ) : error ? (
        <footer className="border-t border-border px-3 py-2"><FormAlert>{error.message}</FormAlert></footer>
      ) : plan.decidedBy && plan.decidedAt ? (
        <footer className="border-t border-border px-3 py-2 text-[12px] text-faint">
          {plan.status === "rejected" ? "Cancelled" : "Approved"} by {plan.decidedBy} · {new Date(plan.decidedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
        </footer>
      ) : null}
    </section>
  );
}
