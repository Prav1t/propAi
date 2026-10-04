import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { amenities, announcements, bookings, messageThreads, organizations, outboxEvents, packages, properties, residents, units } from "../../db/schema";
import { unitResidentUsers } from "../community/residents";
import { audienceUserIds } from "../announcements/service";
import { membershipUser, usersWithPermAt } from "./recipients";
import type { Delivery } from "./service";

type Event = typeof outboxEvents.$inferSelect;

const when = (start: Date, end: Date, tz: string) =>
  `${start.toLocaleString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;

async function bookingContext(tx: Tx, id: string) {
  const [r] = await tx.select({ b: bookings, amenity: amenities.name, tz: properties.timezone, unit: units.number }).from(bookings)
    .innerJoin(amenities, eq(amenities.id, bookings.amenityId)).innerJoin(properties, eq(properties.id, bookings.propertyId)).leftJoin(units, eq(units.id, bookings.unitId))
    .where(eq(bookings.id, id));
  return r;
}

async function packageRecipients(tx: Tx, k: typeof packages.$inferSelect): Promise<string[]> {
  if (k.residentId) {
    const [r] = await tx.select({ userId: residents.userId }).from(residents).where(eq(residents.id, k.residentId));
    const unitUsers = await unitResidentUsers(tx, k.orgId, k.unitId);
    if (r?.userId && unitUsers.includes(r.userId)) return [r.userId];
    return unitUsers;
  }
  return unitResidentUsers(tx, k.orgId, k.unitId);
}

// amenity bookings, packages, announcements and resident messages
export async function communityDeliveries(tx: Tx, e: Event, base: string): Promise<Delivery[]> {
  const p = e.payload as Record<string, string | boolean | null | undefined>;
  switch (e.type) {
    case "booking.created":
    case "booking.decided":
    case "booking.cancelled": {
      const r = await bookingContext(tx, String(p.bookingId));
      if (!r) return [];
      const b = r.b;
      const slot = when(b.startsAt, b.endsAt, r.tz);
      const href = `${base}/amenities/bookings/${b.id}`;
      const unitLabel = r.unit ? `Unit ${r.unit}` : "Staff booking";
      const residentsOf = async () => [...new Set([...(b.unitId ? await unitResidentUsers(tx, b.orgId, b.unitId) : []), ...(b.bookedByUserId ? [b.bookedByUserId] : [])])];
      const managers = () => usersWithPermAt(tx, b.orgId, "booking.manage", b.propertyId, b.buildingId);
      if (e.type === "booking.created") {
        if (p.byStaff) return b.unitId ? [{ userIds: await unitResidentUsers(tx, b.orgId, b.unitId), kind: "booking.updated", title: `Booked for your unit: ${r.amenity}, ${slot}`, href, entityType: "booking", entityId: b.id }] : [];
        if (b.status !== "requested") return [];
        return [{ userIds: await managers(), kind: "booking.request", title: `Booking request: ${r.amenity}, ${slot}`, body: `${unitLabel} · ${b.guests} ${b.guests === 1 ? "person" : "people"}${b.purpose ? ` · ${b.purpose}` : ""}`, href, entityType: "booking", entityId: b.id }];
      }
      if (e.type === "booking.decided") {
        const approved = p.decision === "approved";
        return [{ userIds: await residentsOf(), kind: "booking.updated", title: `Your ${r.amenity} booking was ${approved ? "approved" : "declined"}`, body: [slot, b.decisionNote].filter(Boolean).join(" — "), href, entityType: "booking", entityId: b.id }];
      }
      if (p.byStaff) return [{ userIds: await residentsOf(), kind: "booking.updated", title: `Your ${r.amenity} booking was cancelled by management`, body: [slot, b.cancelReason].filter(Boolean).join(" — "), href, entityType: "booking", entityId: b.id }];
      return [{ userIds: await managers(), kind: "booking.request", title: `Cancelled: ${r.amenity}, ${slot}`, body: unitLabel, href, entityType: "booking", entityId: b.id }];
    }
    case "package.arrived":
    case "package.reminder":
    case "package.released": {
      const [k] = await tx.select().from(packages).where(eq(packages.id, String(p.packageId)));
      if (!k) return [];
      const [tz] = await tx.select({ tz: properties.timezone }).from(properties).where(eq(properties.id, k.propertyId));
      const href = `${base}/packages`;
      const what = [k.carrier, k.perishable ? "perishable" : null].filter(Boolean).join(", ") || "A delivery";
      const title = e.type === "package.arrived" ? `Package waiting at the front desk${k.perishable ? " (perishable)" : ""}`
        : e.type === "package.reminder" ? `Reminder: your package is still waiting${k.perishable ? " — it's perishable" : ""}`
        : "Your package was picked up";
      const body = e.type === "package.released"
        ? `Picked up by ${k.pickedUpByName ?? "someone"} on ${k.pickedUpAt?.toLocaleString("en-CA", { timeZone: tz?.tz ?? "UTC", dateStyle: "medium", timeStyle: "short" })}. If this wasn't you, contact the front desk.`
        : `${what}. Pickup code ${k.pickupCode}.`;
      return [{ userIds: await packageRecipients(tx, k), kind: "package.arrived", title, body, href, entityType: "package", entityId: k.id }];
    }
    case "announcement.published": {
      const [a] = await tx.select().from(announcements).where(eq(announcements.id, String(p.announcementId)));
      if (!a || !a.notify || a.status !== "published") return [];
      return [{ userIds: await audienceUserIds(tx, a), kind: "announcement.posted", title: `${a.category === "emergency" ? "Urgent: " : ""}${a.title}`, body: a.body.slice(0, 280), href: `${base}/announcements/${a.id}`, entityType: "announcement", entityId: a.id }];
    }
    case "message.posted": {
      const [t] = await tx.select().from(messageThreads).where(eq(messageThreads.id, String(p.threadId)));
      if (!t) return [];
      const href = `${base}/messages/${t.id}`;
      if (p.fromStaff) {
        const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, t.orgId));
        return t.residentUserId ? [{ userIds: [t.residentUserId], kind: "message.received", title: `${org?.name ?? "Management"} replied: ${t.subject}`, body: t.lastMessagePreview, href, entityType: "message_thread", entityId: t.id }] : [];
      }
      const [r] = t.residentId ? await tx.select({ first: residents.firstName, last: residents.lastName }).from(residents).where(eq(residents.id, t.residentId)) : [];
      const [u] = t.unitId ? await tx.select({ number: units.number }).from(units).where(eq(units.id, t.unitId)) : [];
      const ids = t.assignedMembershipId ? await membershipUser(tx, t.assignedMembershipId) : [];
      const to = ids.length ? ids : await usersWithPermAt(tx, t.orgId, "message.manage", t.propertyId, t.buildingId);
      return [{ userIds: to, kind: "message.inbox", title: `Message from ${r ? `${r.first} ${r.last}` : "a resident"}${u ? ` (Unit ${u.number})` : ""}: ${t.subject}`, body: t.lastMessagePreview, href, entityType: "message_thread", entityId: t.id }];
    }
    default:
      return [];
  }
}
