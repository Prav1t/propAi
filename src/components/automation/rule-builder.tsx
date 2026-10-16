"use client";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Button, SubmitButton } from "@/components/ui/button";
import { FormAlert, Input, Select } from "@/components/ui/form";
import {
  ACTIONS, AUTOMATION_VARIABLES, OPS, REPORT_LABEL, TRIGGERS, TRIGGER_TYPES, WEEKDAYS, actionsFor, describeWorkflow, fieldsFor, workflowSchema,
  type ActionType, type Condition, type NameBook, type Recipients, type TriggerType, type WorkflowAction, type WorkflowInput,
} from "@/lib/automation";
import { PRIORITY, WO_STATUS } from "@/lib/ops-labels";
import { cn } from "@/lib/cn";

export type BuilderOptions = {
  properties: { id: string; name: string }[]; orgWide: boolean;
  buildings: { id: string; name: string; propertyId: string }[];
  members: { id: string; name: string; role: string; propertyIds: string[] | null }[];
  vendors: { id: string; name: string; propertyIds: string[] }[];
  roles: { key: string; name: string }[];
};
type DryRunResult = { matched: boolean; reason?: string; subjectLabel: string | null; steps: { label: string; outcome: string; afterApproval: boolean }[] };

const card = "rounded-[var(--radius-lg)] border border-border bg-surface";
const small = "h-8 text-[13px]";
const label = "block text-[12px] font-medium text-muted";
const noRecipients: Recipients = { roles: [], members: [], onCall: false, submitter: false, assignee: false };

function defaultAction(t: ActionType, opts: BuilderOptions): WorkflowAction {
  switch (t) {
    case "set_priority": return { type: t, priority: "urgent" };
    case "set_status": return { type: t, status: "acknowledged" };
    case "assign": return { type: t, target: "on_call" };
    case "escalate": return { type: t };
    case "notify": return { type: t, to: { ...noRecipients, roles: opts.roles.some((r) => r.key === "property_manager") ? ["property_manager"] : [] }, title: "{{ref}}: {{title}}", message: "" };
    case "create_task": return { type: t, title: "Follow up on {{ref}}", details: "", assignTo: "nobody", dueInMinutes: 240, priority: "normal" };
    case "draft_announcement": return { type: t, title: "Update: {{title}}", body: "We're aware of the issue at {{property}} and are working on it.", audience: "residents" };
    case "request_approval": return { type: t, role: opts.roles.some((r) => r.key === "property_manager") ? "property_manager" : opts.roles[0]?.key ?? "", note: "" };
    case "assistant_draft": return { type: t, instruction: "" };
    case "send_report": return { type: t, report: "maintenance", period: "7d", to: { ...noRecipients, roles: ["property_manager"] } };
  }
}

const MINUTE_UNITS = [{ v: 1, l: "minutes" }, { v: 60, l: "hours" }, { v: 1440, l: "days" }];

