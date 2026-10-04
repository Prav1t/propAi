import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getThread } from "@/server/modules/messaging/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { MessageComposer } from "@/components/community/message-composer";
import { THREAD_CATEGORY } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { postMessageAction, updateThreadAction } from "../../community-actions";

export const metadata = { title: "Conversation" };

export default async function ThreadPage({ params }: PageProps<"/o/[orgSlug]/messages/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getThread(ctx, id));
  const t = d.thread;
  const tz = principal.orgTimezone;
  const staff = d.access.staff;
  const base = `/o/${orgSlug}`;
  return (
    <>
      <Breadcrumbs items={[{ label: staff ? "Resident messages" : "Messages", href: `${base}/messages` }, { label: t.subject }]} />
      <PageHeader title={t.subject} description={staff ? [d.labels?.residentName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : null, d.labels?.buildingName, d.labels?.propertyName].filter(Boolean).join(" · ") : d.labels?.propertyName}
        actions={<div className="flex gap-1.5"><Badge>{THREAD_CATEGORY[t.category]}</Badge>{t.status === "closed" ? <Badge>Closed</Badge> : <Badge tone="success">Open</Badge>}</div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <ol className="space-y-3 p-4" aria-label="Messages">
            {d.messages.map(({ m, authorName }) => {
              const mineSide = staff ? m.fromStaff : !m.fromStaff;
              return (
                <li key={m.id} className={cn("flex", mineSide ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm", m.internal ? "border border-dashed border-warning/50 bg-warning-soft/50" : mineSide ? "bg-accent-soft" : "bg-subtle")}>
                    <p className="mb-0.5 text-xs text-muted">{m.internal ? "Internal note · " : ""}{authorName ?? (m.fromStaff ? "Management" : "Resident")} · {fmtDateTime(m.createdAt, tz)}</p>
                    <p className="whitespace-pre-line break-words">{m.body}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="border-t border-border p-4">
            {t.status === "closed" && !staff ? <p className="mb-2 text-[13px] text-muted">This conversation is closed. Writing again reopens it.</p> : null}
            <MessageComposer action={postMessageAction.bind(null, orgSlug, id)} templates={d.templates} staff={staff} />
          </div>
        </Panel>
        {staff ? (
          <div className="space-y-6">
            <Panel>
              <PanelHeader title="Conversation" />
              <div className="p-4">
                <SchemaForm action={updateThreadAction.bind(null, orgSlug, id)} submitLabel="Save" fields={[
                  { name: "status", label: "Status", type: "select", defaultValue: t.status, options: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
                  { name: "assignedMembershipId", label: "Handled by", type: "select", defaultValue: t.assignedMembershipId ?? "", options: [{ value: "", label: "Unassigned" }, ...d.assignees.map((a) => ({ value: a.membershipId, label: a.name }))] },
                ]} />
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Resident" />
              <DetailList items={[
                ["Name", d.labels?.residentId ? <Link key="r" className="text-accent hover:underline" href={`${base}/residents/${d.labels.residentId}`}>{d.labels.residentName}</Link> : null],
                ["Unit", d.labels?.unitNumber ? `${d.labels.unitNumber} · ${d.labels.buildingName}` : null], ["Started", fmtDateTime(t.createdAt, tz)],
              ]} />
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}
