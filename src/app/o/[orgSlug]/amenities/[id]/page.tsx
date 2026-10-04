import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { dayAvailability, getAmenity } from "@/server/modules/amenities/service";
import { listBuildingOptions, listPropertyOptions } from "@/server/modules/portfolio/service";
import { residentUnitsForRequests } from "@/server/modules/maintenance/service";
import { fmtMinute, localParts, nextDate } from "@/server/modules/amenities/rules";
import { can } from "@/server/authz/authorize";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DayTimeline } from "@/components/community/day-timeline";
import { BookingForm } from "@/components/community/booking-form";
import { AMENITY_KIND, money } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { addBlackoutAction, createBookingAction, deleteBlackoutAction, updateAmenityAction } from "../../community-actions";
import { amenityFields } from "../amenity-fields";

export const metadata = { title: "Amenity" };

const dur = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

export default async function AmenityPage({ params, searchParams }: PageProps<"/o/[orgSlug]/amenities/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getAmenity(ctx, id));
  const a = d.amenity;
  const base = `/o/${orgSlug}`;
  const staff = d.canManageBookings;
  const now = new Date();
  const today = localParts(now, d.tz).date;
  // residents can't book inside the notice period, so open on the first day that has bookable times
  const earliest = staff ? now : new Date(now.getTime() + a.minNoticeHours * 3_600_000);
  const firstDay = localParts(earliest, d.tz).date;
  const requested = sp(q.date);
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= today ? requested : firstDay;
  const av = await dayAvailability(ctx, id, date);

  // start options in slot steps; exclusive amenities grey out times that are already taken
  const starts: { value: string; label: string; disabled?: boolean }[] = [];
  for (let m = a.opensAtMinute; m + a.minDurationMinutes <= a.closesAtMinute; m += a.slotMinutes) {
    const t = new Date(av.window.start.getTime() + (m - a.opensAtMinute) * 60_000);
    const taken = a.maxConcurrent === 1 && av.busy.some((b) => b.start <= t && b.end > t);
    const closed = av.blackouts.some((b) => b.start <= t && b.end > t);
    starts.push({ value: fmtMinute(m), label: `${t.toLocaleTimeString("en-CA", { timeZone: d.tz, hour: "numeric", minute: "2-digit" })}${taken ? " — booked" : closed ? " — closed" : ""}`, disabled: taken || closed || t < earliest });
  }
  const durations: { value: string; label: string }[] = [];
  for (let m = a.minDurationMinutes; m <= a.maxDurationMinutes; m += a.slotMinutes) durations.push({ value: String(m), label: dur(m) });
  const units = staff ? [] : (await residentUnitsForRequests(ctx)).map((u) => ({ value: u.id, label: `Unit ${u.number} · ${u.building}` }));
  const blocks = [
    ...av.busy.map((b) => ({ start: b.start, end: b.end, label: b.mine ? "Your booking" : b.label ?? "Booked", tone: (b.mine ? "mine" : b.status === "requested" ? "pending" : "busy") as "mine" | "pending" | "busy" })),
    ...av.blackouts.map((b) => ({ start: b.start, end: b.end, label: `Closed: ${b.reason}`, tone: "closed" as const })),
  ].sort((x, y) => x.start.getTime() - y.start.getTime());
  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const lastBookable = localParts(new Date(now.getTime() + a.maxAdvanceDays * 86_400_000), d.tz).date;
  const nav = (dd: string) => `${base}/amenities/${id}?date=${dd}`;
  const bookingBuildings = staff && !a.buildingId ? (await listBuildingOptions(ctx)).filter((b) => b.propertyId === a.propertyId).map((b) => ({ value: b.id, label: b.name })) : [];
  const editProps = d.canManage ? (await listPropertyOptions(ctx)).filter((x) => can(principal, "amenity.manage", { orgId: principal.orgId, propertyId: x.id })) : [];
  const editBlds = d.canManage ? (await listBuildingOptions(ctx)).filter((b) => editProps.some((p) => p.id === b.propertyId)) : [];
  const moneyNote = [a.feeCents ? `Fee ${money(a.feeCents)}` : null, a.depositCents ? `refundable deposit ${money(a.depositCents)}` : null].filter(Boolean).join(", ");

  return (
    <>
      <Breadcrumbs items={[{ label: "Amenities", href: `${base}/amenities` }, { label: a.name }]} />
      <PageHeader title={a.name} description={[AMENITY_KIND[a.kind], d.labels?.propertyName, d.labels?.buildingName, a.location].filter(Boolean).join(" · ")}
        actions={!a.active ? <Badge>Not taking bookings</Badge> : a.requiresApproval ? <Badge tone="warning">Approval required</Badge> : <Badge tone="success">Instant booking</Badge>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">{dayLabel}</h2>
              <nav aria-label="Choose a day" className="flex items-center gap-1">
                {date > today ? <Link className="rounded px-2 py-1 text-[13px] hover:bg-subtle" href={nav(nextDate(date, -1))}>← Previous</Link> : null}
                <form action={`${base}/amenities/${id}`} className="flex items-center">
                  <label htmlFor="pick-date" className="sr-only">Date</label>
                  <input id="pick-date" type="date" name="date" defaultValue={date} min={today} max={staff ? undefined : lastBookable} className="h-8 rounded-[var(--radius-md)] border border-border-strong bg-surface px-2 text-[13px]" />
                  <button className="ml-1 h-8 rounded-[var(--radius-md)] border border-border-strong px-2 text-[13px] hover:bg-subtle">Go</button>
                </form>
                <Link className="rounded px-2 py-1 text-[13px] hover:bg-subtle" href={nav(nextDate(date, 1))}>Next →</Link>
              </nav>
            </div>
            <div className="space-y-5 p-4">
              <DayTimeline window={av.window} blocks={blocks} tz={d.tz} />
              {d.canBook && a.active && !starts.some((x) => !x.disabled) ? (
                <p className="rounded-[var(--radius-md)] bg-subtle px-3 py-2 text-[13px]">No bookable times on this day{!staff && a.minNoticeHours ? ` (bookings need ${a.minNoticeHours} hours' notice)` : ""}. <Link className="text-accent hover:underline" href={nav(nextDate(date, 1))}>Try the next day →</Link></p>
              ) : d.canBook && a.active ? (
                <BookingForm action={createBookingAction.bind(null, orgSlug)} amenityId={id} date={date} starts={starts} durations={durations} units={units}
                  staff={staff} capacity={a.capacity} approval={a.requiresApproval} money={moneyNote ? `${moneyNote}.` : null} buildings={bookingBuildings} />
              ) : d.canBook ? null : <p className="text-[13px] text-muted">Your role can&apos;t book amenities. Ask the primary resident of your unit.</p>}
            </div>
          </Panel>
          {d.canManage ? (
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">Edit amenity and rules</summary>
                <div className="border-t border-border p-4"><SchemaForm action={updateAmenityAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save amenity" fields={amenityFields(editProps, editBlds, a)} /></div>
              </details>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Booking rules" />
            <ul className="space-y-1 px-4 py-3 text-[13px]">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
            {a.description || a.rules ? (
              <div className="space-y-2 border-t border-border px-4 py-3 text-[13px]">
                {a.description ? <p className="whitespace-pre-line">{a.description}</p> : null}
                {a.rules ? <><p className="font-medium">House rules</p><p className="whitespace-pre-line text-muted">{a.rules}</p></> : null}
              </div>
            ) : null}
          </Panel>
          {d.canManage || d.canManageBookings ? (
            <Panel>
              <PanelHeader title="Closures" description={`Times in ${d.tz}.`} />
              {d.blackouts.length === 0 ? <p className="px-4 py-3 text-[13px] text-faint">No upcoming closures.</p> : (
                <ul className="divide-y divide-border">
                  {d.blackouts.map((b) => (
                    <li key={b.id} className="flex items-start justify-between gap-2 px-4 py-2 text-[13px]">
                      <span><span className="font-medium">{b.reason}</span><span className="block text-xs text-faint">{fmtDateTime(b.startsAt, d.tz)} – {fmtDateTime(b.endsAt, d.tz)}</span></span>
                      <ConfirmAction action={deleteBlackoutAction.bind(null, orgSlug, b.id)} label="Remove" confirmLabel="Remove" variant="secondary" />
                    </li>
                  ))}
                </ul>
              )}
              <details className="border-t border-border">
                <summary className="cursor-pointer px-4 py-3 text-[13px] text-accent">Add a closure</summary>
                <div className="px-4 pb-4"><SchemaForm action={addBlackoutAction.bind(null, orgSlug, id)} submitLabel="Close amenity" resetOnSuccess fields={[
                  { name: "from", label: "From", type: "datetime-local" }, { name: "to", label: "Until", type: "datetime-local" },
                  { name: "reason", label: "Reason (shown to residents)", placeholder: "Floor refinishing" },
                ]} /></div>
              </details>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
