"use client";
import { useActionState, useState } from "react";
import { changeRoleAction, inviteMemberAction, setMemberStatusAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type RoleOpt = { id: string; name: string; scopeLevel: string; description: string };
type PropOpt = { id: string; name: string };

function RoleAndScope({ roles, properties, defaultRoleId, defaultPropertyId, errors }: {
  roles: RoleOpt[]; properties: PropOpt[]; defaultRoleId?: string; defaultPropertyId?: string; errors?: Record<string, string>;
}) {
  const [roleId, setRoleId] = useState(defaultRoleId ?? "");
  const role = roles.find((r) => r.id === roleId);
  return (
    <>
      <Field label="Role" name="roleId" error={errors?.roleId} hint={role?.description}>
        {(p) => (
          <Select {...p} value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
            <option value="" disabled>Choose a role…</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
      </Field>
      {role?.scopeLevel === "scoped" ? (
        <Field label="Property" name="propertyId" error={errors?.propertyId} hint="This person will only see this property.">
          {(p) => (
            <Select {...p} defaultValue={defaultPropertyId ?? ""} required>
              <option value="" disabled>Choose a property…</option>
              {properties.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
    </>
  );
}

export function InviteForm({ orgSlug, roles, properties }: { orgSlug: string; roles: RoleOpt[]; properties: PropOpt[] }) {
  const [state, action] = useActionState(inviteMemberAction, initialActionState);
  return (
    <form action={action} className="grid gap-4 p-4 sm:max-w-md" noValidate key={state.ok ? state.message : "form"}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Email" name="email" error={state.fieldErrors?.email}>
        {(p) => <Input {...p} type="email" required placeholder="name@company.com" defaultValue={state.ok ? "" : state.values?.email} />}
      </Field>
      <RoleAndScope roles={roles} properties={properties} defaultRoleId={state.ok ? undefined : state.values?.roleId} defaultPropertyId={state.values?.propertyId} errors={state.fieldErrors} />
      <div><SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton></div>
    </form>
  );
}

export function ManageMember({ orgSlug, membershipId, status, roles, properties }: {
  orgSlug: string; membershipId: string; status: string; roles: RoleOpt[]; properties: PropOpt[];
}) {
  const [roleState, roleAction] = useActionState(changeRoleAction, initialActionState);
  const [statusState, statusAction] = useActionState(setMemberStatusAction, initialActionState);
  return (
    <details className="group relative inline-block text-left">
      <summary className="cursor-pointer list-none rounded-[var(--radius-md)] px-2 py-1 text-[13px] text-accent hover:bg-subtle">Manage</summary>
      <div className="absolute right-0 z-20 mt-1 w-72 space-y-4 rounded-[var(--radius-lg)] border border-border bg-surface p-3 shadow-lg">
        <form action={roleAction} className="space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="membershipId" value={membershipId} />
          <FormAlert>{roleState.error}</FormAlert>
          <FormAlert kind="success">{roleState.ok ? roleState.message : null}</FormAlert>
          <RoleAndScope roles={roles} properties={properties} />
          <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Change role</SubmitButton>
        </form>
        <div className="h-px bg-border" />
        <form action={statusAction} className="space-y-2">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="membershipId" value={membershipId} />
          <input type="hidden" name="status" value={status === "active" ? "deactivated" : "active"} />
          <FormAlert>{statusState.error}</FormAlert>
          <SubmitButton size="sm" variant={status === "active" ? "danger" : "secondary"} pendingLabel="Saving…">
            {status === "active" ? "Deactivate access" : "Reactivate access"}
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
