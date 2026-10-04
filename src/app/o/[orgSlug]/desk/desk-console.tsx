import Link from "next/link";
import type { Principal } from "@/server/authz/authorize";
import type { TenantCtx } from "@/server/modules/context";
import { canManageVisitors, listVisitors, visitorStats } from "@/server/modules/visitors/service";
import { canManagePackages, listPackages, packageStats } from "@/server/modules/packages/service";
import { canUseMessages, listThreads } from "@/server/modules/messaging/service";
import { listBookings } from "@/server/modules/amenities/service";
import { canUseIncidents, listIncidents } from "@/server/modules/incidents/service";
import { canUseTasks, listTasks } from "@/server/modules/tasks/service";
import { canSeeShifts, listHandoffs, myShifts, onShiftNow } from "@/server/modules/shifts/service";
import { canManageParking, parkingStats } from "@/server/modules/parking/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { ActionButton } from "@/components/ops/action-button";
import { PassScanner } from "@/components/frontdesk/pass-scanner";
import { PlateLookup } from "@/components/frontdesk/plate-lookup";
import { SEVERITY } from "@/lib/ops-labels";
import { SHIFT_POSITION, VISITOR_KIND } from "@/lib/facility-labels";
import { relative } from "@/lib/time";
import { ackHandoffAction, checkOutVisitorAction, clockInAction, clockOutAction, lookupPlateAction, scanPassAction } from "../frontdesk-actions";

const time = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const none = <T,>() => Promise.resolve(null as T | null);

