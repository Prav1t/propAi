import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listTemplates } from "@/server/modules/inspections/service";
import { INSPECTION_KINDS } from "@/server/db/schema";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { INSPECTION_KIND } from "@/lib/ops-labels";
import { archiveTemplateAction, createTemplateAction } from "../../ops-actions";

export const metadata = { title: "Inspection templates" };

export default async function TemplatesPage({ params }: PageProps<"/o/[orgSlug]/inspections/templates">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("inspection.manage")) notFound();
  const templates = await listTemplates(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Inspections", href: `/o/${orgSlug}/inspections` }, { label: "Templates" }]} />
      <PageHeader title="Inspection templates" description="Reusable checklists. Templates with a repeat interval schedule the next inspection when one is completed." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Templates" />
          {templates.length === 0 ? <EmptyState title="No templates yet" /> : (
            <ul className="divide-y divide-border">
              {templates.map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{t.name}</p>
                      <p className="text-xs text-faint">{INSPECTION_KIND[t.kind] ?? t.kind} · {t.items.length} items{t.repeatEveryDays ? ` · repeats every ${t.repeatEveryDays} days` : ""}</p>
                    </div>
                    <ConfirmAction action={archiveTemplateAction.bind(null, orgSlug, t.id)} label="Archive" confirmLabel="Archive" variant="secondary" description="Scheduled inspections keep their checklist; no new ones can use this template." />
                  </div>
                  <details className="mt-1"><summary className="cursor-pointer text-xs text-accent">Show checklist</summary>
                    <ul className="mt-1 space-y-0.5 text-[13px] text-muted">{t.items.map((i, n) => <li key={n}><Badge className="mr-1">{i.section}</Badge>{i.label}</li>)}</ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="New template" />
          <div className="p-4">
            <SchemaForm action={createTemplateAction.bind(null, orgSlug)} submitLabel="Create template" resetOnSuccess fields={[
              { name: "name", label: "Name", placeholder: "e.g. Monthly fire safety walk" },
              { name: "kind", label: "Type", type: "select", options: INSPECTION_KINDS.map((k) => ({ value: k, label: INSPECTION_KIND[k] ?? k })) },
              { name: "repeatEveryDays", label: "Repeat every (days, optional)", type: "number" },
              { name: "items", label: "Checklist", type: "textarea", hint: "One item per line. Prefix with a section and colon to group, e.g. “Kitchen: Faucet runs without leaks”." },
            ]} />
          </div>
        </Panel>
      </div>
    </>
  );
}