export function RuleBuilder({ orgSlug, action, initial, initialEnabled, options, dryRun, candidates }: {
  orgSlug: string;
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  initial: WorkflowInput; initialEnabled: boolean; options: BuilderOptions;
  dryRun: (slug: string, ruleJson: string, eventId: string | null) => Promise<{ ok: true; result: DryRunResult } | { ok: false; error: string }>;
  candidates: (slug: string, trigger: string, propertyId: string | null) => Promise<{ ok: true; events: { id: string; label: string; at: string }[] } | { ok: false; error: string }>;
}) {
  const [rule, setRule] = useState<WorkflowInput>(initial);
  const [state, formAction] = useActionState(action, initialActionState);
  const [clientError, setClientError] = useState<string | null>(null);
  const set = (patch: Partial<WorkflowInput>) => setRule((r) => ({ ...r, ...patch }));

  const names: NameBook = useMemo(() => ({
    buildings: Object.fromEntries(options.buildings.map((b) => [b.id, b.name])), members: Object.fromEntries(options.members.map((m) => [m.id, m.name])),
    vendors: Object.fromEntries(options.vendors.map((v) => [v.id, v.name])), roles: Object.fromEntries(options.roles.map((r) => [r.key, r.name])),
    properties: Object.fromEntries(options.properties.map((p) => [p.id, p.name])),
  }), [options]);
  const summary = describeWorkflow(rule, names);
  const fields = fieldsFor(rule.trigger);
  const allowed = actionsFor(rule.trigger);
  const buildings = options.buildings.filter((b) => b.propertyId === rule.propertyId);
  const members = options.members.filter((m) => !rule.propertyId || m.propertyIds === null || m.propertyIds.includes(rule.propertyId));
  const vendors = options.vendors.filter((v) => !rule.propertyId || v.propertyIds.includes(rule.propertyId));

  const changeTrigger = (t: TriggerType) => {
    const ok = actionsFor(t);
    setRule((r) => ({
      ...r, trigger: t, schedule: t === "schedule" ? r.schedule ?? { frequency: "weekly", time: "08:00", weekday: 1 } : null,
      conditions: r.conditions.filter((c) => fieldsFor(t).some((f) => f.key === c.field)), actions: r.actions.filter((a) => ok.includes(a.type)),
    }));
  };
  const setCond = (i: number, c: Condition | null) => set({ conditions: c ? rule.conditions.map((x, j) => (j === i ? c : x)) : rule.conditions.filter((_, j) => j !== i) });
  const setAct = (i: number, a: WorkflowAction | null) => set({ actions: a ? rule.actions.map((x, j) => (j === i ? a : x)) : rule.actions.filter((_, j) => j !== i) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rule.actions.length) return;
    const next = [...rule.actions];
    [next[i], next[j]] = [next[j], next[i]];
    set({ actions: next });
  };

  const ruleJson = JSON.stringify(rule);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const r = workflowSchema.safeParse(rule);
    if (!r.success) { e.preventDefault(); setClientError(r.error.issues[0]?.message ?? "Check the rule."); return; }
    setClientError(null);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <form action={formAction} onSubmit={onSubmit} className="space-y-5" aria-label="Automation rule">
        <input type="hidden" name="rule" value={ruleJson} />
        <FormAlert>{clientError ?? state.error}</FormAlert>

        <section className={cn(card, "space-y-3 p-4")}>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="rb-name" className={label}>Name</label>
              <Input id="rb-name" value={rule.name} onChange={(e) => set({ name: e.target.value })} className="mt-1" maxLength={120} required />
            </div>
            <div>
              <label htmlFor="rb-property" className={label}>Property</label>
              <Select id="rb-property" className="mt-1" value={rule.propertyId ?? ""} onChange={(e) => set({ propertyId: e.target.value || null, conditions: rule.conditions.filter((c) => c.field !== "building") })}>
                {options.orgWide ? <option value="">Every property</option> : <option value="" disabled>Choose a property</option>}
                {options.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>
          </div>
        </section>

        <section className={cn(card, "p-4")} aria-labelledby="rb-when">
          <h2 id="rb-when" className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-faint">When</h2>
          <label htmlFor="rb-trigger" className="sr-only">Trigger</label>
          <Select id="rb-trigger" value={rule.trigger} onChange={(e) => changeTrigger(e.target.value as TriggerType)}>
            {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{TRIGGERS[t].label}</option>)}
          </Select>
          {rule.trigger === "schedule" && rule.schedule ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="rb-freq" className={label}>Repeats</label>
                <Select id="rb-freq" className={cn("mt-1 w-40!", small)} value={rule.schedule.frequency} onChange={(e) => set({ schedule: { ...rule.schedule!, frequency: e.target.value as "daily", weekday: e.target.value === "weekly" ? rule.schedule!.weekday ?? 1 : undefined, dayOfMonth: e.target.value === "monthly" ? rule.schedule!.dayOfMonth ?? 1 : undefined } })}>
                  <option value="daily">Every day</option><option value="weekdays">Every weekday</option><option value="weekly">Every week</option><option value="monthly">Every month</option>
                </Select>
              </div>
              {rule.schedule.frequency === "weekly" ? (
                <div>
                  <label htmlFor="rb-dow" className={label}>On</label>
                  <Select id="rb-dow" className={cn("mt-1 w-36!", small)} value={rule.schedule.weekday ?? 1} onChange={(e) => set({ schedule: { ...rule.schedule!, weekday: Number(e.target.value) } })}>
                    {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </Select>
                </div>
              ) : null}
              {rule.schedule.frequency === "monthly" ? (
                <div>
                  <label htmlFor="rb-dom" className={label}>Day of the month</label>
                  <Input id="rb-dom" type="number" min={1} max={28} className={cn("mt-1 w-24!", small)} value={rule.schedule.dayOfMonth ?? 1} onChange={(e) => set({ schedule: { ...rule.schedule!, dayOfMonth: Number(e.target.value) } })} />
                </div>
              ) : null}
              <div>
                <label htmlFor="rb-time" className={label}>At (your organization&apos;s time)</label>
                <Input id="rb-time" type="time" className={cn("mt-1 w-32!", small)} value={rule.schedule.time} onChange={(e) => set({ schedule: { ...rule.schedule!, time: e.target.value } })} />
              </div>
            </div>
          ) : null}
        </section>

        {fields.length ? (
          <section className={cn(card, "p-4")} aria-labelledby="rb-if">
            <h2 id="rb-if" className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-faint">If <span className="font-normal normal-case tracking-normal">— all of these are true (leave empty to always run)</span></h2>
            <ul className="space-y-2">
              {rule.conditions.map((c, i) => {
                const def = fields.find((f) => f.key === c.field) ?? fields[0];
                const opts = def.type === "building" ? Object.fromEntries(buildings.map((b) => [b.id, b.name])) : def.options ?? {};
                const list = Array.isArray(c.value) ? c.value : c.value !== undefined && c.value !== "" ? [String(c.value)] : [];
                return (
                  <li key={i} className="flex flex-wrap items-start gap-2 rounded-[var(--radius-md)] bg-subtle/60 p-2">
                    <label className="sr-only" htmlFor={`rb-cf-${i}`}>Condition {i + 1} field</label>
                    <Select id={`rb-cf-${i}`} className={cn("w-44!", small)} value={c.field} onChange={(e) => {
                      const nd = fields.find((f) => f.key === e.target.value)!;
                      setCond(i, { field: nd.key, op: OPS[nd.type][0].value as Condition["op"], value: nd.type === "rank" ? nd.ranks![2] : nd.type === "number" ? 1 : nd.type === "text" ? "" : nd.type === "bool" ? undefined : [] });
                    }}>
                      {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </Select>
                    <label className="sr-only" htmlFor={`rb-co-${i}`}>Condition {i + 1} comparison</label>
                    <Select id={`rb-co-${i}`} className={cn("w-36!", small)} value={c.op} onChange={(e) => {
                      const op = e.target.value as Condition["op"];
                      setCond(i, { ...c, op, value: def.type === "rank" ? (op === "at_least" ? (list[0] ?? def.ranks![2]) : list) : c.value });
                    }}>
                      {OPS[def.type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                    {def.type === "text" ? <><label className="sr-only" htmlFor={`rb-cv-${i}`}>Text to look for</label><Input id={`rb-cv-${i}`} className={cn("w-48!", small)} value={String(c.value ?? "")} onChange={(e) => setCond(i, { ...c, value: e.target.value })} /></> : null}
                    {def.type === "number" ? <><label className="sr-only" htmlFor={`rb-cv-${i}`}>Number</label><Input id={`rb-cv-${i}`} type="number" min={0} className={cn("w-24!", small)} value={Number(c.value ?? 0)} onChange={(e) => setCond(i, { ...c, value: Number(e.target.value) })} /></> : null}
                    {def.type === "rank" && c.op === "at_least" ? (
                      <><label className="sr-only" htmlFor={`rb-cv-${i}`}>Level</label>
                        <Select id={`rb-cv-${i}`} className={cn("w-32!", small)} value={String(c.value ?? "")} onChange={(e) => setCond(i, { ...c, value: e.target.value })}>
                          {def.ranks!.map((r) => <option key={r} value={r}>{def.options?.[r] ?? r}</option>)}
                        </Select></>
                    ) : null}
                    {(def.type === "enum" || def.type === "building" || (def.type === "rank" && c.op === "is")) ? (
                      <fieldset className="flex min-w-0 flex-1 flex-wrap gap-1">
                        <legend className="sr-only">{def.label} values</legend>
                        {Object.keys(opts).length === 0 ? <span className="text-[12px] text-faint">{def.type === "building" ? "Pick a property first." : "No options."}</span> : null}
                        {Object.entries(opts).map(([v, l]) => {
                          const on = list.includes(v);
                          return (
                            <label key={v} className={cn("cursor-pointer select-none rounded-full border px-2 py-0.5 text-[12px]", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-border-strong")}>
                              <input type="checkbox" className="sr-only" checked={on} onChange={() => setCond(i, { ...c, value: on ? list.filter((x) => x !== v) : [...list, v] })} />{l}
                            </label>
                          );
                        })}
                      </fieldset>
                    ) : null}
                    <Button type="button" size="sm" variant="ghost" aria-label={`Remove condition ${i + 1}`} onClick={() => setCond(i, null)}>Remove</Button>
                  </li>
                );
              })}
            </ul>
            {rule.conditions.length < 10 ? (
              <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => {
                const f = fields[0];
                set({ conditions: [...rule.conditions, { field: f.key, op: OPS[f.type][0].value as Condition["op"], value: f.type === "bool" ? undefined : f.type === "rank" ? f.ranks![2] : [] }] });
              }}>Add condition</Button>
            ) : null}
          </section>
        ) : null}

        <section className={cn(card, "p-4")} aria-labelledby="rb-then">
          <h2 id="rb-then" className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-faint">Then <span className="font-normal normal-case tracking-normal">— in this order</span></h2>
          <ol className="space-y-3">
            {rule.actions.map((a, i) => (
              <li key={i} className="rounded-[var(--radius-md)] border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold tabular-nums text-faint">{i + 1}</span>
                  <label className="sr-only" htmlFor={`rb-at-${i}`}>Step {i + 1} action</label>
                  <Select id={`rb-at-${i}`} className={cn("w-56!", small)} value={a.type} onChange={(e) => setAct(i, defaultAction(e.target.value as ActionType, options))}>
                    {allowed.map((t) => <option key={t} value={t}>{ACTIONS[t].label}</option>)}
                  </Select>
                  <span className="ml-auto flex gap-1">
                    <Button type="button" size="sm" variant="ghost" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`Move step ${i + 1} down`} disabled={i === rule.actions.length - 1} onClick={() => move(i, 1)}>↓</Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => setAct(i, null)}>Remove</Button>
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-faint">{ACTIONS[a.type].help}</p>
                <div className="mt-2"><ActionFields a={a} i={i} onChange={(x) => setAct(i, x)} options={options} members={members} vendors={vendors} /></div>
              </li>
            ))}
          </ol>
          <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => set({ actions: [...rule.actions, defaultAction(allowed.includes("notify") ? "notify" : allowed[0], options)] })}>Add step</Button>
          <p className="mt-3 text-[12px] text-faint">Text can use {Object.keys(AUTOMATION_VARIABLES).map((v) => `{{${v}}}`).join(" ")}.</p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="enable" defaultChecked={initialEnabled} className="h-4 w-4! accent-[var(--color-accent)]" /> Turn on when saved
          </label>
          <SubmitButton pendingLabel="Saving…">Save rule</SubmitButton>
          <a href={`/o/${orgSlug}/automations`} className="text-[13px] text-muted hover:text-fg">Cancel</a>
        </div>
        <p className="text-[12px] text-faint">The rule acts with your permissions while you&apos;re its owner. Saving or turning it on makes you the owner.</p>
      </form>

      <aside className="space-y-4">
        <section className={cn(card, "p-4")} aria-labelledby="rb-summary">
          <h2 id="rb-summary" className="text-[13px] font-semibold">In plain words</h2>
          <p className="mt-2 text-[13px]">{summary.when}{summary.conditions.length ? `, if ${summary.conditions.join(" and ")}` : ""}:</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] text-muted">{summary.actions.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </section>
        <DryRunPanel key={`${rule.trigger}:${rule.propertyId ?? ""}`} orgSlug={orgSlug} ruleJson={ruleJson} trigger={rule.trigger} propertyId={rule.propertyId} dryRun={dryRun} candidates={candidates} />
      </aside>
    </div>
  );
}

