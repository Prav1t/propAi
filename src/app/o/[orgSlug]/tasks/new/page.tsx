import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { listTaskAssignees, RECURRENCES } from "@/server/modules/tasks/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createTaskAction } from "../../ops-actions";

export const metadata = { title: "New task" };

export default async function NewTaskPage({ params, searchParams }: PageProps<"/o/[orgSlug]/tasks/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("task.manage")) notFound();
  const props = await listPropertyOptions(ctx);
  // assignee choices depend on the property; pick it first via ?property=
  const propertyId = sp(q.property) && props.some((p) => p.id === sp(q.property)) ? sp(q.property)! : props.length === 1 ? props[0].id : "";
  const assignees = propertyId || principal.role.scopeLevel === "org" ? await listTaskAssignees(ctx, propertyId || null) : [];
  return (
    <>
      <Breadcrumbs items={[{ label: "Tasks", href: `/o/${orgSlug}/tasks` }, { label: "New" }]} />
      <PageHeader title="New task" description={`Due times are in ${principal.orgTimezone}.`} />
      <Panel className="max-w-2xl p-4 sm:p-6">
        <form className="mb-4 flex items-end gap-2" action={`/o/${orgSlug}/tasks/new`}>
          <label className="flex-1 text-[13px] font-medium">Property
            <select name="property" defaultValue={propertyId} className="mt-1.5 block h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 text-sm">
              {principal.role.scopeLevel === "org" ? <option value="">Organization-wide</option> : <option value="">Choose…</option>}
              {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button className="h-9 rounded-[var(--radius-md)] border border-border-strong px-3 text-[13px] hover:bg-subtle">Use property</button>
        </form>
        <SchemaForm action={createTaskAction.bind(null, orgSlug)} columns={2} submitLabel="Create task" hidden={{ propertyId }} fields={[
          { name: "title", label: "Title", span: 2, autoFocus: true },
          { name: "description", label: "Description", type: "textarea", span: 2 },
          { name: "priority", label: "Priority", type: "select", defaultValue: "normal", options: [{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }] },
          { name: "dueAt", label: "Due", type: "datetime-local" },
          { name: "assignedMembershipId", label: "Assignee", type: "select", options: [{ value: "", label: "Unassigned" }, ...assignees.map((a) => ({ value: a.membershipId, label: `${a.name} · ${a.role}` }))] },
          { name: "recurrence", label: "Repeats", type: "select", defaultValue: "none", options: RECURRENCES.map((r) => ({ value: r, label: r === "none" ? "Does not repeat" : r[0].toUpperCase() + r.slice(1) })) },
          { name: "checklist", label: "Checklist (one item per line)", type: "textarea", span: 2 },
        ]} />
      </Panel>
    </>
  );
}
