import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getWorkOrder } from "@/server/modules/maintenance/service";
import { PRIORITY_ORDER, WO_CATEGORIES } from "@/server/modules/maintenance/rules";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { Timeline } from "@/components/ops/timeline";
import { AttachmentList, UploadForm } from "@/components/ops/attachments";
import { TransitionForm } from "@/components/ops/transition-form";
import { PRIORITY, TRANSITION_LABEL, WO_CATEGORY, WO_STATUS } from "@/lib/ops-labels";
import { fmtDateTime, relative, utcToZonedInput } from "@/lib/time";
import {
  assignWorkOrderAction, commentWorkOrderAction, scheduleWorkOrderAction, transitionWorkOrderAction, updateWorkOrderDetailsAction,
  uploadAttachmentAction,
} from "../../ops-actions";

export const metadata = { title: "Work order" };

const VIS_LABEL: Record<string, string> = { public: "Everyone on this request", vendor: "Staff & vendor only", internal: "Staff only (internal note)" };

export default async function WorkOrderPage({ params, searchParams }: PageProps<"/o/[orgSlug]/maintenance/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getWorkOrder(ctx, id));
  const w = d.workOrder;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  const a = d.access;
  const staffView = a.manage || a.staff;
  const open = !["completed", "closed", "cancelled"].includes(w.status);
  const overdue = open && !!w.resolveDueAt && w.resolveDueAt < new Date();
  const guidance = sp(q.created) ? [...d.timeline].reverse().find((t) => t.e.kind === "guidance")?.e.body : null;
  const location = [d.labels?.propertyName, d.labels?.buildingName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : null, w.area].filter(Boolean).join(" · ");
  const actor = a.manage ? "manager" : a.worker ? "worker" : "requester";

  return (
    <>
      <Breadcrumbs items={[{ label: principal.role.category === "resident" ? "My requests" : "Maintenance", href: `${base}/maintenance` }, { label: `#${w.number}` }]} />
      <PageHeader
        title={w.title}
        description={<span>#{w.number} · {location}</span>}
        actions={<div className="flex flex-wrap gap-1.5">
          {w.isEmergency ? <Badge tone="danger">Emergency</Badge> : null}
          <Badge tone={PRIORITY[w.priority]?.tone}>{PRIORITY[w.priority]?.label} priority</Badge>
          <Badge tone={WO_STATUS[w.status]?.tone}>{WO_STATUS[w.status]?.label}</Badge>
        </div>}
      />

      {sp(q.created) ? (
        <div role="status" className="mb-4 rounded-[var(--radius-md)] border border-success/30 bg-success-soft px-4 py-3 text-sm text-success">
          <p className="font-medium">Request #{w.number} submitted.{w.isEmergency ? " Staff have been alerted." : " We'll notify you as it progresses."}</p>
          {guidance ? <div className="mt-2 text-fg"><p className="text-[13px] font-medium">What to do now</p><p className="whitespace-pre-line text-[13px]">{guidance}</p></div> : null}
        </div>
      ) : null}
      {sp(q.upload) === "failed" ? (
        <div role="alert" className="mb-4 rounded-[var(--radius-md)] border border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning">Your request was saved, but one or more files couldn&apos;t be uploaded. Try adding them again below.</div>
      ) : null}
      {overdue && staffView ? <div className="mb-4 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">Past its resolution target ({fmtDateTime(w.resolveDueAt, tz)}).</div> : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            <div className="space-y-3 px-4 py-3">
              <p className="whitespace-pre-line break-words text-sm">{w.description || <span className="text-faint">No description.</span>}</p>
              {w.resolutionNotes ? <div className="rounded-[var(--radius-md)] bg-subtle px-3 py-2 text-[13px]"><span className="font-medium">Resolution:</span> {w.resolutionNotes}</div> : null}
            </div>
            <DetailList items={[
              ["Category", WO_CATEGORY[w.category] ?? w.category],
              ["Submitted", `${fmtDateTime(w.createdAt, tz)}${d.submitterName ? ` by ${d.submitterName}` : ""}`],
              ["Scheduled visit", w.scheduledStart ? `${fmtDateTime(w.scheduledStart, tz)}${w.scheduledEnd ? ` – ${w.scheduledEnd.toLocaleTimeString("en-CA", { timeZone: tz, timeStyle: "short" })}` : ""}` : null],
              ["Assigned to", d.assignee?.name ?? null],
              ["Vendor", d.vendor ? `${d.vendor.name}${(a.manage || a.staff) && d.vendor.phone ? ` · ${d.vendor.phone}` : ""}` : null],
              ["Entry", w.permissionToEnter ? "May enter if nobody is home" : "Resident must be present"],
              ["Entry notes", w.entryNotes],
              ...(staffView ? [
                ["Respond by", w.respondDueAt ? `${fmtDateTime(w.respondDueAt, tz)}${w.firstResponseAt ? " · responded" : ""}` : null],
                ["Resolve by", w.resolveDueAt ? `${fmtDateTime(w.resolveDueAt, tz)}${open ? ` (${relative(w.resolveDueAt)})` : ""}` : null],
                ["Cost", w.cost ? `$${Number(w.cost).toLocaleString("en-CA", { minimumFractionDigits: 2 })}` : null],
                ["Source", w.sourceType === "inspection" && w.sourceId ? <Link key="s" className="text-accent hover:underline" href={`${base}/inspections/${w.sourceId}`}>Inspection follow-up</Link> : w.source],
              ] as [string, React.ReactNode][] : []),
            ]} />
          </Panel>

          <Panel>
            <PanelHeader title="Activity" description={staffView ? "Tags show who else can read an entry." : undefined} />
            <Timeline events={d.timeline} statusLabels={WO_STATUS} tz={tz} showVisibility={staffView || a.worker} />
            <div className="border-t border-border p-4">
              <SchemaForm action={commentWorkOrderAction.bind(null, orgSlug, id)} submitLabel="Post" pendingLabel="Posting…" resetOnSuccess fields={[
                { name: "body", label: "Add a comment", type: "textarea", maxLength: 4000, placeholder: a.requester && !staffView ? "Ask a question or add details…" : "" },
                ...(d.commentLevels.length > 1 ? [{ name: "visibility", label: "Visible to", type: "select" as const, defaultValue: staffView ? "internal" : "vendor", options: d.commentLevels.map((l) => ({ value: l, label: VIS_LABEL[l] })) }] : []),
              ]} hidden={d.commentLevels.length > 1 ? undefined : { visibility: "public" }} />
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          {d.transitions.length ? (
            <Panel>
              <PanelHeader title="Status" />
              <TransitionForm action={transitionWorkOrderAction.bind(null, orgSlug, id)} askCost={actor !== "requester"}
                options={d.transitions.map((t) => ({ value: t, label: actor === "requester" && t === "cancelled" ? "Withdraw request" : TRANSITION_LABEL[t] ?? t, danger: t === "cancelled" }))} />
            </Panel>
          ) : null}

          {d.assignOptions && open ? (
            <Panel>
              <PanelHeader title="Assignment" description="Staff covering this property and vendors approved for it." />
              <div className="p-4">
                <SchemaForm action={assignWorkOrderAction.bind(null, orgSlug, id)} submitLabel="Save assignment" fields={[
                  { name: "membershipId", label: "Staff", type: "select", defaultValue: w.assignedMembershipId ?? "", options: [{ value: "", label: "Nobody" }, ...d.assignOptions.staff.map((s) => ({ value: s.membershipId, label: `${s.name} · ${s.role}` }))] },
                  { name: "vendorId", label: "Vendor", type: "select", defaultValue: w.vendorId ?? "", options: [{ value: "", label: "No vendor" }, ...d.assignOptions.vendors.map((v) => ({ value: v.id, label: `${v.name}${v.categories.includes(w.category) ? " ★" : ""}` }))],
                    hint: "★ lists this category among the vendor's trades." },
                ]} />
              </div>
            </Panel>
          ) : null}

          {(a.manage || a.worker) && open ? (
            <Panel>
              <PanelHeader title="Schedule a visit" description={`Times are in ${tz}.`} />
              <div className="p-4">
                <SchemaForm action={scheduleWorkOrderAction.bind(null, orgSlug, id)} submitLabel={w.scheduledStart ? "Reschedule" : "Schedule"} fields={[
                  { name: "start", label: "Start", type: "datetime-local", defaultValue: w.scheduledStart ? utcToZonedInput(w.scheduledStart, tz) : "" },
                  { name: "durationMinutes", label: "Duration (minutes)", type: "number", defaultValue: w.scheduledStart && w.scheduledEnd ? Math.round((w.scheduledEnd.getTime() - w.scheduledStart.getTime()) / 60000) : 120 },
                  { name: "note", label: "Note for the resident (optional)" },
                ]} />
              </div>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Photos & files" />
            <AttachmentList files={d.attachments} base={base} />
            {open || staffView ? <UploadForm action={uploadAttachmentAction.bind(null, orgSlug, "work_order", id)} levels={d.commentLevels} /> : null}
          </Panel>

          {a.manage ? (
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">Edit details</summary>
                <div className="border-t border-border p-4">
                  <SchemaForm action={updateWorkOrderDetailsAction.bind(null, orgSlug, id)} submitLabel="Save details" fields={[
                    { name: "title", label: "Title", defaultValue: w.title },
                    { name: "category", label: "Category", type: "select", defaultValue: w.category, options: WO_CATEGORIES.map((c) => ({ value: c, label: WO_CATEGORY[c] })) },
                    { name: "priority", label: "Priority", type: "select", defaultValue: w.priority, options: [...PRIORITY_ORDER].reverse().map((p) => ({ value: p, label: PRIORITY[p].label })), hint: "Changing priority recalculates SLA targets." },
                    { name: "isEmergency", label: "Emergency", type: "checkbox", defaultValue: w.isEmergency },
                    { name: "description", label: "Description", type: "textarea", defaultValue: w.description },
                  ]} />
                </div>
              </details>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
