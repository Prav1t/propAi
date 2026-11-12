import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { leaseUnitOptions, unitOccupantOptions } from "@/server/modules/leases/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { todayIn } from "@/lib/leasing";
import { createLeaseAction } from "../../governance-actions";

export const metadata = { title: "New lease" };
const pick = "mt-1.5 block h-9 w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 text-sm pointer-coarse:h-11";

// three choices narrow in turn (property, then a unit with no lease in force, then someone living there), each by a
// plain link-style form so the page works without scripts; then the terms
export default async function NewLeasePage({ params, searchParams }: PageProps<"/o/[orgSlug]/leases/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("lease.manage")) notFound();
  const props = await listPropertyOptions(ctx);
  const propertyId = props.find((p) => p.id === sp(q.property))?.id ?? (props.length === 1 ? props[0].id : "");
  const unitsFree = propertyId ? await orNotFound(leaseUnitOptions(ctx, propertyId)) : [];
  const unitId = unitsFree.find((u) => u.id === sp(q.unit))?.id ?? "";
  const occ = unitId ? await orNotFound(unitOccupantOptions(ctx, unitId)) : null;
  const here = `/o/${orgSlug}/leases/new`;
  return (
    <>
      <Breadcrumbs items={[{ label: "Leases", href: `/o/${orgSlug}/leases` }, { label: "New" }]} />
      <PageHeader title="New lease" description="Rent is charged for whole months, from the month the lease starts. Nothing is pro-rated." />
      <Panel className="max-w-2xl space-y-5 p-4 sm:p-6">
        <form action={here} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="text-[13px] font-medium"><label htmlFor="lease-property">Property</label>
            <select id="lease-property" name="property" defaultValue={propertyId} className={pick}>
              {props.length === 1 ? null : <option value="">Choose…</option>}
              {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="text-[13px] font-medium"><label htmlFor="lease-unit">Unit</label>
            <select id="lease-unit" name="unit" defaultValue={unitId} className={pick} disabled={!propertyId}>
              <option value="">{propertyId ? (unitsFree.length ? "Choose…" : "Every unit has a lease") : "Choose a property first"}</option>
              {unitsFree.map((u) => <option key={u.id} value={u.id}>{u.number} ({u.buildingName}){u.occupied ? "" : ", nobody recorded"}</option>)}
            </select>
          </div>
          <button className="h-9 rounded-[var(--radius-md)] border border-border-strong px-3 text-[13px] font-medium hover:bg-subtle pointer-coarse:h-11">{propertyId ? "Use this unit" : "Show units"}</button>
        </form>
        {occ ? (
          occ.people.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-border bg-subtle px-3 py-2.5 text-sm">Nobody is recorded as living in unit {occ.unit.number}. Add the tenant under <a className="text-accent underline" href={`/o/${orgSlug}/residents/new`}>Residents</a> first, then come back.</p>
          ) : (
            <SchemaForm action={createLeaseAction.bind(null, orgSlug)} columns={2} submitLabel="Create lease" hidden={{ unitId }} fields={[
              { name: "residentId", label: `Tenant (people living in unit ${occ.unit.number})`, type: "select", span: 2, defaultValue: occ.people[0].id, options: occ.people.map((r) => ({ value: r.id, label: `${r.firstName} ${r.lastName} (${r.relationship})` })) },
              { name: "startsOn", label: "Starts", type: "date", defaultValue: todayIn(principal.orgTimezone ?? "UTC") },
              { name: "endsOn", label: "Ends (leave empty for month to month)", type: "date" },
              { name: "rent", label: "Monthly rent ($)", placeholder: "1850" },
              { name: "deposit", label: "Deposit held ($)", placeholder: "925" },
              { name: "dueDay", label: "Rent due on day of month", type: "number", defaultValue: 1, hint: "1 to 28" },
              { name: "notes", label: "Notes (optional)", type: "textarea", span: 2 },
            ]} />
          )
        ) : null}
      </Panel>
    </>
  );
}
