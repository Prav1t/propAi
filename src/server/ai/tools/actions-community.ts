import "server-only";
import { z } from "zod";
import { can } from "../../authz/authorize";
import { ValidationError } from "../../modules/context";
import { ForbiddenError, NotFoundError } from "../../authz/authorize";
import { cancelBooking, createBooking, getAmenity, getBooking, listBookings, previewBooking, type BookingInput } from "../../modules/amenities/service";
import { getPackage, logPackage, type PackageInput } from "../../modules/packages/service";
import { normalizeTracking } from "../../modules/packages/carrier";
import { getVisitor, registerVisitor, type VisitorInput } from "../../modules/visitors/service";
import { normalizePlate } from "../../modules/parking/plate";
import { audienceSize, createAnnouncement, getAnnouncement, type AnnouncementInput } from "../../modules/announcements/service";
import { getThread, startThread } from "../../modules/messaging/service";
import { listResidents } from "../../modules/people/service";
import { ANNOUNCEMENT_CATEGORIES, PACKAGE_SIZES, VISITOR_KINDS } from "../../db/schema";
import { money } from "@/lib/community-labels";
import { addDaysIso } from "../demo/dates";
import { defineAction, err, plural } from "./registry";
import { dateArg, dayEnd, dayStart, fmtDay, label, locationArg, placeFilter } from "./common";
import { buildingFor, isErr, myUnits, propertyFor, resolveAmenity, resolveUnit } from "./resolve";

const timeArg = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const hhmm = (t: string) => t.padStart(5, "0");
const time = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const domainError = (e: unknown) => {
  if (e instanceof ValidationError) return err("INVALID", e.message);
  if (e instanceof ForbiddenError) return err("FORBIDDEN", e.message);
  if (e instanceof NotFoundError) return err("NOT_FOUND", "Not found among the records you can see.");
  throw e;
};

/* ───────────── bookings ───────────── */