function RecipientFields({ r, onChange, options, members, idp }: { r: Recipients; onChange: (r: Recipients) => void; options: BuilderOptions; members: BuilderOptions["members"]; idp: string }) {
  const toggle = <K extends "roles" | "members">(k: K, v: string) => onChange({ ...r, [k]: r[k].includes(v) ? r[k].filter((x) => x !== v) : [...r[k], v] });
  return (
    <fieldset className="space-y-2">
      <legend className={label}>Who</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.onCall} onChange={(e) => onChange({ ...r, onCall: e.target.checked })} /> Whoever is on call</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.submitter} onChange={(e) => onChange({ ...r, submitter: e.target.checked })} /> The person who reported it</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.assignee} onChange={(e) => onChange({ ...r, assignee: e.target.checked })} /> Whoever is assigned</label>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Everyone with these roles">
        <span className="mr-1 text-[12px] text-faint">Everyone with the role:</span>
        {options.roles.map((role) => {
          const on = r.roles.includes(role.key);
          return <label key={role.key} className={cn("cursor-pointer rounded-full border px-2 py-0.5 text-[12px]", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-border-strong")}><input type="checkbox" className="sr-only" checked={on} onChange={() => toggle("roles", role.key)} />{role.name}</label>;
        })}
      </div>
      <div>
        <label htmlFor={`${idp}-m`} className="sr-only">Add a person</label>
        <Select id={`${idp}-m`} className={cn("w-64!", small)} value="" onChange={(e) => e.target.value && toggle("members", e.target.value)}>
          <option value="">Add a person…</option>
          {members.filter((m) => !r.members.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
        </Select>
        {r.members.length ? <ul className="mt-1 flex flex-wrap gap-1">{r.members.map((id) => (
          <li key={id}><button type="button" className="rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-[12px] text-accent" onClick={() => toggle("members", id)} aria-label={`Remove ${options.members.find((m) => m.id === id)?.name ?? "person"}`}>{options.members.find((m) => m.id === id)?.name ?? "Removed person"} ×</button></li>
        ))}</ul> : null}
      </div>
    </fieldset>
  );
}

function ActionFields({ a, i, onChange, options, members, vendors }: { a: WorkflowAction; i: number; onChange: (a: WorkflowAction) => void; options: BuilderOptions; members: BuilderOptions["members"]; vendors: BuilderOptions["vendors"] }) {
  const id = (k: string) => `rb-a${i}-${k}`;
  switch (a.type) {
    case "set_priority":
      return <><label htmlFor={id("p")} className="sr-only">Priority</label><Select id={id("p")} className={cn("w-40!", small)} value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value as "urgent" })}>{["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}</Select></>;
    case "set_status":
      return <><label htmlFor={id("s")} className="sr-only">Status</label><Select id={id("s")} className={cn("w-48!", small)} value={a.status} onChange={(e) => onChange({ ...a, status: e.target.value as "acknowledged" })}>{["acknowledged", "in_progress", "awaiting_vendor", "awaiting_resident"].map((s) => <option key={s} value={s}>{WO_STATUS[s].label}</option>)}</Select></>;
    case "assign":
      return (
        <div className="flex flex-wrap gap-2">
          <label htmlFor={id("t")} className="sr-only">Assign to</label>
          <Select id={id("t")} className={cn("w-44!", small)} value={a.target} onChange={(e) => onChange({ type: "assign", target: e.target.value as "member" })}>
            <option value="on_call">Whoever is on call</option><option value="member">A staff member</option><option value="vendor">A vendor</option>
          </Select>
          {a.target === "member" ? <><label htmlFor={id("m")} className="sr-only">Staff member</label><Select id={id("m")} className={cn("w-56!", small)} value={a.membershipId ?? ""} onChange={(e) => onChange({ ...a, membershipId: e.target.value || undefined })}><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}</Select></> : null}
          {a.target === "vendor" ? <><label htmlFor={id("v")} className="sr-only">Vendor</label><Select id={id("v")} className={cn("w-56!", small)} value={a.vendorId ?? ""} onChange={(e) => onChange({ ...a, vendorId: e.target.value || undefined })}><option value="">Choose…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></> : null}
        </div>
      );
    case "escalate":
    case "assistant_draft":
      return a.type === "assistant_draft" ? <><label htmlFor={id("i")} className={label}>Instruction (optional)</label><Input id={id("i")} className={cn("mt-1", small)} value={a.instruction} maxLength={500} onChange={(e) => onChange({ ...a, instruction: e.target.value })} /></> : null;
    case "notify":
      return (
        <div className="space-y-2">
          <RecipientFields r={a.to} onChange={(to) => onChange({ ...a, to })} options={options} members={members} idp={id("r")} />
          <div><label htmlFor={id("ti")} className={label}>Title</label><Input id={id("ti")} className={cn("mt-1", small)} value={a.title} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value })} /></div>
          <div><label htmlFor={id("me")} className={label}>Message (optional)</label><textarea id={id("me")} rows={2} maxLength={1000} className="mt-1 block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-1.5 text-[13px]" value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} /></div>
        </div>
      );
    case "create_task": {
      const unit = a.dueInMinutes % 1440 === 0 ? 1440 : a.dueInMinutes % 60 === 0 ? 60 : 1;
      return (
        <div className="space-y-2">
          <div><label htmlFor={id("ti")} className={label}>Task title</label><Input id={id("ti")} className={cn("mt-1", small)} value={a.title} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value })} /></div>
          <div className="flex flex-wrap items-end gap-2">
            <div><label htmlFor={id("as")} className={label}>For</label>
              <Select id={id("as")} className={cn("mt-1 w-44!", small)} value={a.assignTo} onChange={(e) => onChange({ ...a, assignTo: e.target.value as "nobody", membershipId: undefined })}>
                <option value="nobody">Nobody yet</option><option value="on_call">Whoever is on call</option><option value="member">A staff member</option>
              </Select></div>
            {a.assignTo === "member" ? <div><label htmlFor={id("m")} className={label}>Person</label><Select id={id("m")} className={cn("mt-1 w-52!", small)} value={a.membershipId ?? ""} onChange={(e) => onChange({ ...a, membershipId: e.target.value || undefined })}><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></div> : null}
            <div><label htmlFor={id("du")} className={label}>Due after</label>
              <span className="mt-1 flex gap-1">
                <Input id={id("du")} type="number" min={1} className={cn("w-20!", small)} value={a.dueInMinutes / unit} onChange={(e) => onChange({ ...a, dueInMinutes: Math.max(5, Number(e.target.value) * unit) })} />
                <Select aria-label="Unit" className={cn("w-28!", small)} value={unit} onChange={(e) => onChange({ ...a, dueInMinutes: Math.max(5, (a.dueInMinutes / unit) * Number(e.target.value)) })}>{MINUTE_UNITS.map((u) => <option key={u.v} value={u.v}>{u.l}</option>)}</Select>
              </span></div>
            <div><label htmlFor={id("pr")} className={label}>Priority</label><Select id={id("pr")} className={cn("mt-1 w-28!", small)} value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value as "normal" })}>{["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}</Select></div>
          </div>
        </div>
      );
    }
    case "draft_announcement":
      return (
        <div className="space-y-2">
          <div><label htmlFor={id("ti")} className={label}>Title</label><Input id={id("ti")} className={cn("mt-1", small)} value={a.title} maxLength={140} onChange={(e) => onChange({ ...a, title: e.target.value })} /></div>
          <div><label htmlFor={id("bo")} className={label}>Text</label><textarea id={id("bo")} rows={3} maxLength={5000} className="mt-1 block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-1.5 text-[13px]" value={a.body} onChange={(e) => onChange({ ...a, body: e.target.value })} /></div>
          <div><label htmlFor={id("au")} className={label}>For</label><Select id={id("au")} className={cn("mt-1 w-48!", small)} value={a.audience} onChange={(e) => onChange({ ...a, audience: e.target.value as "residents" })}><option value="residents">Residents</option><option value="everyone">Residents and staff</option><option value="staff">Staff</option></Select></div>
        </div>
      );
    case "request_approval":
      return (
        <div className="flex flex-wrap items-end gap-2">
          <div><label htmlFor={id("ro")} className={label}>Approved by a</label><Select id={id("ro")} className={cn("mt-1 w-52!", small)} value={a.role} onChange={(e) => onChange({ ...a, role: e.target.value })}>{options.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></div>
          <div className="min-w-56 flex-1"><label htmlFor={id("no")} className={label}>Note for the approver</label><Input id={id("no")} className={cn("mt-1", small)} value={a.note} maxLength={500} onChange={(e) => onChange({ ...a, note: e.target.value })} /></div>
        </div>
      );
    case "send_report":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <div><label htmlFor={id("re")} className={label}>Report</label><Select id={id("re")} className={cn("mt-1 w-52!", small)} value={a.report} onChange={(e) => onChange({ ...a, report: e.target.value as "maintenance" })}>{["maintenance", "sla", "vendors", "complaints", "incidents", "workload", "health"].map((r) => <option key={r} value={r}>{REPORT_LABEL[r]}</option>)}</Select></div>
            <div><label htmlFor={id("pe")} className={label}>Covering</label><Select id={id("pe")} className={cn("mt-1 w-36!", small)} value={a.period} onChange={(e) => onChange({ ...a, period: e.target.value as "7d" })}><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></Select></div>
          </div>
          <RecipientFields r={a.to} onChange={(to) => onChange({ ...a, to })} options={options} members={members} idp={id("r")} />
          <p className="text-[12px] text-faint">Each person gets only the numbers their own access allows; people who can&apos;t see reports are skipped.</p>
        </div>
      );
  }
}

