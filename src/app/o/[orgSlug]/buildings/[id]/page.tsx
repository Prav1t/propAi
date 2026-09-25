import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getBuilding } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { cn } from "@/lib/cn";
import { UNIT_STATUS, UNIT_TYPE_LABEL, opts } from "@/lib/labels";
import {
  addFloorAction, createUnitAction, deleteBuildingAction, deleteFloorAction, generateUnitsAction, updateBuildingAction,
} from "../../portfolio-actions";
import { unitFields } from "../../units/unit-fields";

export const metadata = { title: "Building" };

const tile: Record<string, string> = {
  occupied: "border-success/30 bg-success-soft", vacant: "border-border bg-surface", notice: "border-warning/40 bg-warning-soft",
  renovation: "border-accent/30 bg-accent-soft", unavailable: "border-danger/30 bg-danger-soft",
};

export default async function BuildingPage({ params }: PageProps<"/o/[orgSlug]/buildings/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getBuilding(ctx, id));
  const base = `/o/${orgSlug}`;
  const occupied = d.units.filter((u) => u.status === "occupied").length;
  const unassigned = d.units.filter((u) => !u.floorId);
  const byFloor = d.floors.map((f) => ({ floor: f, units: d.units.filter((u) => u.floorId === f.id) }));
  return (
    <>
      <Breadcrumbs items={[{ label: "Properties", href: `${base}/properties` }, { label: d.property.name, href: `${base}/properties/${d.property.id}` }, { label: d.building.name }]} />
      <PageHeader title={d.building.name} description={`${d.building.code}${d.building.yearBuilt ? ` · built ${d.building.yearBuilt}` : ""} · ${d.property.name}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Floors" value={d.floors.length} />
        <Stat label="Units" value={d.units.length} />
        <Stat label="Occupied" value={occupied} sub={d.units.length ? `${Math.round((occupied / d.units.length) * 100)}%` : undefined} />
        <Stat label="Vacant" value={d.units.filter((u) => u.status === "vacant").length} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Stacking plan" description="Units by floor, coloured by status." actions={
            <div className="hidden flex-wrap gap-1 sm:flex">{Object.entries(UNIT_STATUS).map(([k, v]) => <Badge key={k} tone={v.tone}>{v.label}</Badge>)}</div>
          } />
          {d.floors.length === 0 && d.units.length === 0 ? <EmptyState title="No floors or units yet">{d.canManageUnits ? "Generate floors and units from the panel on the right." : null}</EmptyState> : (
            <div className="divide-y divide-border">
              {[...byFloor, ...(unassigned.length ? [{ floor: { id: "none", name: "No floor", level: 0 }, units: unassigned }] : [])].map(({ floor, units }) => (
                <div key={floor.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="w-20 shrink-0 pt-1 text-xs font-medium text-muted">{floor.name}</div>
                  <div className="flex flex-1 flex-wrap gap-1.5">
                    {units.length === 0 ? <span className="pt-1 text-xs text-faint">No units</span> : units.map((u) => (
                      <Link key={u.id} href={`${base}/units/${u.id}`} title={`${UNIT_STATUS[u.status]?.label} · ${u.occupants} resident(s)`}
                        className={cn("min-w-14 rounded-[var(--radius-sm)] border px-2 py-1 text-center text-xs font-medium tabular-nums hover:border-accent", tile[u.status])}>
                        {u.number}
                      </Link>
                    ))}
                  </div>
                  {d.canManage && floor.id !== "none" && units.length === 0 ? (
                    <ConfirmAction action={deleteFloorAction.bind(null, orgSlug, floor.id)} label="Remove" confirmLabel="Remove floor" variant="secondary" />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-6">
          {d.canManageUnits ? (
            <Panel>
              <PanelHeader title="Generate units" description="Creates missing floors and numbers units like 1204. Existing numbers are skipped." />
              <div className="p-4">
                <SchemaForm action={generateUnitsAction.bind(null, orgSlug, id)} columns={2} submitLabel="Generate" pendingLabel="Generating…" fields={[
                  { name: "fromLevel", label: "From level", type: "number", defaultValue: 1 },
                  { name: "toLevel", label: "To level", type: "number", defaultValue: 10 },
                  { name: "perFloor", label: "Units per floor", type: "number", defaultValue: 6 },
                  { name: "type", label: "Type", type: "select", options: opts(UNIT_TYPE_LABEL), defaultValue: "residential" },
                ]} />
              </div>
            </Panel>
          ) : null}
          {d.canManageUnits ? (
            <Panel>
              <PanelHeader title="Add one unit" />
              <div className="p-4"><SchemaForm action={createUnitAction.bind(null, orgSlug, id)} columns={2} submitLabel="Add unit" fields={unitFields(d.floors)} /></div>
            </Panel>
          ) : null}
          {d.canManage ? (
            <>
              <Panel>
                <PanelHeader title="Add a floor" description="Use 0 for ground and negative levels for parking." />
                <div className="p-4"><SchemaForm action={addFloorAction.bind(null, orgSlug, id)} columns={2} submitLabel="Add floor" resetOnSuccess fields={[
                  { name: "level", label: "Level", type: "number", required: true },
                  { name: "name", label: "Name (optional)", placeholder: "Penthouse" },
                ]} /></div>
              </Panel>
              <Panel>
                <PanelHeader title="Building settings" />
                <div className="space-y-4 p-4">
                  <SchemaForm action={updateBuildingAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save" fields={[
                    { name: "name", label: "Name", required: true, defaultValue: d.building.name },
                    { name: "code", label: "Code", required: true, defaultValue: d.building.code },
                    { name: "yearBuilt", label: "Year built", type: "number", defaultValue: d.building.yearBuilt ?? "" },
                  ]} />
                  <ConfirmAction action={deleteBuildingAction.bind(null, orgSlug, id)} label="Delete building…" confirmLabel="Delete building" requireText={d.building.code}
                    description="Deletes its floors and units. Buildings with current residents can't be deleted." />
                </div>
              </Panel>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
