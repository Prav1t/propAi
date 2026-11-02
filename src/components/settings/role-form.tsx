"use client";
import { useActionState, useMemo, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Perm = { key: string; module: string; description: string; held: boolean };
type Template = { id: string; name: string; scopeLevel: string; permissions: string[] };

// a custom role: name, where it applies, and its permissions grouped by area. Permissions the editor doesn't hold
// can't be ticked (the server refuses them too); starting from an existing role copies what the editor may grant.
export function RoleForm({ action, perms, templates, initial, orgWide, members = 0, submitLabel }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>;
  perms: Perm[]; templates: Template[];
  initial?: { name: string; description: string; scopeLevel: string; permissions: string[] };
  orgWide: boolean; // the editor's own access is organization-wide (may define organization-wide roles)
  members?: number; submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial?.permissions ?? []));
  const [scope, setScope] = useState(initial?.scopeLevel ?? "scoped");
  const modules = useMemo(() => [...new Set(perms.map((p) => p.module))], [perms]);
  const err = state.fieldErrors ?? {};
  const toggle = (k: string, on: boolean) => setChosen((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const fromTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setChosen(new Set(t.permissions.filter((k) => perms.find((p) => p.key === k)?.held)));
    if (orgWide || t.scopeLevel === "scoped") setScope(t.scopeLevel === "org" ? "org" : "scoped");
  };
  return (
    <form action={formAction} className="space-y-5">
      <FormAlert>{state.error}</FormAlert>
      {[...chosen].map((k) => <input key={k} type="hidden" name="permissions" value={k} />)}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" error={err.name}>
          {(p) => <Input {...p} defaultValue={state.values?.name ?? initial?.name ?? ""} maxLength={60} placeholder="e.g. Leasing agent" required />}
        </Field>
        {!initial ? (
          <div className="space-y-1.5">
            <label htmlFor="role-template" className="block text-[13px] font-medium">Start from (optional)</label>
            <Select id="role-template" defaultValue="" onChange={(e) => fromTemplate(e.target.value)}>
              <option value="">Nothing ticked</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
        ) : <div />}
        <Field label="Description (optional)" name="description" error={err.description} className="sm:col-span-2">
          {(p) => <Input {...p} defaultValue={state.values?.description ?? initial?.description ?? ""} maxLength={200} placeholder="What people with this role do" />}
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Where it applies</legend>
        {err.scopeLevel ? <p className="text-[13px] text-danger">{err.scopeLevel}</p> : null}
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="scopeLevel" value="scoped" checked={scope === "scoped"} onChange={() => setScope("scoped")} disabled={members > 0 && initial?.scopeLevel !== "scoped"} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
          <span>Properties they&apos;re assigned to<span className="block text-[13px] text-faint">You choose the property when you invite someone with this role.</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="scopeLevel" value="org" checked={scope === "org"} onChange={() => setScope("org")} disabled={!orgWide || (members > 0 && initial?.scopeLevel !== "org")} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
          <span>The whole organization<span className="block text-[13px] text-faint">{orgWide ? "Every property, now and in the future." : "Only people with organization-wide access can define these."}</span></span>
        </label>
        {members > 0 ? <p className="text-[12px] text-faint">{members} {members === 1 ? "person has" : "people have"} this role, so where it applies is fixed. Changes to permissions apply to them right away.</p> : null}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium">Permissions <span className="font-normal text-faint">({chosen.size} chosen)</span></legend>
        {err.permissions ? <p className="text-[13px] text-danger">{err.permissions}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => {
            const list = perms.filter((p) => p.module === m);
            const grantable = list.filter((p) => p.held);
            const all = grantable.length > 0 && grantable.every((p) => chosen.has(p.key));
            return (
              <div key={m} className="rounded-[var(--radius-md)] border border-border p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-faint">{m}</p>
                  {grantable.length > 1 ? (
                    <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => grantable.forEach((p) => toggle(p.key, !all))}>{all ? "Clear" : "All"}</button>
                  ) : null}
                </div>
                <ul className="space-y-2">
                  {list.map((p) => (
                    <li key={p.key}>
                      <label className={`flex items-start gap-2 text-[13px] ${p.held ? "" : "text-faint"}`} title={p.held ? p.key : "You don't have this permission, so you can't give it"}>
                        <input type="checkbox" checked={chosen.has(p.key)} disabled={!p.held} onChange={(e) => toggle(p.key, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" aria-describedby={p.held ? undefined : "perm-not-held"} />
                        <span>{p.description}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <p id="perm-not-held" className="text-[12px] text-faint">Greyed-out permissions are ones you don&apos;t have yourself, so you can&apos;t give them.</p>
      </fieldset>
      <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}
