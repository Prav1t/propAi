import { getOrgContext, orNotFound } from "@/server/org-context";
import { getStaff } from "@/server/modules/people/service";
import { Avatar, Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { EMPLOYMENT_LABEL, opts } from "@/lib/labels";
import { updateStaffAction } from "../../portfolio-actions";

export const metadata = { title: "Staff member" };

export default async function StaffMemberPage({ params }: PageProps<"/o/[orgSlug]/staff/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const { staff: s, notes, canEdit } = await orNotFound(getStaff(ctx, id));
  return (
    <>
      <Breadcrumbs items={[{ label: "Staff", href: `/o/${orgSlug}/staff` }, { label: s.name }]} />
      <div className="mb-6 flex items-center gap-3">
        <Avatar name={s.name} className="size-10 text-sm" />
        <PageHeader title={s.name} description={`${s.title ?? s.roleName} · ${s.email}`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Overview" actions={s.status === "active" ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>} />
          <DetailList items={[
            ["Role", s.roleName],
            ["Coverage", s.scopes.length ? s.scopes.join(", ") : "Organization-wide"],
            ["Employment", s.employmentType ? EMPLOYMENT_LABEL[s.employmentType] : null],
            ["Phone", s.phone],
            ["Skills", s.skills.length ? <span className="flex flex-wrap gap-1">{s.skills.map((k) => <Badge key={k}>{k}</Badge>)}</span> : null],
            ["Notes", notes],
          ]} />
        </Panel>
        {canEdit ? (
          <Panel>
            <PanelHeader title="Edit profile" description="Role and access are managed under Organization → Members." />
            <div className="p-4">
              <SchemaForm action={updateStaffAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save profile" fields={[
                { name: "title", label: "Job title", defaultValue: s.title },
                { name: "phone", label: "Phone", type: "tel", defaultValue: s.phone },
                { name: "employmentType", label: "Employment", type: "select", options: opts(EMPLOYMENT_LABEL), defaultValue: s.employmentType ?? "full_time" },
                { name: "skills", label: "Skills", defaultValue: s.skills.join(", "), hint: "Comma-separated, e.g. plumbing, hvac" },
                { name: "notes", label: "Notes", type: "textarea", defaultValue: notes, span: 2 },
              ]} />
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
