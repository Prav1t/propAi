import Link from "next/link";
import type { TenantCtx } from "@/server/modules/context";
import type { Principal } from "@/server/authz/authorize";
import { listMyUnits } from "@/server/modules/organizations/service";
import { myPropertyInfo } from "@/server/modules/portfolio/service";
import { canListWorkOrders, listWorkOrders } from "@/server/modules/maintenance/service";
import { canUsePackages, listPackages } from "@/server/modules/packages/service";
import { listBookings } from "@/server/modules/amenities/service";
import { announcementFeed } from "@/server/modules/announcements/service";
import { canUseMessages, listThreads } from "@/server/modules/messaging/service";
import { canUseDocuments, listDocuments } from "@/server/modules/documents/service";
import { canInviteVisitors, myUpcomingGuests } from "@/server/modules/visitors/service";
import { fmtRange } from "@/lib/time";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { WoMiniList } from "@/components/ops/wo-mini-list";
import { Icon } from "@/components/shell/icons";
import { BOOKING_STATUS, DOCUMENT_CATEGORY } from "@/lib/community-labels";
import { relative } from "@/lib/time";
import { cn } from "@/lib/cn";

const More = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="text-[13px] text-accent hover:underline">{children}</Link>;

// mobile-first home for residents: what needs attention first, then quick actions, then the rest
export async function ResidentHome({ ctx, principal: p, first, base }: { ctx: TenantCtx; principal: Principal & { orgName: string; orgTimezone: string }; first: string; base: string }) {
  const [units, props, reqs, pkgs, bookings, news, threads, docs, guests] = await Promise.all([
    listMyUnits(ctx), myPropertyInfo(ctx),
    canListWorkOrders(p) ? listWorkOrders(ctx, { view: "open", pageSize: 3 }) : null,
    canUsePackages(p) ? listPackages(ctx, { view: "waiting", pageSize: 5 }) : null,
    p.permissions.has("amenity.read") ? listBookings(ctx, { view: "upcoming", pageSize: 3 }) : null,
    announcementFeed(ctx, { limit: 3 }),
    canUseMessages(p) ? listThreads(ctx, { view: "all" }) : null,
    canUseDocuments(p) ? listDocuments(ctx, { importantOnly: true, pageSize: 4 }) : null,
    canInviteVisitors(p) ? myUpcomingGuests(ctx) : null,
  ]);
  const unreadThreads = threads?.rows.filter((t) => t.unread && t.lastFromStaff) ?? [];
  const actions = [
    p.permissions.has("workorder.create") && units.length ? { href: `${base}/maintenance/new`, icon: "wrench", label: "Report a problem" } : null,
    p.permissions.has("booking.create") ? { href: `${base}/amenities`, icon: "calendar", label: "Book an amenity" } : null,
    canUseMessages(p) ? { href: `${base}/messages/new`, icon: "message", label: "Message management" } : null,
    canInviteVisitors(p) ? { href: `${base}/visitors/new`, icon: "badge", label: "Invite a guest" } : canUseDocuments(p) ? { href: `${base}/documents`, icon: "file", label: "Building documents" } : null,
  ].filter(Boolean) as { href: string; icon: string; label: string }[];
  const tz = p.orgTimezone;
  return (
    <>
      <PageHeader title={`Hi ${first}`} description={units.length ? units.map((u) => `Unit ${u.number} · ${u.building}, ${u.property}`).join(" / ") : p.orgName} />
      {units.length === 0 ? <Panel className="mb-6"><EmptyState title="No unit linked yet">Your building manager hasn&apos;t linked your account to a unit. Contact them to get set up.</EmptyState></Panel> : null}

      {pkgs && pkgs.total ? (
        <Link href={`${base}/packages`} className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-accent/30 bg-accent-soft px-4 py-3">
          <span className="flex min-w-0 items-center gap-3"><Icon name="box" className="size-5 shrink-0 text-accent" />
            <span className="min-w-0"><span className="block text-sm font-medium">{pkgs.total} package{pkgs.total === 1 ? "" : "s"} waiting at the front desk</span>
              <span className="block text-[13px] text-muted">Pickup code{pkgs.rows.length > 1 ? "s" : ""}: <span className="font-mono font-semibold tracking-wider text-fg">{pkgs.rows.map((k) => k.pickupCode).join(", ")}</span></span></span>
          </span>
          <span aria-hidden className="text-accent">→</span>
        </Link>
      ) : null}
      {unreadThreads.length ? (
        <Link href={`${base}/messages/${unreadThreads[0].id}`} className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3 hover:border-border-strong">
          <span className="flex min-w-0 items-center gap-3"><Icon name="message" className="size-5 shrink-0 text-accent" />
            <span className="min-w-0"><span className="block text-sm font-medium">New reply from management{unreadThreads.length > 1 ? ` (+${unreadThreads.length - 1} more)` : ""}</span>
              <span className="block truncate text-[13px] text-muted">{unreadThreads[0].subject}: {unreadThreads[0].lastMessagePreview}</span></span>
          </span>
          <span aria-hidden className="text-accent">→</span>
        </Link>
      ) : null}

      {actions.length ? (
        <nav aria-label="Quick actions" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {actions.map((a) => (
            <Link key={a.href} href={a.href} className="flex flex-col items-start gap-2 rounded-[var(--radius-lg)] border border-border bg-surface p-3 hover:border-border-strong focus-visible:outline-2">
              <Icon name={a.icon} className="size-5 text-accent" /><span className="text-sm font-medium">{a.label}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel>
          <PanelHeader title="Announcements" actions={<More href={`${base}/announcements`}>All</More>} />
          {news.length === 0 ? <EmptyState title="No announcements" /> : (
            <ul className="divide-y divide-border">
              {news.map((a) => (
                <li key={a.id}>
                  <Link href={`${base}/announcements/${a.id}`} className="block px-4 py-2.5 hover:bg-subtle/60">
                    <span className="flex items-center gap-2">{!a.read ? <span className="size-2 rounded-full bg-accent" aria-label="Unread" /> : null}
                      <span className={cn("truncate text-sm", !a.read && "font-semibold")}>{a.title}</span>{a.category === "emergency" ? <Badge tone="danger">Urgent</Badge> : null}</span>
                    <span className="block truncate text-[13px] text-muted">{a.body}</span>
                    <span className="block text-xs text-faint">{a.publishedAt ? relative(a.publishedAt) : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {reqs ? (
          <Panel>
            <PanelHeader title="Open requests" actions={<More href={`${base}/maintenance`}>All requests</More>} />
            <WoMiniList rows={reqs.rows} base={base} empty="No open requests" showLocation={false} />
          </Panel>
        ) : null}
        {bookings ? (
          <Panel>
            <PanelHeader title="Upcoming bookings" actions={<More href={`${base}/amenities/bookings`}>My bookings</More>} />
            {bookings.rows.length === 0 ? <EmptyState title="Nothing booked" action={<More href={`${base}/amenities`}>Book an amenity</More>} /> : (
              <ul className="divide-y divide-border">
                {bookings.rows.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <Link className="min-w-0" href={`${base}/amenities/bookings/${b.id}`}>
                      <span className="block truncate text-sm font-medium hover:underline">{b.amenityName}</span>
                      <span className="block text-[13px] text-muted">{b.startsAt.toLocaleString("en-CA", { timeZone: b.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    </Link>
                    <Badge tone={BOOKING_STATUS[b.status]?.tone}>{BOOKING_STATUS[b.status]?.label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}
        {guests && guests.length ? (
          <Panel>
            <PanelHeader title="Your guests" actions={<More href={`${base}/visitors`}>All guests</More>} />
            <ul className="divide-y divide-border">
              {guests.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link className="min-w-0" href={`${base}/visitors/${g.id}`}>
                    <span className="block truncate text-sm font-medium hover:underline">{g.name}</span>
                    <span className="block text-[13px] text-muted">{fmtRange(g.expectedFrom, g.expectedUntil, g.tz)}</span>
                  </Link>
                  {g.status === "checked_in" ? <Badge tone="success">Arrived</Badge> : null}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {docs && docs.rows.length ? (
          <Panel>
            <PanelHeader title="Important documents" actions={<More href={`${base}/documents`}>All documents</More>} />
            <ul className="divide-y divide-border">
              {docs.rows.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <Link className="truncate font-medium hover:underline" href={`${base}/documents/${d.id}`}>{d.title}</Link>
                  <span className="shrink-0 text-xs text-faint">{DOCUMENT_CATEGORY[d.category]}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>

      {props.some((x) => x.emergencyPhone || x.emergencyInfo || x.officeHours) ? (
        <Panel className="mt-6">
          <PanelHeader title="Emergencies and contacts" description="If anyone is in danger, call 911 first." />
          <div className="divide-y divide-border">
            {props.map((x) => (
              <div key={x.id} className="space-y-1 px-4 py-3 text-sm">
                {props.length > 1 ? <p className="font-medium">{x.name}</p> : null}
                {x.emergencyPhone ? <p>24/7 building emergency line: <a className="font-medium text-accent hover:underline" href={`tel:${x.emergencyPhone.replace(/[^\d+]/g, "")}`}>{x.emergencyPhone}</a></p> : null}
                {x.officeHours ? <p className="text-muted">Office hours: {x.officeHours}</p> : null}
                {x.emergencyInfo ? <p className="whitespace-pre-line text-[13px] text-muted">{x.emergencyInfo}</p> : null}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      <p className="sr-only">Times shown in {tz}.</p>
    </>
  );
}