function DryRunPanel({ orgSlug, ruleJson, trigger, propertyId, dryRun, candidates }: {
  orgSlug: string; ruleJson: string; trigger: TriggerType; propertyId: string | null;
  dryRun: (slug: string, ruleJson: string, eventId: string | null) => Promise<{ ok: true; result: DryRunResult } | { ok: false; error: string }>;
  candidates: (slug: string, trigger: string, propertyId: string | null) => Promise<{ ok: true; events: { id: string; label: string; at: string }[] } | { ok: false; error: string }>;
}) {
  const [events, setEvents] = useState<{ id: string; label: string; at: string }[] | null>(null);
  const [eventId, setEventId] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // the parent remounts this panel (via key) when the trigger or property changes, so state starts fresh
  useEffect(() => {
    if (trigger === "schedule") return;
    let live = true;
    candidates(orgSlug, trigger, propertyId).then((r) => { if (live) { if (r.ok) { setEvents(r.events); setEventId(r.events[0]?.id ?? ""); } else setError(r.error); } });
    return () => { live = false; };
  }, [orgSlug, trigger, propertyId, candidates]);
  return (
    <section className={cn(card, "p-4")} aria-labelledby="rb-test">
      <h2 id="rb-test" className="text-[13px] font-semibold">Test it</h2>
      <p className="mt-1 text-[12px] text-muted">{trigger === "schedule" ? "See what it would do if it ran now." : "Pick something that happened recently and see what the rule would have done."} Nothing is changed.</p>
      {trigger !== "schedule" ? (
        events === null ? <p className="mt-2 text-[12px] text-faint">Loading recent events…</p> : events.length === 0 ? <p className="mt-2 text-[12px] text-faint">Nothing like this has happened in the last 60 days.</p> : (
          <div className="mt-2">
            <label htmlFor="rb-event" className="sr-only">Past event</label>
            <Select id="rb-event" className={small} value={eventId} onChange={(e) => { setEventId(e.target.value); setResult(null); }}>
              {events.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </Select>
          </div>
        )
      ) : null}
      <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={pending || (trigger !== "schedule" && !eventId)}
        onClick={() => start(async () => { setError(null); const r = await dryRun(orgSlug, ruleJson, trigger === "schedule" ? null : eventId); if (r.ok) setResult(r.result); else { setResult(null); setError(r.error); } })}>
        {pending ? "Testing…" : "Run test"}
      </Button>
      <div aria-live="polite">
        {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
        {result ? (
          <div className="mt-3 text-[13px]">
            {!result.matched ? <p className="text-muted">{result.reason}</p> : (
              <>
                <p className="font-medium">This would have{result.subjectLabel ? ` (for ${result.subjectLabel})` : ""}:</p>
                <ol className="mt-1 list-decimal space-y-1.5 pl-5">
                  {result.steps.map((s, i) => <li key={i}>{s.afterApproval ? <span className="text-faint">After approval: </span> : null}{s.outcome}</li>)}
                </ol>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
