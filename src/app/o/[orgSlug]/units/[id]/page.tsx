import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getUnit } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { RELATIONSHIP_LABEL, UNIT_STATUS, UNIT_TYPE_LABEL } from "@/lib/labels";
import { deleteUnitAction, endOccupancyAction, updateUnitAction } from "../../portfolio-actions";
import { unitFields } from "../unit-fields";

export const metadata = { title: "Unit" };

export default async function UnitPage({ params }: PageProps<"/o/[orgSlug]/units/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getUnit(ctx, id));
  const u = d.unit;
  const base = `/o/${orgSlug}`;
  const today = new Date().toISOString().slice(0, 10);
  const current = d.occupancies.filter((o) => !o.endsOn || o.endsOn >= today);
  const past = d.occupancies.filter((o) => o.endsOn && o.endsOn < today);
  const staffView = principal.permissions.has("unit.read");
  return (
    <>
      {staffView ? <Breadcrumbs items={[{ label: "Units", href: `${base}/units` }, { label: d.propertyName, href: `${base}/properties/${u.propertyId}` }, { label: d.buildingName, href: `${base}/buildings/${u.buildingId}` }, { label: u.number }]} /> : null}
      <PageHeader
        title={`Unit ${u.number}`}
        description={`${d.buildingName} · ${d.propertyName}${d.floorName ? ` · ${d.floorName}` : ""}`}
        actions={d.canManageResidents ? <LinkButton href={`${base}/residents/new?building=${u.buildingId}&unit=${encodeURIComponent(u.number)}`} size="sm">Add resident</LinkButton> : null}
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title={staffView ? "Current residents" : "Household"} />
            {current.length === 0 ? <EmptyState title="No current residents" /> : (
              <ul className="divide-y divide-border">
                {current.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {d.seeResidentDetails ? <Link className="hover:underline" href={`${base}/residents/${o.residentId}`}>{o.firstName} {o.lastName}</Link> : `${o.firstName} ${o.lastName}`}
                        {o.isPrimary ? <Badge tone="accent" className="ml-2">Primary</Badge> : null}
                      </p>
                      <p className="text-xs text-faint">{RELATIONSHIP_LABEL[o.relationship]}{o.startsOn ? ` · since ${o.startsOn}` : ""}{o.email ? ` · ${o.email}` : ""}{o.phone ? ` · ${o.phone}` : ""}</p>
                    </div>
                    {d.canManageResidents ? (
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded px-2 py-1 text-[13px] text-accent hover:bg-subtle">Move out</summary>
                        <div className="absolute right-0 z-20 mt-1 w-64 rounded-[var(--radius-lg)] border border-border bg-surface p-3 shadow-lg">
                          <SchemaForm action={endOccupancyAction.bind(null, orgSlug, o.id)} submitLabel="Record move-out" fields={[{ name: "endsOn", label: "Move-out date", type: "date", defaultValue: today, required: true }]} />
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {d.seeResidentDetails && past.length ? (
            <Panel>
              <PanelHeader title="Past residents" />
              <ul className="divide-y divide-border">
                {past.map((o) => (
                  <li key={o.id} className="px-4 py-2.5 text-sm">
                    <Link className="hover:underline" href={`${base}/residents/${o.residentId}`}>{o.firstName} {o.lastName}</Link>
                    <span className="text-xs text-faint"> · {RELATIONSHIP_LABEL[o.relationship]} · {o.startsOn ?? "?"} → {o.endsOn}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Details" actions={<Badge tone={UNIT_STATUS[u.status]?.tone}>{UNIT_STATUS[u.status]?.label}</Badge>} />
            <DetailList items={[
              ["Type", UNIT_TYPE_LABEL[u.type]],
              ["Bedrooms", u.bedrooms],
              ["Bathrooms", u.bathrooms],
              ["Area", u.areaSqft ? `${u.areaSqft.toLocaleString()} sq ft` : null],
            ]} />
          </Panel>
          {d.canManage ? (
            <Panel>
              <PanelHeader title="Edit unit" />
              <div className="space-y-4 p-4">
                <SchemaForm action={updateUnitAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save" fields={unitFields(d.floorOptions, u)} />
                <ConfirmAction action={deleteUnitAction.bind(null, orgSlug, id)} label="Delete unit…" confirmLabel="Delete unit" description="Units with current residents can't be deleted." />
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
