"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Button, SubmitButton } from "@/components/ui/button";
import { FormAlert, Input, Select } from "@/components/ui/form";

type Act = (s: ActionState, fd: FormData) => Promise<ActionState>;
type Secret = { secret: string; label: string; href?: string };

// shown once, right after creation: the only time the full key / secret leaves the server
export function SecretReveal({ s }: { s: Secret }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-soft/50 p-3">
      <p className="text-[13px] font-medium">{s.label} — copy it now. It won&apos;t be shown again.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid="revealed-secret" className="break-all rounded bg-surface px-2 py-1 font-mono text-[12px]">{s.secret}</code>
        <Button type="button" size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(s.secret).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      {s.href ? <p className="text-[13px]"><Link className="text-accent underline" href={s.href}>Open the endpoint</Link> to send a test event.</p> : null}
    </div>
  );
}

const fieldErr = (st: ActionState, k: string) => st.fieldErrors?.[k] ? <p className="mt-1 text-[13px] text-danger">{st.fieldErrors[k]}</p> : null;
const label = "block text-[13px] font-medium";

export function CreateKeyForm({ action, scopes, properties, requireProperties }: {
  action: Act; scopes: { perm: string; label: string; access: string }[]; properties: { id: string; name: string }[]; requireProperties: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const secret = state.ok ? (state.data as Secret | undefined) : undefined;
  return (
    <form action={formAction} key={secret?.secret ?? "new"} className="space-y-4">
      <FormAlert>{state.error}</FormAlert>
      {secret ? <SecretReveal s={secret} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label htmlFor="key-name" className={label}>Name</label><Input id="key-name" name="name" className="mt-1" placeholder="Accounting sync" maxLength={80} defaultValue={state.ok ? "" : state.values?.name} />{fieldErr(state, "name")}</div>
        <div><label htmlFor="key-exp" className={label}>Expires</label>
          <Select id="key-exp" name="expiresInDays" className="mt-1" defaultValue={state.ok ? "" : state.values?.expiresInDays ?? ""}>
            <option value="">Never (revoke it when it&apos;s no longer needed)</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option>
          </Select></div>
      </div>
      <fieldset>
        <legend className={label}>What the key may do</legend>
        <p className="text-[12px] text-faint">Only permissions you have yourself are listed. The key keeps working only while you keep them.</p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {scopes.map((s) => (
            <label key={s.perm} className="flex items-start gap-2 text-sm"><input type="checkbox" name="scopes" value={s.perm} defaultChecked={s.access === "read" && s.perm !== "resident.read"} className="mt-0.5 size-4 accent-[var(--color-accent)]" /><span>{s.label} <span className="text-faint">({s.access})</span></span></label>
          ))}
        </div>
        {fieldErr(state, "scopes")}
      </fieldset>
      {properties.length ? (
        <fieldset>
          <legend className={label}>Properties {requireProperties ? "" : <span className="font-normal text-faint">(optional — leave all unticked for every property you can reach)</span>}</legend>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
            {properties.map((p) => <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="propertyIds" value={p.id} className="size-4 accent-[var(--color-accent)]" />{p.name}</label>)}
          </div>
          {fieldErr(state, "propertyIds")}
        </fieldset>
      ) : null}
      <SubmitButton pendingLabel="Creating…">Create API key</SubmitButton>
    </form>
  );
}

export function EndpointForm({ action, events, initial, submitLabel }: {
  action: Act; events: { type: string; description: string }[]; initial?: { url: string; description: string | null; events: string[] }; submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const secret = state.ok ? (state.data as Secret | undefined) : undefined;
  return (
    <form action={formAction} key={secret?.secret ?? "form"} className="space-y-4">
      <FormAlert>{state.error}</FormAlert>
      {state.ok && !secret ? <FormAlert kind="success">{state.message}</FormAlert> : null}
      {secret ? <SecretReveal s={secret} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label htmlFor="wh-url" className={label}>Endpoint URL</label><Input id="wh-url" name="url" type="url" className="mt-1" placeholder="https://example.com/webhooks/buildings" defaultValue={secret ? "" : state.values?.url ?? initial?.url} />{fieldErr(state, "url")}</div>
        <div><label htmlFor="wh-desc" className={label}>Description <span className="font-normal text-faint">(optional)</span></label><Input id="wh-desc" name="description" className="mt-1" maxLength={200} defaultValue={secret ? "" : state.values?.description ?? initial?.description ?? ""} /></div>
      </div>
      <fieldset>
        <legend className={label}>Events</legend>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {events.map((e) => (
            <label key={e.type} className="flex items-start gap-2 text-sm"><input type="checkbox" name="events" value={e.type} defaultChecked={initial ? initial.events.includes(e.type) : e.type.startsWith("work_order.")} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
              <span><code className="font-mono text-[12px]">{e.type}</code><span className="block text-[12px] text-faint">{e.description}</span></span></label>
          ))}
        </div>
        {fieldErr(state, "events")}
      </fieldset>
      <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}

// a button whose success may hand back a secret (rotate) or a message (test, replay)
export function DevButton({ action, label, variant = "secondary", pendingLabel }: { action: Act; label: string; variant?: "primary" | "secondary" | "ghost" | "danger"; pendingLabel?: string }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const secret = state.ok ? (state.data as Secret | undefined) : undefined;
  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton size="sm" variant={variant} pendingLabel={pendingLabel ?? "Working…"}>{label}</SubmitButton>
      <FormAlert>{state.error}</FormAlert>
      {state.ok && !secret ? <FormAlert kind="success">{state.message}</FormAlert> : null}
      {secret ? <SecretReveal s={secret} /> : null}
    </form>
  );
}

// a <details> whose open state belongs to the person, not the server: a refresh after creating something (which can
// change the default) must not close the panel showing a one-time secret
export function Disclosure({ summary, defaultOpen, children }: { summary: string; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="border-t border-border p-4" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm font-medium text-accent">{summary}</summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
