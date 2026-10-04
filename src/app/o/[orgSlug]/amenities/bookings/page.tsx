import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listAmenities, listBookings, type BookingView } from "@/server/modules/amenities/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { BOOKING_STATUS, DEPOSIT_STATUS, FEE_STATUS } from "@/lib/community-labels";

export const metadata = { title: "Bookings" };

const when = (s: Date, e: Date, tz: string) => `${s.toLocaleString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;

export default async function BookingsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/amenities/bookings">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const staff = principal.role.category === "staff";
  if (!staff && !principal.permissions.has("amenity.read")) notFound();
  const views: { key: BookingView; label: string }[] = staff
    ? [{ key: "upcoming", label: "Upcoming" }, { key: "pending", label: "Awaiting approval" }, { key: "past", label: "Past" }, { key: "cancelled", label: "Cancelled & declined" }, { key: "all", label: "All" }]
    : [{ key: "upcoming", label: "Upcoming" }, { key: "past", label: "Past" }, { key: "cancelled", label: "Cancelled" }];
  const view = views.find((v) => v.key === sp(q.view))?.key ?? "upcoming";
  const data = await orNotFound(listBookings(ctx, { view, amenityId: sp(q.amenity), page: Number(sp(q.page)) || 1 }));
  const amenityOpts = staff ? (await listAmenities(ctx, { includeInactive: true })).map(({ a, propertyName }) => ({ value: a.id, label: `${a.name} · ${propertyName}` })) : [];
  const base = `/o/${orgSlug}/amenities`;
  return (
    <>
      <PageHeader title={staff ? "Bookings" : "My bookings"} actions={<LinkButton href={base} variant={staff ? "secondary" : "primary"}>{staff ? "Amenities" : "Book an amenity"}</LinkButton>} />
      <Panel>
        <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: `${base}/bookings?view=${v.key}${sp(q.amenity) ? `&amenity=${sp(q.amenity)}` : ""}`, count: v.key === view ? data.total : null }))} />
        {staff && amenityOpts.length > 1 ? <FilterBar search={false} filters={[{ name: "amenity", label: "Amenity", options: amenityOpts }]} /> : null}
        {data.rows.length === 0 ? <EmptyState title={view === "pending" ? "Nothing waiting for approval" : "No bookings here"} /> : (
          <Table>
            <thead><tr><Th className="w-16">#</Th><Th>Booking</Th>{staff ? <Th className="hidden md:table-cell">Unit</Th> : null}<Th>Status</Th><Th className="hidden lg:table-cell">Payment</Th></tr></thead>
            <tbody>
              {data.rows.map((b) => (
                <tr key={b.id} className="hover:bg-subtle/60">
                  <Td className="tabular-nums text-muted">{b.number}</Td>
                  <Td><Link className="font-medium hover:underline" href={`${base}/bookings/${b.id}`}>{b.amenityName}</Link>
                    <div className="text-xs text-faint">{when(b.startsAt, b.endsAt, b.tz)} · {b.guests} {b.guests === 1 ? "person" : "people"}</div></Td>
                  {staff ? <Td className="hidden text-[13px] text-muted md:table-cell">{b.unitNumber ? `Unit ${b.unitNumber}` : "Staff"}{b.bookedBy ? <span className="block text-xs text-faint">{b.bookedBy}</span> : null}</Td> : null}
                  <Td><Badge tone={BOOKING_STATUS[b.status]?.tone}>{BOOKING_STATUS[b.status]?.label}</Badge></Td>
                  <Td className="hidden text-[13px] text-muted lg:table-cell">{[b.feeCents ? FEE_STATUS[b.feeStatus] : null, b.depositCents ? DEPOSIT_STATUS[b.depositStatus] : null].filter(Boolean).join(" · ") || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/bookings`} params={q} />
      </Panel>
    </>
  );
}
