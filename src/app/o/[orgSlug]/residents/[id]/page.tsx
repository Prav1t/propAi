import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getResident } from "@/server/modules/people/service";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { opts, RELATIONSHIP_LABEL } from "@/lib/labels";
import { addOccupancyAction, deleteResidentAction, endOccupancyAction, inviteResidentAction, updateResidentAction } from "../../portfolio-actions";

export const metadata = { title: "Resident" };

export default async function ResidentPage({ params }: PageProps<"/o/[orgSlug]/residents/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getResident(ctx, id));
  const r = d.resident;
  const base = `/o/${orgSlug}`;
  const today = new Date().toISOString().slice(0, 10);
  const buildings = d.canManage ? await listBuildingOptions(ctx) : [];
  return (
    <>
      <Breadcrumbs items={[{ label: "Residents", href: `${base}/residents` }, { label: `${r.firstName} ${r.lastName}` }]} />
      <PageHeader title={`${r.firstName} ${r.lastName}`} description={d.occupancies.filter((o) => o.active).map((o) => `Unit ${o.unitNumber}, ${o.buildingName} · ${o.propertyName}`).join(" · ") || "No current unit"} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Units" description="Current and past occupancy." />
            {d.occupancies.length === 0 ? <EmptyState title="No units on record" /> : (
              <ul className="divide-y divide-border">
                {d.occupancies.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium"><Link className="hover:underline" href={`${base}/units/${o.unitId}`}>Unit {o.unitNumber}</Link> <span className="font-normal text-muted">· {o.buildingName} · {o.propertyName}</span></p>
                      <p className="text-xs text-faint">{RELATIONSHIP_LABEL[o.relationship]}{o.isPrimary ? " · primary" : ""} · {o.startsOn ?? "?"} → {o.endsOn ?? "present"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {o.active ? <Badge tone="success">Current</Badge> : <Badge>Moved out</Badge>}
                      {o.active && d.canManage ? (
                        <details className="relative">
                          <summary className="cursor-pointer list-none rounded px-2 py-1 text-[13px] text-accent hover:bg-subtle">Move out</summary>
                          <div className="absolute right-0 z-20 mt-1 w-64 rounded-[var(--radius-lg)] border border-border bg-surface p-3 shadow-lg">
                            <SchemaForm action={endOccupancyAction.bind(null, orgSlug, o.id)} submitLabel="Record move-out" fields={[{ name: "endsOn", label: "Move-out date", type: "date", defaultValue: today }]} />
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {d.canManage ? (
            <Panel>
              <PanelHeader title="Record a move-in" description="Add this person to another unit (e.g. an owner of two units)." />
              <div className="p-4">
                <SchemaForm action={addOccupancyAction.bind(null, orgSlug, id)} columns={2} submitLabel="Record move-in" fields={[
                  { name: "buildingId", label: "Building", type: "select", options: [{ value: "", label: "Choose…" }, ...buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
                  { name: "unitNumber", label: "Unit number" },
                  { name: "relationship", label: "Relationship", type: "select", options: opts(RELATIONSHIP_LABEL), defaultValue: "owner" },
                  { name: "startsOn", label: "Move-in date", type: "date", defaultValue: today },
                  { name: "isPrimary", label: "Primary contact for this unit", type: "checkbox", span: 2 },
                ]} />
              </div>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Resident app" />
            <div className="space-y-3 p-4 text-sm">
              {r.userId ? <p><Badge tone="success">Active</Badge> <span className="text-muted">Signs in as {r.email}</span></p>
                : d.pendingInvite ? <p><Badge tone="accent">Invited</Badge> <span className="text-muted">expires {d.pendingInvite.expiresAt.toLocaleDateString("en-CA")}</span></p>
                : <p className="text-muted">Not invited yet.</p>}
              {!r.userId && d.canManage ? (
                r.email ? <ConfirmAction action={inviteResidentAction.bind(null, orgSlug, id)} label={d.pendingInvite ? "Resend invitation" : "Invite to resident app"} confirmLabel="Send invitation" variant="secondary" description={`We'll email ${r.email} a link to set up their account.`} />
                  : <p className="text-xs text-faint">Add an email address to invite them.</p>
              ) : null}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Contact" />
            {d.canManage ? (
              <div className="space-y-4 p-4">
                <SchemaForm action={updateResidentAction.bind(null, orgSlug, id)} submitLabel="Save" fields={[
                  { name: "firstName", label: "First name", defaultValue: r.firstName },
                  { name: "lastName", label: "Last name", defaultValue: r.lastName },
                  { name: "email", label: "Email", type: "email", defaultValue: r.email },
                  { name: "phone", label: "Phone", type: "tel", defaultValue: r.phone },
                  { name: "notes", label: "Notes", type: "textarea", defaultValue: r.notes },
                ]} />
                <ConfirmAction action={deleteResidentAction.bind(null, orgSlug, id)} label="Delete resident…" confirmLabel="Delete" requireText="DELETE"
                  description="Removes this person, their occupancy history and any resident app access." />
              </div>
            ) : (
              <DetailList items={[["Email", r.email], ["Phone", r.phone], ["Notes", r.notes]]} />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
