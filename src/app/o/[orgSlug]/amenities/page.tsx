import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listAmenities, toRules } from "@/server/modules/amenities/service";
import { describeRules } from "@/server/modules/amenities/rules";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { AMENITY_KIND } from "@/lib/community-labels";

export const metadata = { title: "Amenities" };

export default async function AmenitiesPage({ params }: PageProps<"/o/[orgSlug]/amenities">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const p = principal;
  if (!["amenity.read", "amenity.manage", "booking.manage"].some((x) => p.permissions.has(x))) notFound();
  const staff = p.role.category === "staff";
  const rows = await listAmenities(ctx, { includeInactive: true });
  const base = `/o/${orgSlug}/amenities`;
  if (!staff) {
    return (
      <>
        <PageHeader title="Book an amenity" description="Shared spaces in your building." actions={<LinkButton variant="secondary" href={`${base}/bookings`}>My bookings</LinkButton>} />
        {rows.length === 0 ? <Panel><EmptyState title="No bookable amenities yet" /></Panel> : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map(({ a, buildingName }) => (
              <li key={a.id}>
                <Link href={`${base}/${a.id}`} className="block h-full rounded-[var(--radius-lg)] border border-border bg-surface p-4 hover:border-border-strong focus-visible:outline-2">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium">{a.name}</h2>
                    <Badge>{AMENITY_KIND[a.kind] ?? a.kind}</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">{[a.location, buildingName].filter(Boolean).join(" · ") || "Shared amenity"}</p>
                  <ul className="mt-3 space-y-0.5 text-[13px] text-muted">{describeRules(toRules(a)).slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                  <p className="mt-3 text-[13px] font-medium text-accent">See availability →</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <>
      <PageHeader title="Amenities" description="Bookable spaces, their rules and what's coming up."
        actions={<div className="flex flex-wrap gap-2">
          {p.permissions.has("booking.manage") ? <LinkButton variant="secondary" href={`${base}/calendar`}>Calendar</LinkButton> : null}
          <LinkButton variant="secondary" href={`${base}/bookings`}>Bookings</LinkButton>
          {p.permissions.has("amenity.manage") ? <LinkButton href={`${base}/new`}>New amenity</LinkButton> : null}
        </div>} />
      <Panel>
        {rows.length === 0 ? <EmptyState title="No amenities yet" /> : (
          <Table>
            <thead><tr><Th>Amenity</Th><Th className="hidden md:table-cell">Rules</Th><Th className="text-right">Upcoming</Th><Th className="text-right">Pending</Th><Th>Status</Th></tr></thead>
            <tbody>
              {rows.map(({ a, propertyName, buildingName, upcoming, pending }) => (
                <tr key={a.id} className="hover:bg-subtle/60">
                  <Td><Link className="font-medium hover:underline" href={`${base}/${a.id}`}>{a.name}</Link><div className="text-xs text-faint">{[propertyName, buildingName, AMENITY_KIND[a.kind]].filter(Boolean).join(" · ")}</div></Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{[a.requiresApproval ? "Approval" : "Instant", a.maxConcurrent > 1 ? `Shared ×${a.maxConcurrent}` : "Exclusive", a.feeCents ? "Fee" : null, a.depositCents ? "Deposit" : null].filter(Boolean).join(" · ")}</Td>
                  <Td className="text-right tabular-nums">{upcoming}</Td>
                  <Td className="text-right tabular-nums">{pending ? <Link className="font-medium text-warning hover:underline" href={`${base}/bookings?view=pending&amenity=${a.id}`}>{pending}</Link> : <span className="text-faint">0</span>}</Td>
                  <Td>{a.active ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
