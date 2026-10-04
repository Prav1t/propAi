import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canScheduleShifts, canSeeShifts, listShifts, myShifts, onShiftNow, schedulableStaff, shiftPlaces } from "@/server/modules/shifts/service";
import { overlapHours } from "@/server/modules/shifts/rules";
import { addDays } from "@/server/modules/assets/schedule";
import { SHIFT_POSITIONS } from "@/server/db/schema";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { SchemaForm } from "@/components/ui/schema-form";
import { ActionButton } from "@/components/ops/action-button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SHIFT_POSITION } from "@/lib/facility-labels";
import { zonedParts, zonedToUtc } from "@/lib/time";
import { cancelShiftAction, clockInAction, clockOutAction, createShiftsAction } from "../frontdesk-actions";

export const metadata = { title: "Shifts" };

const time = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export default async function ShiftsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/shifts">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canSeeShifts(principal)) notFound();
  const tz = principal.orgTimezone ?? "America/Vancouver";
  const base = `/o/${orgSlug}/shifts`;
  // the week (Monday–Sunday, org time zone) containing ?week=, default this week
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp(q.week) ?? "") ? sp(q.week)! : zonedParts(new Date(), tz).date;
  const dow = (new Date(`${anchor}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(anchor, -dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const from = zonedToUtc(`${monday}T00:00`, tz);
  const to = zonedToUtc(`${addDays(monday, 7)}T00:00`, tz);
  const propertyId = sp(q.property);
  const manage = canScheduleShifts(principal);
  const [week, now, mine, places, staff] = await Promise.all([
    listShifts(ctx, { from, to, propertyId }), onShiftNow(ctx, { propertyId }), myShifts(ctx), shiftPlaces(ctx), manage ? schedulableStaff(ctx) : Promise.resolve([]),
  ]);
  const people = [...new Map(week.map((s) => [s.membershipId, s.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const dayStart = (d: string) => zonedToUtc(`${d}T00:00`, tz);
  const nowMs = new Date().getTime();
  const current = mine.find((s) => s.startsAt.getTime() - 30 * 60_000 <= nowMs && nowMs < s.endsAt.getTime());
  const nav = (d: string) => `${base}?week=${d}${propertyId ? `&property=${propertyId}` : ""}`;
  return (
    <>
      <PageHeader title="Shifts" description="Who's working, who's on call, and handoffs between shifts."
        actions={<LinkButton href={`${base}/handoff`} variant="secondary">Shift handoff</LinkButton>} />
      <div className="mb-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel>
          <PanelHeader title="On now" />
          {now.length === 0 ? <EmptyState title="Nobody is scheduled right now" /> : (
            <ul className="divide-y divide-border text-sm">{now.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span><span className="font-medium">{s.name}</span> <span className="text-muted">· {SHIFT_POSITION[s.position]} · {s.propertyName}{s.buildingName ? `, ${s.buildingName}` : ""}</span></span>
                <span className="flex items-center gap-2 text-[13px] text-muted">{s.onCall ? <Badge tone="accent">On call</Badge> : null}until {time(s.endsAt, tz)}{s.clockedInAt && !s.clockedOutAt ? <Badge tone="success">Clocked in</Badge> : null}</span>
              </li>
            ))}</ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="My shifts" />
          {mine.length === 0 ? <EmptyState title="No upcoming shifts" /> : (
            <ul className="divide-y divide-border text-sm">{mine.slice(0, 6).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span><span className="font-medium">{s.startsAt.toLocaleDateString("en-CA", { timeZone: s.tz, weekday: "short", month: "short", day: "numeric" })}</span> {time(s.startsAt, s.tz)}–{time(s.endsAt, s.tz)} <span className="text-muted">· {SHIFT_POSITION[s.position]}{s.onCall ? " (on call)" : ""} · {s.propertyName}</span></span>
                {s.id === current?.id ? (s.clockedInAt ? (s.clockedOutAt ? <Badge>Clocked out</Badge> : <ActionButton action={clockOutAction.bind(null, orgSlug, s.id)} label="Clock out" />) : <ActionButton action={clockInAction.bind(null, orgSlug, s.id)} label="Clock in" variant="primary" />) : null}
              </li>
            ))}</ul>
          )}
        </Panel>
      </div>
      <Panel className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Week of {new Date(`${monday}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })}</h2>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <form className="flex items-center gap-2" action={base}>
              <input type="hidden" name="week" value={monday} />
              <label htmlFor="shift-prop" className="sr-only">Property</label>
              <select id="shift-prop" name="property" defaultValue={propertyId ?? ""} className="h-8 rounded-[var(--radius-md)] border border-border-strong bg-surface px-2">
                <option value="">All properties</option>{places.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="h-8 rounded-[var(--radius-md)] border border-border-strong px-2">Show</button>
            </form>
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 hover:bg-subtle" href={nav(addDays(monday, -7))}>← Previous</Link>
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 hover:bg-subtle" href={nav(zonedParts(new Date(), tz).date)}>This week</Link>
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 hover:bg-subtle" href={nav(addDays(monday, 7))}>Next →</Link>
          </div>
        </div>
        {people.length === 0 ? <EmptyState title="No shifts this week" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12px]">
              <caption className="sr-only">Shifts by person and day</caption>
              <thead><tr><th scope="col" className="w-40 border-b border-border px-3 py-2 text-left font-medium text-muted">Person</th>
                {days.map((d) => <th key={d} scope="col" className="border-b border-l border-border px-2 py-2 text-left font-medium text-muted">{new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", day: "numeric" })}</th>)}
                <th scope="col" className="border-b border-l border-border px-2 py-2 text-right font-medium text-muted">Hours</th></tr></thead>
              <tbody>{people.map(([mid, name]) => {
                const theirs = week.filter((s) => s.membershipId === mid);
                const hours = theirs.filter((s) => !s.onCall).reduce((a, s) => a + overlapHours(s, from, to), 0);
                return (
                  <tr key={mid}>
                    <th scope="row" className="border-b border-border px-3 py-2 text-left font-medium">{name}</th>
                    {days.map((d) => {
                      const cell = theirs.filter((s) => s.startsAt >= dayStart(d) && s.startsAt < dayStart(addDays(d, 1)));
                      return (
                        <td key={d} className="border-b border-l border-border px-1.5 py-1.5 align-top">
                          {cell.map((s) => (
                            <div key={s.id} title={`${SHIFT_POSITION[s.position]} · ${s.propertyName}${s.notes ? ` — ${s.notes}` : ""}`}
                              className={`mb-1 rounded px-1.5 py-1 ${s.onCall ? "border border-dashed border-accent/50 text-accent" : "bg-accent-soft text-accent"}`}>
                              {time(s.startsAt, tz)}–{time(s.endsAt, tz)}<span className="block text-[11px] opacity-80">{s.onCall ? "On call" : SHIFT_POSITION[s.position]}</span>
                            </div>
                          ))}
                        </td>
                      );
                    })}
                    <td className="border-b border-l border-border px-2 py-2 text-right tabular-nums">{hours.toFixed(1)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Panel>
      {manage ? (
        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Panel>
            <PanelHeader title="Schedule a shift" description="An end time earlier than the start runs past midnight." />
            <SchemaForm action={createShiftsAction.bind(null, orgSlug)} submitLabel="Schedule" columns={2} className="p-4" fields={[
              { name: "membershipId", label: "Who", type: "select", options: [{ value: "", label: "Choose…" }, ...staff.map((s) => ({ value: s.membershipId, label: `${s.name} — ${s.title ?? s.role}` }))], span: 2 },
              { name: "propertyId", label: "Property", type: "select", options: places.properties.map((p) => ({ value: p.id, label: p.name })), defaultValue: propertyId ?? places.properties[0]?.id },
              { name: "buildingId", label: "Building (optional)", type: "select", options: [{ value: "", label: "Whole property" }, ...places.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
              { name: "position", label: "Position", type: "select", options: SHIFT_POSITIONS.map((p) => ({ value: p, label: SHIFT_POSITION[p] })) },
              { name: "startDate", label: "Date", type: "date", defaultValue: zonedParts(new Date(), tz).date },
              { name: "startTime", label: "Start", type: "time", defaultValue: "07:00" }, { name: "endTime", label: "End", type: "time", defaultValue: "15:00" },
              { name: "endDate", label: "End date (on-call periods)", type: "date" },
              { name: "repeatWeeks", label: "Repeat weekly for", type: "select", options: [0, 1, 2, 3, 4, 6, 8, 12].map((n) => ({ value: String(n), label: n ? `${n} more week${n === 1 ? "" : "s"}` : "Just once" })) },
              { name: "onCall", label: "On call (emergencies are routed to them)", type: "checkbox", span: 2 },
              { name: "notes", label: "Notes", span: 2 },
            ]} />
          </Panel>
          <Panel>
            <PanelHeader title="This week's shifts" />
            {week.length === 0 ? <EmptyState title="Nothing scheduled" /> : (
              <Table>
                <thead><tr><Th>When</Th><Th>Who</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                <tbody>{week.slice(0, 80).map((s) => (
                  <tr key={s.id}>
                    <Td className="text-[13px]">{s.startsAt.toLocaleDateString("en-CA", { timeZone: tz, weekday: "short", day: "numeric" })} {time(s.startsAt, tz)}–{time(s.endsAt, tz)}</Td>
                    <Td className="text-[13px]">{s.name}<div className="text-xs text-faint">{s.onCall ? "On call" : SHIFT_POSITION[s.position]} · {s.propertyName}</div></Td>
                    <Td className="text-right">{s.endsAt > new Date() ? <ConfirmAction action={cancelShiftAction.bind(null, orgSlug, s.id)} label="Cancel" confirmLabel="Cancel shift" variant="secondary" /> : null}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>
        </div>
      ) : null}
    </>
  );
}
