import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { COMPLAINT_STATUSES, getComplaint } from "@/server/modules/complaints/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { Timeline } from "@/components/ops/timeline";
import { COMPLAINT_CATEGORY, COMPLAINT_STATUS, PRIORITY } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import { commentComplaintAction, updateComplaintAction } from "../../ops-actions";

export const metadata = { title: "Complaint" };

export default async function ComplaintPage({ params }: PageProps<"/o/[orgSlug]/complaints/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getComplaint(ctx, id));
  const c = d.complaint;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  return (
    <>
      <Breadcrumbs items={[{ label: d.access.staff ? "Complaints" : "My complaints", href: `${base}/complaints` }, { label: `#${c.number}` }]} />
      <PageHeader title={c.subject} description={`#${c.number} · ${COMPLAINT_CATEGORY[c.category] ?? c.category}`}
        actions={<div className="flex gap-1.5">{d.access.staff ? <Badge tone={PRIORITY[c.priority]?.tone}>{PRIORITY[c.priority]?.label}</Badge> : null}<Badge tone={COMPLAINT_STATUS[c.status]?.tone}>{COMPLAINT_STATUS[c.status]?.label}</Badge></div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Complaint" />
            <p className="whitespace-pre-line break-words px-4 py-3 text-sm">{c.description}</p>
            <DetailList items={[
              ["Where", [d.labels?.propertyName, d.labels?.buildingName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : null].filter(Boolean).join(" · ")],
              ["Received", fmtDateTime(c.createdAt, tz)], ["Submitted by", d.submitterName], ["Handled by", d.assigneeName],
              ["Related incident", d.incident ? <Link key="i" className="text-accent hover:underline" href={`${base}/incidents/${d.incident.id}`}>#{d.incident.number} {d.incident.title}</Link> : null],
              ["Outcome", c.resolution],
            ]} />
          </Panel>
          <Panel>
            <PanelHeader title="Conversation" description={d.access.staff ? "Internal notes are never shown to the resident." : undefined} />
            <Timeline events={d.timeline} statusLabels={COMPLAINT_STATUS} tz={tz} showVisibility={d.access.staff} />
            <div className="border-t border-border p-4">
              <SchemaForm action={commentComplaintAction.bind(null, orgSlug, id)} submitLabel="Send" resetOnSuccess fields={[
                { name: "body", label: d.access.staff ? "Reply or note" : "Add a message", type: "textarea" },
                ...(d.access.staff ? [{ name: "visibility", label: "Visible to", type: "select" as const, defaultValue: "public", options: [{ value: "public", label: "Resident and staff" }, { value: "internal", label: "Staff only (internal note)" }] }] : []),
              ]} hidden={d.access.staff ? undefined : { visibility: "public" }} />
            </div>
          </Panel>
        </div>
        <div className="space-y-6">
          {d.access.manage ? (
            <Panel>
              <PanelHeader title="Manage" />
              <div className="p-4">
                <SchemaForm action={updateComplaintAction.bind(null, orgSlug, id)} submitLabel="Save" fields={[
                  { name: "status", label: "Status", type: "select", defaultValue: c.status, options: COMPLAINT_STATUSES.map((s) => ({ value: s, label: COMPLAINT_STATUS[s].label })) },
                  { name: "priority", label: "Priority", type: "select", defaultValue: c.priority, options: ["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: PRIORITY[p].label })) },
                  { name: "assignedMembershipId", label: "Handled by", type: "select", defaultValue: c.assignedMembershipId ?? "", options: [{ value: "", label: "Unassigned" }, ...d.assignees.map((a) => ({ value: a.membershipId, label: `${a.name} · ${a.role}` }))] },
                  { name: "relatedIncidentId", label: "Related incident", type: "select", defaultValue: c.relatedIncidentId ?? "", options: [{ value: "", label: "None" }, ...d.incidentOptions.map((i) => ({ value: i.id, label: `#${i.number} ${i.title}` }))] },
                  { name: "resolution", label: "Outcome (shown to the resident)", type: "textarea", defaultValue: c.resolution ?? "", hint: "Required to resolve or dismiss. State facts and next steps; don't make accusations." },
                ]} />
              </div>
            </Panel>
          ) : null}
          {d.history.length ? (
            <Panel>
              <PanelHeader title="Other complaints from this unit" />
              <ul className="divide-y divide-border">
                {d.history.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-[13px]"><Link className="hover:underline" href={`${base}/complaints/${h.id}`}>#{h.number} {h.subject}</Link>
                    <span className="block text-xs text-faint">{COMPLAINT_STATUS[h.status]?.label} · {fmtDateTime(h.createdAt, tz)}</span></li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
