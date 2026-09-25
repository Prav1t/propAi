import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getProperty } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { cat, PROPERTY_TYPE_LABEL, VENDOR_STATUS } from "@/lib/labels";
import { createBuildingAction } from "../../portfolio-actions";

export async function generateMetadata() {
  return { title: "Property" };
}

export default async function PropertyPage({ params }: PageProps<"/o/[orgSlug]/properties/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getProperty(ctx, id));
  const p = d.property;
  const base = `/o/${orgSlug}`;
  const units = d.buildings.reduce((a, b) => a + b.unitCount, 0);
  const occupied = d.buildings.reduce((a, b) => a + b.occupiedCount, 0);
  const address = [p.addressLine1, p.city, p.region, p.postalCode].filter(Boolean).join(", ");
  return (
    <>
      <Breadcrumbs items={[{ label: "Properties", href: `${base}/properties` }, { label: p.name }]} />
      <PageHeader
        title={p.name}
        description={<>{p.code} · {PROPERTY_TYPE_LABEL[p.type]}{address ? ` · ${address}` : ""}</>}
        actions={<>
          <LinkButton href={`${base}/units?property=${id}`} variant="secondary" size="sm">View units</LinkButton>
          <LinkButton href={`${base}/residents?property=${id}`} variant="secondary" size="sm">View residents</LinkButton>
          {d.canManage ? <LinkButton href={`${base}/properties/${id}/edit`} variant="secondary" size="sm">Edit</LinkButton> : null}
        </>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Buildings" value={d.buildings.length} />
        <Stat label="Units" value={units} />
        <Stat label="Occupancy" value={units ? `${Math.round((occupied / units) * 100)}%` : "—"} sub={`${occupied} occupied`} />
        <Stat label="Current residents" value={d.residentCount} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Buildings" />
            {d.buildings.length === 0 ? <EmptyState title="No buildings yet">{d.canManage ? "Add the first building below." : null}</EmptyState> : (
              <Table>
                <thead><tr><Th>Building</Th><Th className="text-right">Floors</Th><Th className="text-right">Units</Th><Th className="text-right">Occupancy</Th></tr></thead>
                <tbody>
                  {d.buildings.map((b) => (
                    <tr key={b.id} className="hover:bg-subtle/60">
                      <Td><Link className="font-medium hover:underline" href={`${base}/buildings/${b.id}`}>{b.name}</Link><div className="text-xs text-faint">{b.code}{b.yearBuilt ? ` · built ${b.yearBuilt}` : ""}</div></Td>
                      <Td className="text-right tabular-nums">{b.floorCount}</Td>
                      <Td className="text-right tabular-nums">{b.unitCount}</Td>
                      <Td className="text-right tabular-nums">{b.unitCount ? `${Math.round((b.occupiedCount / b.unitCount) * 100)}%` : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
          {d.canManage ? (
            <Panel>
              <PanelHeader title="Add a building" description="Optionally create its floors at the same time." />
              <div className="p-4">
                <SchemaForm action={createBuildingAction.bind(null, orgSlug, id)} columns={2} submitLabel="Add building" fields={[
                  { name: "name", label: "Name", required: true, placeholder: "Tower C" },
                  { name: "code", label: "Code", required: true, placeholder: "C" },
                  { name: "yearBuilt", label: "Year built", type: "number" },
                  { name: "floorsAbove", label: "Floors above ground", type: "number", hint: "Creates Level 1…N" },
                  { name: "hasGround", label: "Include a ground floor", type: "checkbox", span: 2 },
                ]} />
              </div>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Details" />
            <DetailList items={[
              ["Portfolio", d.portfolio?.name],
              ["Address", address || null],
              ["Time zone", p.timezone.replace("_", " ")],
              ["Created", p.createdAt.toLocaleDateString("en-CA", { dateStyle: "medium" })],
            ]} />
          </Panel>
          {d.staff ? (
            <Panel>
              <PanelHeader title="Assigned staff" />
              {d.staff.length === 0 ? <EmptyState title="No staff assigned" /> : (
                <ul className="divide-y divide-border">
                  {d.staff.map((s) => <li key={s.membershipId} className="px-4 py-2.5 text-sm"><Link className="font-medium hover:underline" href={`${base}/staff/${s.membershipId}`}>{s.name}</Link><div className="text-xs text-faint">{s.title ?? ""}</div></li>)}
                </ul>
              )}
            </Panel>
          ) : null}
          {d.vendors ? (
            <Panel>
              <PanelHeader title="Approved vendors" actions={<Link className="text-[13px] text-accent hover:underline" href={`${base}/vendors?property=${id}`}>All</Link>} />
              {d.vendors.length === 0 ? <EmptyState title="No vendors approved" /> : (
                <ul className="divide-y divide-border">
                  {d.vendors.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <span><Link className="font-medium hover:underline" href={`${base}/vendors/${v.id}`}>{v.name}</Link><span className="block text-xs text-faint">{v.categories.map(cat).join(", ")}</span></span>
                      {v.status !== "active" ? <Badge tone={VENDOR_STATUS[v.status].tone}>{VENDOR_STATUS[v.status].label}</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
