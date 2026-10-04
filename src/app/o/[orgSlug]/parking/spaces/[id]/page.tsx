import { getOrgContext, orNotFound } from "@/server/org-context";
import { getSpace, parkingFormOptions } from "@/server/modules/parking/service";
import { PARKING_SPACE_KINDS } from "@/server/db/schema";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { PERMIT_KIND, PERMIT_STATE, SPACE_KIND, fmtPlate } from "@/lib/facility-labels";
import { fmtDateTime } from "@/lib/time";
import { updateSpaceAction } from "../../../frontdesk-actions";

export const metadata = { title: "Parking space" };

export default async function SpacePage({ params }: PageProps<"/o/[orgSlug]/parking/spaces/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getSpace(ctx, id));
  const o = await parkingFormOptions(ctx);
  const s = d.space;
  return (
    <>
      <Breadcrumbs items={[{ label: "Parking", href: `/o/${orgSlug}/parking?tab=spaces` }, { label: s.code }]} />
      <PageHeader title={`Space ${s.code}`} description={`${SPACE_KIND[s.kind]} · ${d.property.name}`} />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel>
          <PanelHeader title="Details" />
          <SchemaForm action={updateSpaceAction.bind(null, orgSlug, id)} submitLabel="Save" columns={2} className="p-4" hidden={{ propertyId: s.propertyId }} fields={[
            { name: "code", label: "Space number", defaultValue: s.code }, { name: "level", label: "Level", defaultValue: s.level ?? "" },
            { name: "kind", label: "Type", type: "select", options: PARKING_SPACE_KINDS.map((k) => ({ value: k, label: SPACE_KIND[k] })), defaultValue: s.kind },
            { name: "status", label: "Status", type: "select", options: [{ value: "available", label: "In service" }, { value: "out_of_service", label: "Out of service" }], defaultValue: s.status },
            { name: "assignBuildingId", label: "Assigned unit's building", type: "select", options: [{ value: "", label: "Not assigned" }, ...o.buildings.filter((b) => b.propertyId === s.propertyId).map((b) => ({ value: b.id, label: b.name }))], defaultValue: d.unit?.buildingId ?? "" },
            { name: "assignUnitNumber", label: "Assigned unit", defaultValue: d.unit?.number ?? "" },
            { name: "notes", label: "Notes", type: "textarea", span: 2, defaultValue: s.notes ?? "" },
          ]} />
        </Panel>
        <Panel>
          <PanelHeader title="Permits on this space" />
          {d.permits.length === 0 ? <EmptyState title="No permits yet" /> : (
            <ul className="divide-y divide-border text-[13px]">{d.permits.map((x) => (
              <li key={x.id} className="flex flex-wrap justify-between gap-2 px-4 py-2.5"><span>#{x.number} · <span className="font-mono">{fmtPlate(x.plate)}</span> · {PERMIT_KIND[x.kind]}</span>
                <span className="flex items-center gap-2 text-muted">{fmtDateTime(x.validFrom, d.property.tz)} → {x.validUntil ? fmtDateTime(x.validUntil, d.property.tz) : "open"} <Badge tone={PERMIT_STATE[x.state]?.tone}>{PERMIT_STATE[x.state]?.label}</Badge></span></li>
            ))}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
