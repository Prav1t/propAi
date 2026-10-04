import "server-only";
import { z } from "zod";
import { dayAvailability, getAmenity, listBookings, previewBooking, type BookingView } from "../../modules/amenities/service";
import { listPackages, type PackageView } from "../../modules/packages/service";
import { announcementFeed } from "../../modules/announcements/service";
import { ValidationError } from "../../modules/context";
import { ForbiddenError, NotFoundError } from "../../authz/authorize";
import { BOOKING_STATUS, PACKAGE_STATUS, money } from "@/lib/community-labels";
import { anyPerm, defineTool, err, ok, plural } from "./registry";
import { ago, dateArg, dayEnd, dayStart, fmtDay, fmtWhen, lim, limitArg, locationArg, placeFilter, stop, where } from "./common";
import { isErr, resolveAmenity, resolveUnit } from "./resolve";

const time = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });

export const checkAmenityAvailability = defineTool({
  name: "check_amenity_availability",
  title: "Checking availability and booking rules",
  description:
    "For one amenity on one date: opening hours, existing bookings and blackouts, the amenity's rules, and — when a start time is given — " +
    "whether that exact slot would be accepted under the rules for this user (approval needed, fee, deposit, any problems). Nothing is booked.",
  input: z.object({
    amenity: z.string().trim().min(2).max(80).describe("Amenity name or type, e.g. 'party room', 'gym'."),
    date: dateArg.describe("YYYY-MM-DD in the property's time zone."),
    start: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).").optional().describe("Start time HH:MM, 24-hour."),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    guests: z.number().int().min(1).max(10_000).optional(),
    unit: z.string().trim().max(20).optional().describe("Staff booking on behalf of a unit: the unit number."),
    location: locationArg,
  }),
  available: anyPerm("amenity.read", "booking.create", "booking.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const am = await resolveAmenity(ctx, a.amenity, pf.place);
    if (isErr(am)) return { result: am };
    const info = await getAmenity(ctx, am.id);
    const tz = info.tz;
    const day = await dayAvailability(ctx, am.id, a.date);
    const rule = info.amenity;
    const exclusive = rule.maxConcurrent === 1;
    const busy = day.busy.map((b) => ({ from: time(b.start, tz), to: time(b.end, tz), status: b.status, ...(b.mine ? { yours: true } : {}), ...(b.label ? { who: b.label } : {}) }));
    const blackouts = day.blackouts.map((b) => ({ from: fmtWhen(b.start, { ...env, timeZone: tz }), to: fmtWhen(b.end, { ...env, timeZone: tz }), reason: b.reason }));
    // free gaps only make sense when one booking takes the whole space
    const free: { from: string; to: string }[] = [];
    if (exclusive) {
      let cursor = day.window.start.getTime();
      const taken = [...day.busy.map((b) => ({ s: b.start.getTime(), e: b.end.getTime() })), ...day.blackouts.map((b) => ({ s: b.start.getTime(), e: b.end.getTime() }))].sort((x, y) => x.s - y.s);
      for (const t of taken) {
        if (t.s > cursor) free.push({ from: time(new Date(cursor), tz), to: time(new Date(Math.min(t.s, day.window.end.getTime())), tz) });
        cursor = Math.max(cursor, t.e);
      }
      if (cursor < day.window.end.getTime()) free.push({ from: time(new Date(cursor), tz), to: time(day.window.end, tz) });
    }
    let slot: Record<string, unknown> | null = null;
    let slotLine = "";
    if (a.start) {
      const duration = a.durationMinutes ?? Math.min(Math.max(60, rule.minDurationMinutes), rule.maxDurationMinutes);
      try {
        const pv = await previewBooking(ctx, {
          amenityId: am.id, date: a.date, start: a.start, durationMinutes: duration, guests: a.guests ?? 1, purpose: null,
          unitId: null, unitNumber: a.unit ?? null, buildingId: null,
        });
        const d = pv.decision;
        slot = {
          from: time(pv.start, tz), to: time(pv.end, tz), wouldBeAccepted: d.ok, problems: d.problems.map((x) => x.message),
          needsApproval: d.ok && d.status === "requested", feeDue: d.feeCents ? money(d.feeCents) : null, depositDue: d.depositCents ? money(d.depositCents) : null,
        };
        const when = `${fmtDay(a.date, env)}, ${time(pv.start, tz)}–${time(pv.end, tz)}`;
        slotLine = d.ok
          ? `${stop(`${am.name} is available ${when}`)}${d.status === "requested" ? " Bookings need management approval." : ""}${d.feeCents ? ` Fee ${money(d.feeCents)}.` : ""}${d.depositCents ? ` Deposit ${money(d.depositCents)}.` : ""}`
          : `${am.name} can't be booked ${when}: ${d.problems.map((x) => x.message).join(" ")}`;
      } catch (e) {
        if (!(e instanceof ValidationError || e instanceof ForbiddenError || e instanceof NotFoundError)) throw e;
        slot = { wouldBeAccepted: false, problems: [e.message] };
        slotLine = `That slot can't be booked by you: ${e.message}`;
      }
    }
    const opens = `${time(day.window.start, tz)}–${time(day.window.end, tz)}`;
    const summary = slotLine || `${am.label} on ${fmtDay(a.date, env)}: open ${opens}, ${plural(busy.length, "booking")}${blackouts.length ? `, ${plural(blackouts.length, "blackout")}` : ""}.`;
    const highlights = [
      ...(slotLine ? [`Open ${opens} on ${fmtDay(a.date, env)}; ${plural(busy.length, "existing booking")}.`] : []),
      ...(exclusive && free.length ? [`Free: ${free.map((f) => `${f.from}–${f.to}`).join(", ")}`] : exclusive ? ["No free time left that day."] : []),
      ...blackouts.map((b) => `Closed ${b.from} – ${b.to}: ${b.reason}`),
      ...info.rules.slice(0, 4),
      `[See ${am.name}](${env.href(`/amenities/${am.id}`)})`,
    ];
    return {
      result: ok(summary, {
        facts: { amenity: am.label, href: env.href(`/amenities/${am.id}`), date: a.date, timeZone: tz, opens, exclusive, capacityAtOnce: rule.maxConcurrent, bookings: busy, blackouts, free: exclusive ? free : undefined, requestedSlot: slot, rules: info.rules },
        highlights,
      }),
      display: {
        records: [{ ref: "Amenity", title: am.label, href: env.href(`/amenities/${am.id}`), sub: `${fmtDay(a.date, env)} · open ${opens}`,
          badges: slot ? [slot.wouldBeAccepted ? { label: slot.needsApproval ? "Available · needs approval" : "Available", tone: "success" as const } : { label: "Not available", tone: "danger" as const }] : [] }],
        metrics: [{ label: "Bookings that day", value: String(busy.length) }, ...(exclusive ? [{ label: "Free windows", value: String(free.length) }] : [])],
      },
    };
  },
});

