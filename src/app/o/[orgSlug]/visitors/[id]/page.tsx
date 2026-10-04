import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getVisitor } from "@/server/modules/visitors/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { FormAlert } from "@/components/ui/form";
import { SchemaForm } from "@/components/ui/schema-form";
import { ActionButton } from "@/components/ops/action-button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { RegeneratePass } from "@/components/frontdesk/regenerate-pass";
import { PASS_STATE, VISITOR_KIND, VISITOR_STATUS, fmtPlate } from "@/lib/facility-labels";
import { WO_STATUS } from "@/lib/ops-labels";
import { fmtDateTime, fmtRange } from "@/lib/time";
import { cancelVisitorAction, checkInVisitorAction, checkOutVisitorAction, denyVisitorAction, regeneratePassAction } from "../../frontdesk-actions";

export const metadata = { title: "Visit" };

export default async function VisitorPage({ params, searchParams }: PageProps<"/o/[orgSlug]/visitors/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getVisitor(ctx, id));
  const v = d.visitor;
  const tz = d.labels.tz;
  const staff = d.access.manage;
  const base = `/o/${orgSlug}`;
  const outside = d.state !== "valid";
  return (
    <>
      <Breadcrumbs items={[{ label: staff ? "Visitors" : "My guests", href: `${base}/visitors` }, { label: v.name }]} />
      <PageHeader title={v.name} description={`${VISITOR_KIND[v.kind]}${v.company ? ` · ${v.company}` : ""} · ${d.unitNumber ? `Unit ${d.unitNumber}, ` : ""}${d.labels.buildingName}`}
        actions={<div className="flex gap-2"><Badge tone={d.overstay ? "warning" : VISITOR_STATUS[v.status]?.tone}>{d.overstay ? "Past their window" : VISITOR_STATUS[v.status]?.label}</Badge>
          {v.status === "expected" ? <Badge tone={PASS_STATE[d.state]?.tone}>{PASS_STATE[d.state]?.label}</Badge> : null}</div>} />
      {sp(q.scanned) ? <div className="mb-4"><FormAlert kind="info">Pass scanned. Check the details before letting them in.</FormAlert></div> : null}
      {sp(q.arrived) ? <div className="mb-4"><FormAlert kind="success">Checked in. The host has been notified.</FormAlert></div> : null}
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-6 lg:col-span-2">
          <Panel>
            <PanelHeader title="Visit" />
            <DetailList items={[
              ["When", fmtRange(v.expectedFrom, v.expectedUntil, tz)],
              ["Where", `${d.unitNumber ? `Unit ${d.unitNumber} · ` : ""}${d.labels.buildingName}, ${d.labels.propertyName}`],
              ...(staff ? [["Phone", v.phone] as [string, string | null]] : []),
              ["Vehicle", v.plate ? `${fmtPlate(v.plate)}${v.needsParking ? " · needs visitor parking" : ""}` : null],
              ["Notes", v.purpose],
              ...(d.invitedByName ? [["Invited by", d.invitedByName] as [string, string]] : []),
              ...(d.workOrder ? [["Work order", <Link key="wo" className="text-accent hover:underline" href={`${base}/maintenance/${d.workOrder.id}`}>#{d.workOrder.number} {d.workOrder.title} ({WO_STATUS[d.workOrder.status]?.label})</Link>] as [string, React.ReactNode]] : []),
              ...(v.checkedInAt ? [["Checked in", `${fmtDateTime(v.checkedInAt, tz)}${d.checkedInByName ? ` by ${d.checkedInByName}` : ""}`] as [string, string]] : []),
              ...(v.checkedOutAt ? [["Checked out", `${fmtDateTime(v.checkedOutAt, tz)}${d.checkedOutByName ? ` by ${d.checkedOutByName}` : ""}`] as [string, string]] : []),
              ...(v.deniedReason ? [["Turned away", v.deniedReason] as [string, string]] : []),
            ]} />
          </Panel>
          {d.permits.length ? (
            <Panel>
              <PanelHeader title="Visitor parking" />
              <ul className="divide-y divide-border text-[13px]">
                {d.permits.map((x) => <li key={x.id} className="flex justify-between gap-3 px-4 py-2.5"><span>Permit #{x.number} · {fmtPlate(x.plate)}{x.spaceCode ? ` · space ${x.spaceCode}` : ""}</span><span className="text-muted">until {x.validUntil ? fmtDateTime(x.validUntil, tz) : "open"}</span></li>)}
              </ul>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          {d.canCheckIn ? (
            <Panel>
              <PanelHeader title="Check in" description={outside ? (d.state === "upcoming" ? "This pass isn't valid yet." : "This pass has expired.") : "The host is notified when you check them in."} />
              <SchemaForm action={checkInVisitorAction.bind(null, orgSlug, id)} submitLabel="Check in" pendingLabel="Checking in…" className="p-4" fields={[
                { name: "plate", label: "Licence plate", defaultValue: v.plate ?? "", hint: "Required for visitor parking." },
                ...(d.freeSpaces.length ? [{ name: "spaceId", label: "Visitor parking", type: "select" as const, options: [{ value: "", label: "No parking needed" }, ...d.freeSpaces.map((s) => ({ value: s.id, label: `Space ${s.code}` }))], defaultValue: "" }]
                  : [{ name: "spaceId", label: "Visitor parking", type: "select" as const, options: [{ value: "", label: "No free visitor spaces" }], defaultValue: "" }]),
                ...(outside ? [{ name: "override", label: "Check in anyway", type: "checkbox" as const }, { name: "note", label: "Reason for the override", hint: "Kept in the audit log." }] : []),
              ]} />
            </Panel>
          ) : null}
          {d.canCheckOut ? (
            <Panel>
              <PanelHeader title="On site" description={d.overstay ? "They're past the end of their visit." : undefined} />
              <div className="p-4"><ActionButton action={checkOutVisitorAction.bind(null, orgSlug, id)} label="Check out" variant="primary" /></div>
            </Panel>
          ) : null}
          {d.canRegenerate ? (
            <Panel>
              <PanelHeader title="Pass" />
              <div className="p-4"><RegeneratePass action={regeneratePassAction.bind(null, orgSlug, id)} base={base} guestName={v.name} /></div>
            </Panel>
          ) : null}
          {staff && v.status === "expected" ? (
            <Panel>
              <PanelHeader title="Turn away" />
              <SchemaForm action={denyVisitorAction.bind(null, orgSlug, id)} submitLabel="Record and tell the host" className="p-4" fields={[{ name: "reason", label: "Reason", placeholder: "e.g. host didn't answer, ID not shown" }]} />
            </Panel>
          ) : null}
          {d.canCancel ? (
            <Panel>
              <PanelHeader title="Cancel visit" />
              <div className="p-4"><ConfirmAction action={cancelVisitorAction.bind(null, orgSlug, id)} label="Cancel this visit" confirmLabel="Yes, cancel it" description="The pass stops working immediately." /></div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
