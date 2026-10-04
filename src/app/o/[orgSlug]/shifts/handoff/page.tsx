import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canSeeShifts, listHandoffs, myShifts, previewSnapshot, shiftPlaces } from "@/server/modules/shifts/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ActionButton } from "@/components/ops/action-button";
import { SnapshotView } from "@/components/frontdesk/snapshot-view";
import { fmtDateTime, relative } from "@/lib/time";
import { ackHandoffAction, createHandoffAction } from "../../frontdesk-actions";

export const metadata = { title: "Shift handoff" };

export default async function HandoffPage({ params, searchParams }: PageProps<"/o/[orgSlug]/shifts/handoff">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canSeeShifts(principal)) notFound();
  const [places, mine] = await Promise.all([shiftPlaces(ctx), myShifts(ctx)]);
  // default to the property of my current shift
  const nowMs = new Date().getTime();
  const current = mine.find((s) => s.startsAt.getTime() - 3_600_000 <= nowMs && nowMs < s.endsAt.getTime() + 3_600_000);
  const propertyId = places.properties.find((p) => p.id === sp(q.property))?.id ?? current?.propertyId ?? places.properties[0]?.id;
  if (!propertyId) notFound();
  const [snapshot, handoffs] = await Promise.all([orNotFound(previewSnapshot(ctx, propertyId, null)), listHandoffs(ctx, { propertyId, limit: 15 })]);
  const prop = places.properties.find((p) => p.id === propertyId)!;
  return (
    <>
      <Breadcrumbs items={[{ label: "Shifts", href: `/o/${orgSlug}/shifts` }, { label: "Handoff" }]} />
      <PageHeader title="Shift handoff" description="Tell the next shift what they need to know. The current open items are attached automatically." />
      {places.properties.length > 1 ? (
        <form className="mb-4 flex items-center gap-2 text-[13px]" action={`/o/${orgSlug}/shifts/handoff`}>
          <label htmlFor="ho-prop" className="text-muted">Property</label>
          <select id="ho-prop" name="property" defaultValue={propertyId} className="h-8 rounded-[var(--radius-md)] border border-border-strong bg-surface px-2">
            {places.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="h-8 rounded-[var(--radius-md)] border border-border-strong px-2">Show</button>
        </form>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel>
          <PanelHeader title={`Right now at ${prop.name}`} />
          <div className="space-y-4 p-4">
            <SnapshotView s={snapshot} />
            <SchemaForm action={createHandoffAction.bind(null, orgSlug)} submitLabel="Save handoff" resetOnSuccess hidden={{ propertyId }} fields={[
              { name: "notes", label: "Notes for the next shift", type: "textarea", rows: 6, placeholder: "e.g. Plumber returns at 9 for the 1204 leak; lobby door closer is sticky; Unit 805 expecting a large delivery." },
            ]} />
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Recent handoffs" />
          {handoffs.length === 0 ? <EmptyState title="No handoffs yet" /> : (
            <ul className="divide-y divide-border">{handoffs.map((h) => (
              <li key={h.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span><span className="font-medium">{h.authorName ?? "Former staff"}</span> <span className="text-muted" title={fmtDateTime(h.createdAt, h.tz)}>· {relative(h.createdAt)}</span></span>
                  {h.acknowledgedAt ? <Badge tone="success">Read by {h.acknowledgedByName ?? "next shift"}</Badge>
                    : h.mine ? <Badge>Waiting for the next shift</Badge> : <ActionButton action={ackHandoffAction.bind(null, orgSlug, h.id)} label="Acknowledge" variant="primary" />}
                </div>
                <p className="whitespace-pre-line text-sm">{h.notes}</p>
                <details className="text-[13px]"><summary className="cursor-pointer text-muted">Open items at the time</summary><div className="mt-2"><SnapshotView s={h.snapshot} /></div></details>
              </li>
            ))}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
