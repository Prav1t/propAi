import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listMessageTemplates } from "@/server/modules/messaging/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { TEMPLATE_VARIABLES } from "@/lib/template";
import { createTemplateAction, deleteTemplateAction } from "../../community-actions";

export const metadata = { title: "Message templates" };

export default async function TemplatesPage({ params }: PageProps<"/o/[orgSlug]/messages/templates">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("message.manage")) notFound();
  const rows = await listMessageTemplates(ctx);
  const props = (await listPropertyOptions(ctx)).filter((x) => can(principal, "message.manage", { orgId: principal.orgId, propertyId: x.id }));
  const orgWide = principal.role.scopeLevel === "org";
  return (
    <>
      <Breadcrumbs items={[{ label: "Resident messages", href: `/o/${orgSlug}/messages` }, { label: "Templates" }]} />
      <PageHeader title="Message templates" description="Reusable replies. Variables are filled in for each conversation and stay editable before sending." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Templates" />
          {rows.length === 0 ? <EmptyState title="No templates yet" /> : (
            <ul className="divide-y divide-border">
              {rows.map(({ t, propertyName }) => (
                <li key={t.id} className="space-y-1 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{t.name} <span className="text-xs font-normal text-faint">{propertyName ?? "All properties"}</span></p>
                    {(t.propertyId ? can(principal, "message.manage", { orgId: principal.orgId, propertyId: t.propertyId }) : orgWide) ? <ConfirmAction action={deleteTemplateAction.bind(null, orgSlug, t.id)} label="Delete" confirmLabel="Delete" variant="secondary" /> : null}
                  </div>
                  <p className="whitespace-pre-line text-[13px] text-muted">{t.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="New template" description={Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => `{{${k}}} ${v.toLowerCase()}`).join(" · ")} />
          <div className="p-4">
            <SchemaForm action={createTemplateAction.bind(null, orgSlug)} submitLabel="Save template" resetOnSuccess fields={[
              { name: "name", label: "Name", placeholder: "Request received" },
              { name: "propertyId", label: "Available at", type: "select", defaultValue: orgWide ? "" : props[0]?.id, options: [...(orgWide ? [{ value: "", label: "All properties" }] : []), ...props.map((p) => ({ value: p.id, label: p.name }))] },
              { name: "body", label: "Text", type: "textarea", rows: 6, placeholder: "Hi {{resident_first_name}}, thanks for your message about unit {{unit}}…" },
            ]} />
          </div>
        </Panel>
      </div>
    </>
  );
}
