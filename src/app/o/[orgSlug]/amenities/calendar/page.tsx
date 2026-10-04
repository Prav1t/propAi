import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { bookingCalendar, listAmenities } from "@/server/modules/amenities/service";
import { localParts, nextDate } from "@/server/modules/amenities/rules";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";
import { cn } from "@/lib/cn";

export const metadata = { title: "Booking calendar" };

const HOUR_PX = 28;

// week grid (desktop) + agenda (all sizes); times in the organization's time zone
export default async function CalendarPage({ params, searchParams }: PageProps<"/o/[orgSlug]/amenities/calendar">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("booking.manage") && !principal.permissions.has("amenity.read")) notFound();
  const tz = principal.orgTimezone;
  const today = localParts(new Date(), tz).date;
  const want = sp(q.week) && /^\d{4}-\d{2}-\d{2}$/.test(sp(q.week)!) ? sp(q.week)! : today;
  const dow = new Date(`${want}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = nextDate(want, -((dow + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => nextDate(monday, i));
  const cal = await bookingCalendar(ctx, { from: monday, days: 7, amenityId: sp(q.amenity) });
  const amenities = await listAmenities(ctx, { includeInactive: true });
  const base = `/o/${orgSlug}/amenities`;
  const keep = (week: string) => `${base}/calendar?week=${week}${sp(q.amenity) ? `&amenity=${sp(q.amenity)}` : ""}`;
  const items = [
    ...cal.bookings.map((b) => ({ key: b.id, href: `${base}/bookings/${b.id}`, start: b.startsAt, end: b.endsAt, title: b.amenityName, sub: `${b.unitNumber ? `Unit ${b.unitNumber}` : "Staff"} · ${b.guests}p`, pending: b.status === "requested", closed: false })),
    ...cal.closures.map((c) => ({ key: c.id, href: null, start: c.startsAt, end: c.endsAt, title: `Closed: ${c.amenityName}`, sub: c.reason, pending: false, closed: true })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());
  const fmtT = (d: Date) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const startHour = 6, endHour = 24;
  return (
    <>
      <PageHeader title="Booking calendar" description={`Week of ${label(monday)} · ${tz.replace("_", " ")}`}
        actions={<nav aria-label="Weeks" className="flex gap-1 text-[13px]">
          <Link className="rounded border border-border-strong px-2.5 py-1.5 hover:bg-subtle" href={keep(nextDate(monday, -7))}>← Previous</Link>
          <Link className="rounded border border-border-strong px-2.5 py-1.5 hover:bg-subtle" href={keep(today)}>This week</Link>
          <Link className="rounded border border-border-strong px-2.5 py-1.5 hover:bg-subtle" href={keep(nextDate(monday, 7))}>Next →</Link>
        </nav>} />
      <Panel>
        {amenities.length > 1 ? <FilterBar search={false} filters={[{ name: "amenity", label: "Amenity", options: amenities.map(({ a, propertyName }) => ({ value: a.id, label: `${a.name} · ${propertyName}` })) }]} /> : null}
        <div className="hidden overflow-x-auto lg:block">
          <div className="grid min-w-[900px] grid-cols-[56px_repeat(7,1fr)]">
            <div />
            {days.map((d) => <div key={d} className={cn("border-b border-l border-border px-2 py-2 text-center text-[13px] font-medium", d === today && "text-accent")}>{label(d)}</div>)}
            <div className="relative" style={{ height: (endHour - startHour) * HOUR_PX }}>
              {Array.from({ length: endHour - startHour }, (_, i) => <span key={i} className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-faint" style={{ top: i * HOUR_PX }}>{i ? `${(startHour + i) % 24}:00` : ""}</span>)}
            </div>
            {days.map((d) => {
              const dayItems = items.filter((it) => localParts(it.start, tz).date === d);
              // side-by-side lanes for overlapping items (shared amenities, closures)
              const laneEnds: number[] = [];
              const lane = new Map<string, number>();
              for (const it of dayItems) {
                const i = laneEnds.findIndex((e) => e <= it.start.getTime());
                const at = i === -1 ? laneEnds.length : i;
                laneEnds[at] = it.end.getTime();
                lane.set(it.key, at);
              }
              const lanes = Math.max(1, laneEnds.length);
              return (
                <div key={d} className="relative border-l border-border" style={{ height: (endHour - startHour) * HOUR_PX, backgroundImage: `repeating-linear-gradient(to bottom, var(--color-border) 0, var(--color-border) 1px, transparent 1px, transparent ${HOUR_PX}px)` }}>
                  {dayItems.map((it) => {
                    const s = localParts(it.start, tz).minute / 60, e0 = localParts(new Date(it.end.getTime() - 1), tz);
                    const e = e0.date === d ? (e0.minute + 1) / 60 : 24;
                    const top = Math.max(0, (s - startHour) * HOUR_PX), height = Math.max(18, (Math.min(e, endHour) - Math.max(s, startHour)) * HOUR_PX - 2);
                    const pos = { top, height, left: `calc(${(lane.get(it.key)! / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
                    const cls = cn("absolute overflow-hidden rounded-[4px] px-1.5 py-0.5 text-[11px] leading-tight ring-2 ring-surface",
                      it.closed ? "bg-subtle text-muted" : it.pending ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent");
                    const inner = <><span className="block truncate font-medium">{it.title}</span><span className="block truncate">{fmtT(it.start)} · {it.sub}</span></>;
                    return it.href
                      ? <Link key={it.key} href={it.href} className={cn(cls, "hover:brightness-95")} style={pos} title={`${it.title} ${fmtT(it.start)}–${fmtT(it.end)} · ${it.sub}`}>{inner}</Link>
                      : <div key={it.key} className={cls} style={pos} title={`${it.title} ${fmtT(it.start)}–${fmtT(it.end)}`}>{inner}</div>;
                  })}
                </div>
              );
            })}
          </div>
          <p className="border-t border-border px-4 py-2 text-xs text-faint">Blue: confirmed · amber: awaiting approval · grey: closed. Shows 6:00–24:00; see the agenda for anything earlier.</p>
        </div>
        <div className="lg:border-t lg:border-border">
          <h2 className="px-4 pt-3 text-sm font-semibold">Agenda</h2>
          {items.length === 0 ? <EmptyState title="Nothing booked this week" /> : (
            <ol className="divide-y divide-border">
              {days.map((d) => {
                const its = items.filter((it) => localParts(it.start, tz).date === d);
                if (!its.length) return null;
                return (
                  <li key={d} className="px-4 py-2">
                    <p className="text-[13px] font-medium">{label(d)}</p>
                    <ul className="mt-1 space-y-1">
                      {its.map((it) => (
                        <li key={it.key} className="flex flex-wrap gap-x-3 text-[13px]">
                          <span className="w-44 shrink-0 whitespace-nowrap tabular-nums text-muted">{fmtT(it.start)}–{fmtT(it.end)}</span>
                          {it.href ? <Link className="hover:underline" href={it.href}>{it.title}</Link> : <span>{it.title}</span>}
                          <span className="text-faint">{it.sub}{it.pending ? " · awaiting approval" : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </Panel>
    </>
  );
}
