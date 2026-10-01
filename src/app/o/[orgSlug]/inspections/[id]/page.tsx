import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getInspection } from "@/server/modules/inspections/service";
import { WO_CATEGORIES } from "@/server/modules/maintenance/rules";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { Timeline } from "@/components/ops/timeline";
import { InspectionItemForm } from "@/components/ops/inspection-item";
import { INSPECTION_KIND, INSPECTION_STATUS, SEVERITY, WO_CATEGORY } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import { completeInspectionAction, followUpWorkOrderAction, recordItemAction } from "../../ops-actions";

export const metadata = { title: "Inspection" };

export default async function InspectionPage({ params }: PageProps<"/o/[orgSlug]/inspections/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal, session } = await getOrgContext(orgSlug);
  const d = await orNotFound(getInspection(ctx, id));
  const i = d.inspection;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  const editable = d.access.perform && (i.status === "scheduled" || i.status === "in_progress");
  const sections = [...new Set(d.items.map((x) => x.section))];
  const answered = d.items.filter((x) => x.result).length;
  const failed = d.items.filter((x) => x.result === "fail");
  return (
    <>
      <Breadcrumbs items={[{ label: "Inspections", href: `${base}/inspections` }, { label: i.title }]} />
      <PageHeader title={i.title} description={[INSPECTION_KIND[i.kind] ?? i.kind, d.labels?.propertyName, d.labels?.buildingName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : null].filter(Boolean).join(" · ")}
        actions={i.result ? <Badge tone={i.result === "pass" ? "success" : "danger"}>{i.result === "pass" ? "Passed" : "Failed"}</Badge> : <Badge tone={INSPECTION_STATUS[i.status]?.tone}>{INSPECTION_STATUS[i.status]?.label}</Badge>} />
      {i.status === "completed" && failed.some((f) => !f.workOrderId) && d.canCreateWorkOrder ? (
        <div role="status" className="mb-4 rounded-[var(--radius-md)] border border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning">
          {(() => { const n = failed.filter((f) => !f.workOrderId).length; return `${n} failed item${n === 1 ? " needs a" : "s need"} follow-up work order${n === 1 ? "" : "s"} — create ${n === 1 ? "it" : "them"} below.`; })()}
        </div>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {sections.map((s) => (
            <Panel key={s}>
              <PanelHeader title={s} />
              <ul className="divide-y divide-border">
                {d.items.filter((x) => x.section === s).map((it) => (
                  <li key={it.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm">{it.label}</p>
                      {it.result ? <Badge tone={it.result === "pass" ? "success" : it.result === "fail" ? "danger" : "neutral"}>{it.result === "na" ? "N/A" : it.result === "pass" ? "Pass" : `Fail · ${SEVERITY[it.severity ?? ""]?.label ?? ""}`}</Badge> : <Badge>Not checked</Badge>}
                    </div>
                    {it.notes && !editable ? <p className="mt-1 text-[13px] text-muted">{it.notes}</p> : null}
                    {editable ? <InspectionItemForm action={recordItemAction.bind(null, orgSlug, it.id)} item={{ result: it.result, severity: it.severity, notes: it.notes }} /> : null}
                    {it.result === "fail" && i.status === "completed" ? (
                      it.workOrderId ? <Link className="mt-1 inline-block text-[13px] text-accent hover:underline" href={`${base}/maintenance/${it.workOrderId}`}>View follow-up work order →</Link>
                        : d.canCreateWorkOrder ? <div className="mt-2"><SchemaForm action={followUpWorkOrderAction.bind(null, orgSlug, it.id)} submitLabel="Create follow-up work order" pendingLabel="Creating…" fields={[
                          { name: "category", label: "Category", type: "select", defaultValue: "general", options: WO_CATEGORIES.map((c) => ({ value: c, label: WO_CATEGORY[c] })) },
                        ]} /></div> : null
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
          <Panel>
            <PanelHeader title="Activity" />
            <Timeline events={d.timeline} statusLabels={INSPECTION_STATUS} tz={tz} showVisibility={false} />
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Summary" />
            <DetailList items={[
              ["Scheduled for", i.scheduledFor], ["Inspector", d.inspectorName], ["Progress", `${answered} of ${d.items.length} checked`],
              ["Failed items", String(failed.length)], ["Completed", i.completedAt ? fmtDateTime(i.completedAt, tz) : null], ["Signed by", i.signedByName], ["Summary", i.summary],
            ]} />
          </Panel>
          {editable ? (
            <Panel>
              <PanelHeader title="Complete & sign" description="Every item must be checked. Any failure fails the inspection." />
              <div className="p-4">
                <SchemaForm action={completeInspectionAction.bind(null, orgSlug, id)} submitLabel="Complete inspection" fields={[
                  { name: "summary", label: "Summary (optional)", type: "textarea" },
                  { name: "signedByName", label: "Sign with your full name", defaultValue: session.user.name },
                ]} />
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