// one screen for the desk: arrivals, people on site, packages, questions, bookings, incidents and the shift
export async function DeskConsole({ ctx, principal, orgSlug, title = "Front desk" }: { ctx: TenantCtx; principal: Principal; orgSlug: string; title?: string }) {
  const base = `/o/${orgSlug}`;
  const v = canManageVisitors(principal);
  const [vStats, expected, onSite, pStats, waiting, threads, bookings, incidents, tasks, shiftsNow, mine, handoffs, park] = await Promise.all([
    v ? visitorStats(ctx) : none<Awaited<ReturnType<typeof visitorStats>>>(),
    v ? listVisitors(ctx, { view: "today", pageSize: 8 }) : none<Awaited<ReturnType<typeof listVisitors>>>(),
    v ? listVisitors(ctx, { view: "on_site", pageSize: 8 }) : none<Awaited<ReturnType<typeof listVisitors>>>(),
    canManagePackages(principal) ? packageStats(ctx) : none<Awaited<ReturnType<typeof packageStats>>>(),
    canManagePackages(principal) ? listPackages(ctx, { view: "waiting", pageSize: 5 }) : none<Awaited<ReturnType<typeof listPackages>>>(),
    canUseMessages(principal) && principal.permissions.has("message.manage") ? listThreads(ctx, { view: "awaiting" }) : none<Awaited<ReturnType<typeof listThreads>>>(),
    principal.permissions.has("booking.manage") ? listBookings(ctx, { view: "upcoming", pageSize: 5 }) : none<Awaited<ReturnType<typeof listBookings>>>(),
    canUseIncidents(principal) ? listIncidents(ctx, { view: "open" }) : none<Awaited<ReturnType<typeof listIncidents>>>(),
    canUseTasks(principal) ? listTasks(ctx, { view: "mine" }) : none<Awaited<ReturnType<typeof listTasks>>>(),
    canSeeShifts(principal) ? onShiftNow(ctx) : Promise.resolve([]),
    canSeeShifts(principal) ? myShifts(ctx) : Promise.resolve([]),
    canSeeShifts(principal) ? listHandoffs(ctx, { limit: 1 }) : Promise.resolve([]),
    canManageParking(principal) ? parkingStats(ctx) : none<Awaited<ReturnType<typeof parkingStats>>>(),
  ]);
  const nowMs = new Date().getTime();
  const current = mine.find((s) => s.startsAt.getTime() - 30 * 60_000 <= nowMs && nowMs < s.endsAt.getTime());
  const latest = handoffs[0];
  return (
    <>
      <PageHeader title={title} description={current ? `On shift until ${time(current.endsAt, current.tz)} · ${current.propertyName}` : "Arrivals, packages and questions in one place."}
        actions={<>{v ? <LinkButton href={`${base}/visitors/new`}>Register visitor</LinkButton> : null}{canManagePackages(principal) ? <LinkButton variant="secondary" href={`${base}/packages`}>Log a package</LinkButton> : null}</>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {vStats ? <Stat label="Expected today" value={vStats.expectedToday} sub={`${vStats.nextHours} in the next 4 h`} /> : null}
        {vStats ? <Stat label="Visitors on site" value={vStats.onSite} sub={vStats.overstay ? <span className="text-warning">{vStats.overstay} past their window</span> : undefined} /> : null}
        {pStats ? <Stat label="Packages waiting" value={pStats.waiting} sub={pStats.perishable ? <span className="text-danger">{pStats.perishable} perishable</span> : pStats.overdue ? `${pStats.overdue} over 7 days` : undefined} /> : null}
        {threads ? <Stat label="Messages needing reply" value={<span className={threads.total ? "text-warning" : undefined}>{threads.total}</span>} /> : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-6 lg:col-span-2">
          {v ? (
            <Panel>
              <PanelHeader title="Check a guest in" />
              <div className="p-4"><PassScanner action={scanPassAction.bind(null, orgSlug)} /></div>
            </Panel>
          ) : null}
          {expected ? (
            <Panel>
              <PanelHeader title="Expected" actions={<Link href={`${base}/visitors`} className="text-[13px] text-accent hover:underline">All visitors</Link>} />
              {expected.rows.length === 0 ? <EmptyState title="Nobody else expected today" /> : (
                <ul className="divide-y divide-border">{expected.rows.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0"><Link href={`${base}/visitors/${x.id}`} className="font-medium hover:underline">{x.name}</Link> <span className="text-[13px] text-muted">· {x.unitNumber ? `Unit ${x.unitNumber}` : VISITOR_KIND[x.kind]} · from {time(x.expectedFrom, x.tz)}{x.needsParking ? " · parking" : ""}</span></span>
                    <Link href={`${base}/visitors/${x.id}`} className="text-[13px] font-medium text-accent hover:underline">Check in</Link>
                  </li>
                ))}</ul>
              )}
            </Panel>
          ) : null}
          {onSite ? (
            <Panel>
              <PanelHeader title="On site" />
              {onSite.rows.length === 0 ? <EmptyState title="No visitors on site" /> : (
                <ul className="divide-y divide-border">{onSite.rows.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0"><Link href={`${base}/visitors/${x.id}`} className="font-medium hover:underline">{x.name}</Link> <span className="text-[13px] text-muted">· {x.unitNumber ? `Unit ${x.unitNumber}` : VISITOR_KIND[x.kind]} · in since {x.checkedInAt ? time(x.checkedInAt, x.tz) : "—"}</span>{x.overstay ? <Badge tone="warning" className="ml-2">Past window</Badge> : null}</span>
                    <ActionButton action={checkOutVisitorAction.bind(null, orgSlug, x.id)} label="Check out" />
                  </li>
                ))}</ul>
              )}
            </Panel>
          ) : null}
          <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
            {waiting ? (
              <Panel>
                <PanelHeader title="Packages waiting" actions={<Link href={`${base}/packages`} className="text-[13px] text-accent hover:underline">Open</Link>} />
                {waiting.rows.length === 0 ? <EmptyState title="Shelf is empty" /> : (
                  <ul className="divide-y divide-border text-[13px]">{waiting.rows.map((k) => (
                    <li key={k.id} className="flex justify-between gap-2 px-4 py-2"><Link className="hover:underline" href={`${base}/packages/${k.id}`}>Unit {k.unitNumber} · {k.recipientName ?? "Resident"}</Link><span className="text-muted">{relative(k.receivedAt).replace(" ago", "")}{k.perishable ? " · perishable" : ""}</span></li>
                  ))}</ul>
                )}
              </Panel>
            ) : null}
            {threads ? (
              <Panel>
                <PanelHeader title="Needs a reply" actions={<Link href={`${base}/messages?view=awaiting`} className="text-[13px] text-accent hover:underline">Inbox</Link>} />
                {threads.rows.length === 0 ? <EmptyState title="All caught up" /> : (
                  <ul className="divide-y divide-border text-[13px]">{threads.rows.slice(0, 5).map((t) => (
                    <li key={t.id} className="px-4 py-2"><Link className="font-medium hover:underline" href={`${base}/messages/${t.id}`}>{t.subject}</Link><span className="block truncate text-muted">{t.residentName}{t.unitNumber ? ` · ${t.unitNumber}` : ""} · {relative(t.lastMessageAt)}</span></li>
                  ))}</ul>
                )}
              </Panel>
            ) : null}
            {bookings ? (
              <Panel>
                <PanelHeader title="Upcoming bookings" />
                {bookings.rows.length === 0 ? <EmptyState title="No upcoming bookings" /> : (
                  <ul className="divide-y divide-border text-[13px]">{bookings.rows.map((b) => (
                    <li key={b.id} className="flex justify-between gap-2 px-4 py-2"><Link className="hover:underline" href={`${base}/amenities/bookings/${b.id}`}>{b.amenityName}{b.unitNumber ? ` · ${b.unitNumber}` : ""}</Link><span className="text-muted">{b.startsAt.toLocaleString("en-CA", { timeZone: b.tz, weekday: "short", hour: "numeric", minute: "2-digit" })}</span></li>
                  ))}</ul>
                )}
              </Panel>
            ) : null}
            {incidents ? (
              <Panel>
                <PanelHeader title="Open incidents" actions={principal.permissions.has("incident.create") ? <Link href={`${base}/incidents/new`} className="text-[13px] text-accent hover:underline">Report</Link> : null} />
                {incidents.rows.length === 0 ? <EmptyState title="No open incidents" /> : (
                  <ul className="divide-y divide-border text-[13px]">{incidents.rows.slice(0, 5).map((i) => (
                    <li key={i.id} className="flex justify-between gap-2 px-4 py-2"><Link className="hover:underline" href={`${base}/incidents/${i.id}`}>#{i.number} {i.title}</Link><Badge tone={SEVERITY[i.severity]?.tone}>{SEVERITY[i.severity]?.label}</Badge></li>
                  ))}</ul>
                )}
              </Panel>
            ) : null}
          </div>
        </div>
        <div className="space-y-6">
          {canSeeShifts(principal) ? (
            <Panel>
              <PanelHeader title="Shift" actions={<Link href={`${base}/shifts`} className="text-[13px] text-accent hover:underline">Schedule</Link>} />
              <div className="space-y-3 p-4 text-[13px]">
                {current ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Your shift: {time(current.startsAt, current.tz)}–{time(current.endsAt, current.tz)}</span>
                    {current.clockedInAt ? (current.clockedOutAt ? <Badge>Clocked out</Badge> : <ActionButton action={clockOutAction.bind(null, orgSlug, current.id)} label="Clock out" />) : <ActionButton action={clockInAction.bind(null, orgSlug, current.id)} label="Clock in" variant="primary" />}
                  </div>
                ) : <p className="text-muted">You&apos;re not scheduled right now.</p>}
                <div>
                  <p className="mb-1 font-medium">On now</p>
                  {shiftsNow.length === 0 ? <p className="text-muted">Nobody scheduled.</p> : <ul className="space-y-0.5">{shiftsNow.map((s) => <li key={s.id}>{s.name} <span className="text-muted">· {s.onCall ? "on call" : SHIFT_POSITION[s.position]}</span></li>)}</ul>}
                </div>
                <div className="border-t border-border pt-3">
                  <p className="mb-1 font-medium">Last handoff</p>
                  {latest ? (
                    <>
                      <p className="text-muted">{latest.authorName ?? "Previous shift"} · {relative(latest.createdAt)}</p>
                      <p className="mt-1 line-clamp-4 whitespace-pre-line">{latest.notes}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {latest.acknowledgedAt ? <Badge tone="success">Acknowledged</Badge> : !latest.mine ? <ActionButton action={ackHandoffAction.bind(null, orgSlug, latest.id)} label="Acknowledge" /> : <Badge>Waiting for next shift</Badge>}
                        <Link href={`${base}/shifts/handoff`} className="text-accent hover:underline">Write handoff</Link>
                      </div>
                    </>
                  ) : <Link href={`${base}/shifts/handoff`} className="text-accent hover:underline">Write the first handoff</Link>}
                </div>
              </div>
            </Panel>
          ) : null}
          {park ? (
            <Panel>
              <PanelHeader title="Parking" actions={<Link href={`${base}/parking`} className="text-[13px] text-accent hover:underline">Open</Link>} />
              <div className="space-y-3 p-4">
                <p className="text-[13px]">{park.visitorFree} of {park.visitor} visitor spaces free{park.review ? <> · <Link className="font-medium text-warning hover:underline" href={`${base}/parking`}>{park.review} report{park.review === 1 ? "" : "s"} to review</Link></> : null}</p>
                <PlateLookup action={lookupPlateAction.bind(null, orgSlug)} base={base} />
              </div>
            </Panel>
          ) : null}
          {tasks ? (
            <Panel>
              <PanelHeader title="My tasks" />
              {tasks.rows.length === 0 ? <EmptyState title="No open tasks" /> : (
                <ul className="divide-y divide-border text-[13px]">{tasks.rows.slice(0, 6).map((t) => <li key={t.id} className="px-4 py-2"><Link className="hover:underline" href={`${base}/tasks/${t.id}`}>{t.title}</Link>{t.overdue ? <span className="ml-2 text-warning">overdue</span> : null}</li>)}</ul>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