export const createBookingAction = defineAction({
  name: "create_booking",
  title: "Checking the booking rules",
  description:
    "Prepare an amenity booking. The real booking rules run first (hours, notice, length, capacity, limits, blackouts); if they'd refuse it, nothing is prepared and the reasons come back. " +
    "Residents book for their own unit; staff may book for a unit by number. Fees, deposits and whether management must approve are shown before anything is booked.",
  input: z.object({
    amenity: z.string().trim().min(2).max(80),
    date: dateArg,
    start: timeArg.describe("Start time HH:MM, 24-hour."),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    guests: z.number().int().min(1).max(10_000).optional(),
    unit: z.string().trim().max(20).optional(),
    purpose: z.string().trim().max(300).optional(),
    location: locationArg,
  }),
  available: (p) => p.permissions.has("booking.create") || p.permissions.has("booking.manage"),
  riskClass: () => 2,
  policyKeys: () => ["booking.manage"],
  editable: [
    { key: "date", label: "Date", type: "date" },
    { key: "start", label: "Start", type: "time" },
    { key: "durationMinutes", label: "Minutes", type: "number" },
    { key: "guests", label: "Guests", type: "number" },
  ],
  async prepare(ctx, a, env) {
    const p = ctx.principal;
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return pf;
    const am = await resolveAmenity(ctx, a.amenity, pf.place);
    if (isErr(am)) return am;
    let unitId: string | null = null;
    let unitLabel: string | null = null;
    if (p.role.category === "resident") {
      const mine = await myUnits(ctx);
      const pick = a.unit ? mine.filter((u) => u.number.toLowerCase() === a.unit!.toLowerCase()) : mine;
      if (a.unit && !pick.length) return err("FORBIDDEN", `You can only book for your own unit, and ${a.unit} isn't one of yours.`);
      if (pick.length > 1) return err("AMBIGUOUS", "Which of your units is this booking for?", pick.map((u) => u.label));
      unitId = pick[0]?.id ?? null;
      unitLabel = pick[0]?.label ?? null;
    }
    const info = await getAmenity(ctx, am.id);
    const duration = a.durationMinutes ?? Math.min(Math.max(60, info.amenity.minDurationMinutes), info.amenity.maxDurationMinutes);
    const input: BookingInput = {
      amenityId: am.id, date: a.date, start: hhmm(a.start), durationMinutes: duration, guests: a.guests ?? 1, purpose: a.purpose ?? null,
      unitId, unitNumber: p.role.category === "resident" ? null : a.unit ?? null, buildingId: null,
    };
    let pv: Awaited<ReturnType<typeof previewBooking>>;
    try {
      pv = await previewBooking(ctx, input);
    } catch (e) {
      return domainError(e);
    }
    const d = pv.decision;
    const when = `${fmtDay(a.date, env)}, ${time(pv.start, pv.tz)}–${time(pv.end, pv.tz)}`;
    if (!d.ok) return err("INVALID", `${am.name} can't be booked ${when}: ${d.problems.map((x) => x.message).join(" ")}`);
    return {
      ok: true,
      step: {
        title: `Book ${am.name} for ${when}`,
        details: [
          am.label, ...(unitLabel ? [unitLabel] : a.unit ? [`For unit ${a.unit}`] : []), `${plural(input.guests, "person", "people")}`,
          d.status === "requested" ? "Needs management approval after it's submitted" : "Confirmed as soon as it's booked",
          ...(d.feeCents ? [`Fee ${money(d.feeCents)} due`] : []), ...(d.depositCents ? [`Deposit ${money(d.depositCents)} due`] : []),
        ],
        effects: d.status === "requested" ? ["Management is asked to approve it"] : [],
        resolved: { input },
        propertyId: am.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const b = await createBooking(ctx, r.input as BookingInput);
    return {
      summary: `Booked #${b.number}: ${b.status === "requested" ? "requested — waiting for management's approval" : "confirmed"}.`,
      record: { ref: `Booking #${b.number}`, title: "Amenity booking", href: env.href(`/amenities/bookings/${b.id}`) }, check: { id: b.id },
    };
  },
  async verify(ctx, o) {
    const d = await getBooking(ctx, String(o.check!.id));
    return { ok: ["requested", "approved"].includes(d.booking.status), summary: `${d.amenity.name} booking #${d.booking.number} is ${d.booking.status}.` };
  },
});

export const cancelBookingAction = defineAction({
  name: "cancel_booking",
  title: "Finding the booking",
  description: "Prepare cancelling an upcoming amenity booking, found by number, amenity and/or date. Residents can cancel their own until the amenity's cut-off.",
  input: z.object({
    booking: z.number().int().min(1).optional().describe("Booking number."),
    amenity: z.string().trim().max(80).optional(),
    date: dateArg.optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  available: (p) => p.permissions.has("booking.create") || p.permissions.has("booking.manage"),
  riskClass: () => 2,
  policyKeys: () => ["booking.manage"],
  editable: [{ key: "reason", label: "Reason", type: "text" }],
  async prepare(ctx, a, env) {
    let amenityId: string | undefined;
    if (a.amenity) {
      const am = await resolveAmenity(ctx, a.amenity);
      if (isErr(am)) return am;
      amenityId = am.id;
    }
    const page = await listBookings(ctx, { view: "upcoming", amenityId, from: a.date ? dayStart(a.date, env) : undefined, to: a.date ? dayEnd(a.date, env) : undefined, pageSize: 25 });
    const rows = page.rows.filter((b) => !a.booking || b.number === a.booking);
    if (!rows.length) return err("NOT_FOUND", "I couldn't find an upcoming booking like that.");
    if (rows.length > 1) return err("AMBIGUOUS", "Which booking?", rows.slice(0, 8).map((b) => `#${b.number} ${b.amenityName} · ${fmtDay(b.startsAt, { ...env, timeZone: b.tz })}, ${time(b.startsAt, b.tz)}${b.unitNumber && ctx.principal.role.category === "staff" ? ` · Unit ${b.unitNumber}` : ""}`));
    const d = await getBooking(ctx, rows[0].id);
    if (!d.canCancel) return err("INVALID", d.cancelCutoffPassed ? `It's past the ${d.amenity.cancellationHours}-hour cancellation cut-off; please contact management.` : "You can't cancel this booking.");
    const ownBooking = d.access.own;
    if (!ownBooking && !a.reason) return err("INVALID", "Cancelling someone else's booking needs a reason for the resident (reason).");
    return {
      ok: true,
      step: {
        title: `Cancel booking #${d.booking.number}: ${d.amenity.name}, ${fmtDay(d.booking.startsAt, { ...env, timeZone: d.tz })} ${time(d.booking.startsAt, d.tz)}`,
        details: [...(d.unitNumber ? [`Unit ${d.unitNumber}`] : []), `Status: ${d.booking.status}`, ...(a.reason ? [`Reason: ${a.reason}`] : [])],
        effects: ownBooking ? ["The slot opens for others"] : ["The resident is notified with your reason"],
        resolved: { id: d.booking.id, reason: a.reason ?? null },
        propertyId: d.amenity.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const b = await cancelBooking(ctx, String(r.id), { reason: (r.reason as string | null) ?? null });
    return { summary: `Cancelled booking #${b.number}.`, record: { ref: `Booking #${b.number}`, title: "Amenity booking", href: env.href(`/amenities/bookings/${b.id}`) }, check: { id: b.id } };
  },
  async verify(ctx, o) {
    const d = await getBooking(ctx, String(o.check!.id));
    return { ok: d.booking.status === "cancelled", summary: `Booking #${d.booking.number} is ${d.booking.status}.` };
  },
});

/* ───────────── front desk ───────────── */

export const logPackageAction = defineAction({
  name: "log_package",
  title: "Preparing a package log",
  description: "Prepare logging a delivered package for a unit; the unit's residents get a notification with a pickup code. Give the building if unit numbers repeat across towers.",
  input: z.object({
    unit: z.string().trim().min(1).max(20),
    location: locationArg,
    recipient: z.string().trim().max(120).optional(),
    carrier: z.string().trim().max(40).optional(),
    tracking: z.string().trim().max(60).optional(),
    size: z.enum(PACKAGE_SIZES).optional(),
    perishable: z.boolean().optional(),
    shelf: z.string().trim().max(40).optional(),
  }),
  available: (p) => p.permissions.has("package.manage"),
  riskClass: () => 2,
  policyKeys: () => ["package.log"],
  editable: [{ key: "recipient", label: "Recipient", type: "text" }, { key: "carrier", label: "Carrier", type: "text" }, { key: "shelf", label: "Shelf", type: "text" }],
  async prepare(ctx, a) {
    const p = ctx.principal;
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return pf;
    const u = await resolveUnit(ctx, a.unit, pf.place);
    if (isErr(u)) return u;
    if (!can(p, "package.manage", { orgId: p.orgId, propertyId: u!.propertyId, buildingId: u!.buildingId })) return err("FORBIDDEN", "You can't log packages there.");
    const input: PackageInput = {
      buildingId: u!.buildingId, unitNumber: u!.number, recipientName: a.recipient ?? null, carrier: a.carrier ?? null, trackingNumber: a.tracking ? normalizeTracking(a.tracking) || null : null,
      size: a.size ?? "small", perishable: !!a.perishable, shelfLocation: a.shelf ?? null, notes: null,
    };
    return {
      ok: true,
      step: {
        title: `Log a package for ${u!.label}`,
        details: [[a.carrier, a.recipient ? `for ${a.recipient}` : null, a.perishable ? "perishable" : null, a.shelf ? `shelf ${a.shelf}` : null].filter(Boolean).join(" · ") || "Package details can be added later"],
        effects: ["The unit's residents get a notification with a pickup code"],
        resolved: { input },
        propertyId: u!.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const res = await logPackage(ctx, r.input as PackageInput);
    return { summary: `Logged the package for Unit ${res.unitNumber} · ${res.buildingName}; the residents were notified.`, record: { ref: `Unit ${res.unitNumber}`, title: `Package${res.package.carrier ? ` (${res.package.carrier})` : ""}`, href: env.href(`/packages/${res.package.id}`) }, check: { id: res.package.id } };
  },
  async verify(ctx, o) {
    const d = await getPackage(ctx, String(o.check!.id));
    return { ok: d.package.status === "waiting", summary: `Package is ${d.package.status} at the desk.` };
  },
});

export const registerVisitorAction = defineAction({
  name: "register_visitor",
  title: "Preparing a visitor registration",
  description: "Prepare pre-registering a visitor. Residents invite guests to their own unit (a guest pass is created); the desk registers visitors for a unit or a building.",
  input: z.object({
    name: z.string().trim().min(2).max(120),
    date: dateArg,
    from: timeArg,
    until: timeArg.optional().describe("End of the visit window (default two hours after 'from')."),
    unit: z.string().trim().max(20).optional(),
    location: locationArg,
    company: z.string().trim().max(120).optional(),
    kind: z.enum(VISITOR_KINDS).optional(),
    purpose: z.string().trim().max(300).optional(),
    plate: z.string().trim().max(12).optional(),
    needsParking: z.boolean().optional(),
  }),
  available: (p) => p.permissions.has("visitor.manage") || p.permissions.has("visitor.invite"),
  riskClass: () => 2,
  policyKeys: () => ["visitor.register"],
  editable: [{ key: "name", label: "Visitor", type: "text" }, { key: "date", label: "Date", type: "date" }, { key: "from", label: "From", type: "time" }, { key: "until", label: "Until", type: "time" }],
  async prepare(ctx, a, env) {
    const p = ctx.principal;
    const resident = p.role.category === "resident";
    if (a.date < env.today) return err("INVALID", "That date is in the past.");
    const from = hhmm(a.from);
    let until = a.until ? hhmm(a.until) : null;
    let throughDate: string | null = null;
    if (!until) {
      const [h, m] = from.split(":").map(Number);
      const end = h * 60 + m + 120;
      until = `${String(Math.floor(end / 60) % 24).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
      if (end >= 1440) throughDate = addDaysIso(a.date, 1);
    } else if (until <= from) throughDate = addDaysIso(a.date, 1);
    let where: string;
    let place: { unitId: string | null; buildingId: string | null; unitNumber: string | null; propertyId: string };
    if (resident) {
      const mine = await myUnits(ctx);
      const pick = a.unit ? mine.filter((u) => u.number.toLowerCase() === a.unit!.toLowerCase()) : mine;
      if (!pick.length) return err("FORBIDDEN", "Guests can only be invited to your own unit.");
      if (pick.length > 1) return err("AMBIGUOUS", "Which of your units is the guest visiting?", pick.map((u) => u.label));
      place = { unitId: pick[0].id, buildingId: null, unitNumber: null, propertyId: pick[0].propertyId };
      where = pick[0].label;
    } else {
      const pf = await placeFilter(ctx, a.location);
      if (isErr(pf)) return pf;
      if (a.unit) {
        const u = await resolveUnit(ctx, a.unit, pf.place);
        if (isErr(u)) return u;
        place = { unitId: null, buildingId: u!.buildingId, unitNumber: u!.number, propertyId: u!.propertyId };
        where = u!.label;
      } else {
        const b = await buildingFor(ctx, pf.place);
        if (isErr(b)) return b;
        place = { unitId: null, buildingId: b.buildingId, unitNumber: null, propertyId: b.propertyId };
        where = b.label;
      }
      if (!can(p, "visitor.manage", { orgId: p.orgId, propertyId: place.propertyId, buildingId: place.buildingId })) return err("FORBIDDEN", "You can't register visitors there.");
    }
    const plate = a.plate ? normalizePlate(a.plate) || null : null;
    const input: VisitorInput = {
      name: a.name, company: a.company ?? null, phone: null, kind: a.kind ?? (a.company ? "contractor" : "guest"), purpose: a.purpose ?? null, date: a.date, from, until,
      throughDate, plate, needsParking: !!a.needsParking, unitId: place.unitId, buildingId: place.buildingId, unitNumber: place.unitNumber, workOrderNumber: null, arrivingNow: false,
    };
    return {
      ok: true,
      step: {
        title: `Expect ${a.name}${a.company ? ` (${a.company})` : ""} on ${fmtDay(a.date, env)}, ${from}–${until}${throughDate ? " (next day)" : ""}`,
        details: [where, label(input.kind), ...(plate ? [`Plate ${plate}${input.needsParking ? " · needs parking" : ""}`] : [])],
        effects: resident ? ["A guest pass is created — open the visit afterwards to get the link to send"] : ["The visit appears on the front desk's expected list"],
        resolved: { input },
        propertyId: place.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const res = await registerVisitor(ctx, r.input as VisitorInput);
    // the one-time pass secret is never stored in the plan or shown here; the visit page reissues it
    return { summary: `Registered ${res.visitor.name}${res.passToken ? " with a guest pass — open the visit to share the link" : ""}.`, record: { ref: "Visitor", title: res.visitor.name, href: env.href(`/visitors/${res.visitor.id}`) }, check: { id: res.visitor.id } };
  },
  async verify(ctx, o) {
    const d = await getVisitor(ctx, String(o.check!.id));
    return { ok: d.visitor.status === "expected", summary: `${d.visitor.name} is expected${d.visitor.hasPass ? " and has a guest pass" : ""}.` };
  },
});

/* ───────────── communications (class 3: always confirmed) ───────────── */

const AUDIENCE_LABEL: Record<string, string> = { residents: "Residents", everyone: "Residents and staff", staff: "Staff only" };

export const sendAnnouncementAction = defineAction({
  name: "send_announcement",
  title: "Drafting an announcement",
  description:
    "Prepare an announcement to residents (and/or staff) of a property or building, published on the board with notifications. Write the full title and body yourself, " +
    "in the tone the user asked for (default: professional and concise). It's always shown to the user as a draft and sent only after they approve it.",
  input: z.object({
    title: z.string().trim().min(3).max(140),
    body: z.string().trim().min(5).max(10_000),
    audience: z.enum(["residents", "everyone", "staff"]).optional(),
    location: locationArg,
    category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
    pinned: z.boolean().optional(),
    tone: z.string().trim().max(20).optional().describe("The tone the text was written in, e.g. professional, friendly, concise, urgent, formal."),
    about: z.string().trim().max(500).optional().describe("One line on what the notice is about (used to redraft in another tone)."),
  }),
  available: (p) => p.permissions.has("announcement.manage"),
  riskClass: () => 3,
  policyKeys: () => ["communication.send"],
  editable: [{ key: "title", label: "Title", type: "text" }, { key: "body", label: "Message", type: "textarea" }],
  async prepare(ctx, a) {
    const p = ctx.principal;
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return pf;
    const prop = await propertyFor(ctx, pf.place, { allowOrgWide: true });
    if (isErr(prop)) return prop;
    if (prop.propertyId ? !can(p, "announcement.manage", { orgId: p.orgId, propertyId: prop.propertyId }) : !can(p, "announcement.manage")) return err("FORBIDDEN", "You can't post announcements there.");
    const audience = a.audience ?? "residents";
    const buildingIds = prop.buildingId ? [prop.buildingId] : [];
    const reach = await audienceSize(ctx, { propertyId: prop.propertyId, buildingIds, audience });
    const input: AnnouncementInput = {
      title: a.title, body: a.body, category: a.category ?? "general", propertyId: prop.propertyId, audience, pinned: !!a.pinned, notify: true, mode: "publish", publishAt: undefined, expiresOn: null,
    };
    return {
      ok: true,
      step: {
        title: `Send the announcement “${a.title}”`,
        details: [prop.label, `To: ${AUDIENCE_LABEL[audience]}`, ...(a.tone ? [`Tone: ${a.tone}`] : [])],
        effects: ["Published on the announcements board", `${plural(reach, "person", "people")} who use the app get a notification`],
        resolved: { input, buildingIds },
        propertyId: prop.propertyId,
        draft: { title: a.title, body: a.body },
      },
    };
  },
  async execute(ctx, r, env) {
    const an = await createAnnouncement(ctx, r.input as AnnouncementInput, (r.buildingIds as string[]) ?? []);
    return { summary: `Published “${an.title}”.`, record: { ref: "Announcement", title: an.title, href: env.href(`/announcements/${an.id}`) }, check: { id: an.id } };
  },
  async verify(ctx, o) {
    const d = await getAnnouncement(ctx, String(o.check!.id));
    return { ok: d.announcement.status === "published", summary: `The announcement is ${d.announcement.status}.` };
  },
});

export const messageResidentAction = defineAction({
  name: "message_resident",
  title: "Drafting a message",
  description: "Prepare a direct message to a resident (by name and/or unit) who uses the app; it starts a conversation they can reply to. Shown as a draft and sent only after approval.",
  input: z.object({
    unit: z.string().trim().max(20).optional(),
    resident: z.string().trim().max(120).optional().describe("Resident's name."),
    location: locationArg,
    subject: z.string().trim().min(3).max(140),
    body: z.string().trim().min(1).max(5000),
    tone: z.string().trim().max(20).optional().describe("The tone the text was written in."),
    about: z.string().trim().max(500).optional().describe("One line on what the message is about (used to redraft in another tone)."),
  }),
  available: (p) => p.permissions.has("message.manage") && p.permissions.has("resident.read"),
  riskClass: () => 3,
  policyKeys: () => ["communication.send"],
  editable: [{ key: "subject", label: "Subject", type: "text" }, { key: "body", label: "Message", type: "textarea" }],
  async prepare(ctx, a) {
    if (!a.unit && !a.resident) return err("INVALID", "Say who to message: a resident's name or their unit.");
    let unitId: string | undefined;
    let unitLabel = "";
    if (a.unit) {
      const pf = await placeFilter(ctx, a.location);
      if (isErr(pf)) return pf;
      const u = await resolveUnit(ctx, a.unit, pf.place);
      if (isErr(u)) return u;
      unitId = u!.id;
      unitLabel = u!.label;
    }
    const page = await listResidents(ctx, { q: a.resident, unitId, status: "current", pageSize: 10 });
    const withApp = page.rows.filter((r) => r.hasLogin);
    if (!page.rows.length) return err("NOT_FOUND", "No current resident matches that.");
    if (!withApp.length) return err("INVALID", `${page.rows.map((r) => `${r.firstName} ${r.lastName}`).join(", ")} ${page.rows.length === 1 ? "doesn't" : "don't"} use the app yet — call or email instead.`);
    if (withApp.length > 1) return err("AMBIGUOUS", "Which resident?", withApp.map((r) => `${r.firstName} ${r.lastName}${r.units ? ` (${r.units})` : ""}`));
    const r = withApp[0];
    return {
      ok: true,
      step: {
        title: `Message ${r.firstName} ${r.lastName}: “${a.subject}”`,
        details: [unitLabel || r.units || "", ...(a.tone ? [`Tone: ${a.tone}`] : [])].filter(Boolean),
        effects: [`${r.firstName} gets a notification and can reply in Messages`],
        resolved: { residentId: r.id, subject: a.subject, body: a.body },
        propertyId: null,
        draft: { title: a.subject, body: a.body },
      },
    };
  },
  async execute(ctx, r, env) {
    const t = await startThread(ctx, { subject: String(r.subject), category: "general", body: String(r.body), unitId: null, residentId: String(r.residentId) });
    return { summary: `Sent “${t.subject}”.`, record: { ref: "Message", title: t.subject, href: env.href(`/messages/${t.id}`) }, check: { id: t.id } };
  },
  async verify(ctx, o) {
    const d = await getThread(ctx, String(o.check!.id));
    return { ok: d.messages.length > 0, summary: `The conversation has ${plural(d.messages.length, "message")}.` };
  },
});