export const searchBookings = defineTool({
  name: "search_bookings",
  title: "Looking up bookings",
  description: "Amenity bookings the user can see (residents: their own unit's; staff: their properties). Optionally for one amenity or one date.",
  input: z.object({
    view: z.enum(["upcoming", "pending", "past", "cancelled", "all"]).optional().describe("Default 'upcoming'. 'pending' = waiting for approval."),
    amenity: z.string().trim().max(80).optional(),
    date: dateArg.optional().describe("Only bookings overlapping this date (YYYY-MM-DD)."),
    location: locationArg,
    limit: limitArg,
  }),
  available: anyPerm("booking.create", "booking.manage", "amenity.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    let amenityId: string | undefined;
    if (a.amenity) {
      const am = await resolveAmenity(ctx, a.amenity, pf.place);
      if (isErr(am)) return { result: am };
      amenityId = am.id;
    }
    const view = (a.date ? a.view ?? "all" : a.view ?? "upcoming") as BookingView;
    const page = await listBookings(ctx, { view, amenityId, propertyId: pf.propertyId, buildingId: pf.buildingId, from: a.date ? dayStart(a.date, env) : undefined, to: a.date ? dayEnd(a.date, env) : undefined, pageSize: lim(a.limit) });
    const staff = ctx.principal.role.category === "staff";
    const items = page.rows.map((b) => ({
      ref: `#${b.number}`, id: b.id, amenity: b.amenityName, property: b.propertyName, unit: staff ? b.unitNumber : undefined, when: `${fmtDay(b.startsAt, { ...env, timeZone: b.tz })}, ${time(b.startsAt, b.tz)}–${time(b.endsAt, b.tz)}`,
      status: b.status, guests: b.guests, bookedBy: staff ? b.bookedBy : undefined, feeStatus: b.feeStatus, depositStatus: b.depositStatus, href: env.href(`/amenities/bookings/${b.id}`),
    }));
    const noun = view === "pending" ? "booking waiting for approval" : view === "all" ? "booking" : `${view} booking`;
    return {
      result: ok(page.total ? `${plural(page.total, noun, noun.replace("booking", "bookings"))}${a.date ? ` on ${fmtDay(a.date, env)}` : ""}${where(pf.place)}.` : `No ${noun.replace("booking", "bookings")}${a.date ? ` on ${fmtDay(a.date, env)}` : ""}${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((b) => `${b.amenity} — ${b.when}${b.unit ? ` · Unit ${b.unit}` : ""} · ${BOOKING_STATUS[b.status]?.label ?? b.status}`),
      }),
      display: { records: items.map((b) => ({ ref: b.ref, title: b.amenity, href: b.href, sub: [b.when, b.unit ? `Unit ${b.unit}` : null, b.property].filter(Boolean).join(" · "),
        badges: [{ label: BOOKING_STATUS[b.status]?.label ?? b.status, tone: BOOKING_STATUS[b.status]?.tone ?? "neutral" }] })) },
    };
  },
});

export const searchPackages = defineTool({
  name: "search_packages",
  title: "Checking packages",
  description: "Packages at the front desk (residents: their own unit's). Use olderThanDays for 'waiting more than N days'.",
  input: z.object({
    view: z.enum(["waiting", "overdue", "picked_up", "returned", "all"]).optional().describe("Default 'waiting' (not picked up yet)."),
    olderThanDays: z.number().int().min(1).max(365).optional().describe("Only packages received more than this many days ago."),
    unit: z.string().trim().max(20).optional(),
    q: z.string().trim().max(80).optional().describe("Recipient name or tracking number."),
    location: locationArg,
    limit: limitArg,
  }),
  available: anyPerm("package.manage", "package.read.own"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    let unitId: string | undefined;
    if (a.unit) {
      const u = await resolveUnit(ctx, a.unit, pf.place);
      if (isErr(u)) return { result: u };
      unitId = u?.id;
    }
    const view = (a.view ?? "waiting") as PackageView;
    const page = await listPackages(ctx, {
      view, q: a.q, propertyId: pf.propertyId, buildingId: pf.buildingId, unitId,
      receivedBefore: a.olderThanDays ? new Date(env.now.getTime() - a.olderThanDays * 86_400_000) : undefined, pageSize: lim(a.limit),
    });
    const resident = ctx.principal.role.category === "resident";
    const items = page.rows.map((p) => ({
      id: p.id, unit: p.unitNumber, building: p.buildingName, property: p.propertyName, recipient: p.recipientName, carrier: p.carrier, size: p.size, perishable: p.perishable,
      shelf: resident ? undefined : p.shelfLocation, status: p.status, received: fmtWhen(p.receivedAt, env), waiting: p.status === "waiting" ? ago(p.receivedAt, env.now) : null,
      href: env.href(`/packages/${p.id}`),
    }));
    const who = resident ? "for you" : "";
    const noun = view === "waiting" ? "package waiting" : view === "overdue" ? "overdue package" : view === "picked_up" ? "picked-up package" : "package";
    const summary = page.total
      ? `${plural(page.total, noun, noun.replace("package", "packages"))}${who ? ` ${who}` : ""}${a.olderThanDays ? ` for more than ${a.olderThanDays} days` : ""}${where(pf.place)}.`
      : `No ${noun.replace("package", "packages")}${who ? ` ${who}` : ""}${a.olderThanDays ? ` older than ${a.olderThanDays} days` : ""}${where(pf.place)}.`;
    return {
      result: ok(summary, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((p) => `${resident ? "" : `Unit ${p.unit} · `}${p.carrier ?? "Package"}${p.recipient ? ` for ${p.recipient}` : ""} — received ${p.received}${p.waiting ? ` (${p.waiting} ago)` : ""}${p.perishable ? " · perishable" : ""}${p.shelf ? ` · shelf ${p.shelf}` : ""}`),
        ...(resident && page.total ? { note: "Your pickup code is on the package page." } : {}),
      }),
      display: { records: items.map((p) => ({ ref: resident ? "Package" : `Unit ${p.unit}`, title: `${p.carrier ?? "Package"}${p.recipient ? ` for ${p.recipient}` : ""}`, href: p.href,
        sub: [p.building, `received ${p.received}`].filter(Boolean).join(" · "),
        badges: [{ label: PACKAGE_STATUS[p.status]?.label ?? p.status, tone: PACKAGE_STATUS[p.status]?.tone ?? "neutral" }, ...(p.perishable ? [{ label: "Perishable", tone: "warning" as const }] : [])] })) },
    };
  },
});

export const recentAnnouncements = defineTool({
  name: "recent_announcements",
  title: "Reading announcements",
  description: "Current announcements published to the user (building notices, closures, events).",
  input: z.object({ unreadOnly: z.boolean().optional(), limit: limitArg }),
  available: anyPerm("announcement.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const rows = await announcementFeed(ctx, { limit: lim(a.limit, 8), unreadOnly: a.unreadOnly });
    if (!rows) return { result: err("ERROR", "Announcements are unavailable.") };
    const items = rows.map((r) => ({ id: r.id, title: r.title, category: r.category, pinned: r.pinned, published: fmtWhen(r.publishedAt, env), property: r.propertyName ?? "All properties", unread: !r.read, excerpt: r.body.slice(0, 280), href: env.href(`/announcements/${r.id}`) }));
    return {
      result: ok(rows.length ? `${plural(rows.length, a.unreadOnly ? "unread announcement" : "current announcement")}.` : "No current announcements.", {
        count: rows.length, items, highlights: items.map((i) => `[${i.title}](${i.href}) — ${i.property}, ${i.published}${i.unread ? " · unread" : ""}`),
      }),
      display: { records: items.map((i) => ({ ref: i.pinned ? "Pinned" : "Notice", title: i.title, href: i.href, sub: `${i.property} · ${i.published}`, badges: i.unread ? [{ label: "Unread", tone: "accent" as const }] : [] })) },
    };
  },
});
