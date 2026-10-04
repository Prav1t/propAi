import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { assets, outboxEvents, parkingViolations, properties, shiftHandoffs, users, visitors } from "../../db/schema";
import { unitResidentUsers } from "../community/residents";
import { handoffRecipients } from "../shifts/service";
import { usersWithPermAt } from "./recipients";
import type { Delivery } from "./service";

type Event = typeof outboxEvents.$inferSelect;

const KIND_WORDS: Record<string, string> = {
  no_permit: "no permit", expired_permit: "expired permit", wrong_space: "wrong space", visitor_overstay: "visitor overstay", fire_lane: "fire lane",
  accessible: "accessible space", blocking: "blocking", other: "other",
};

// the resident who invited the guest if they still live there, otherwise everyone in the unit
async function hostUsers(tx: Tx, v: typeof visitors.$inferSelect): Promise<string[]> {
  if (!v.unitId) return v.invitedByUserId ? [v.invitedByUserId] : [];
  const unitUsers = await unitResidentUsers(tx, v.orgId, v.unitId);
  return v.invitedByUserId && unitUsers.includes(v.invitedByUserId) ? [v.invitedByUserId] : unitUsers;
}

// visitors, parking, shift handoffs and equipment outages
export async function facilityDeliveries(tx: Tx, e: Event, base: string): Promise<Delivery[]> {
  const p = e.payload as Record<string, string | null | undefined>;
  switch (e.type) {
    case "visitor.checked_in":
    case "visitor.denied": {
      const [v] = await tx.select().from(visitors).where(eq(visitors.id, p.visitorId!));
      if (!v) return [];
      const [pr] = await tx.select({ tz: properties.timezone }).from(properties).where(eq(properties.id, v.propertyId));
      const at = (v.checkedInAt ?? new Date()).toLocaleTimeString("en-CA", { timeZone: pr?.tz ?? "America/Vancouver", hour: "numeric", minute: "2-digit" });
      const arrived = e.type === "visitor.checked_in";
      return [{
        userIds: await hostUsers(tx, v), kind: "visitor.arrived",
        title: arrived ? `${v.name} has arrived` : `${v.name} wasn't let in`,
        body: arrived ? `Checked in at the front desk at ${at}.` : v.deniedReason, href: `${base}/visitors/${v.id}`, entityType: "visitor", entityId: v.id,
      }];
    }
    case "parking.violation_reported": {
      const [v] = await tx.select().from(parkingViolations).where(eq(parkingViolations.id, p.violationId!));
      if (!v) return [];
      const detection = v.source === "detection";
      return [{
        userIds: await usersWithPermAt(tx, e.orgId, "parking.manage", v.propertyId, v.buildingId), kind: "parking.report",
        title: `${detection ? "Camera detection" : "Parking report"} #${v.number} to review: ${v.plate} (${KIND_WORDS[v.kind] ?? v.kind})`,
        body: detection ? `Detected with ${Math.round(Number(v.confidence ?? 0) * 100)}% confidence. Nothing is sent to anyone until a person confirms it.` : v.description,
        href: `${base}/parking/violations/${v.id}`, entityType: "parking_violation", entityId: v.id,
      }];
    }
    case "parking.notice_issued": {
      const [v] = await tx.select().from(parkingViolations).where(eq(parkingViolations.id, p.violationId!));
      if (!v?.unitId) return [];
      return [{ userIds: await unitResidentUsers(tx, v.orgId, v.unitId), kind: "parking.notice", title: `Parking notice for ${v.plate}`, body: v.warningText, href: `${base}/parking/violations/${v.id}`, entityType: "parking_violation", entityId: v.id }];
    }
    case "shift.handoff_created": {
      const [h] = await tx.select({ h: shiftHandoffs, author: users.name }).from(shiftHandoffs).leftJoin(users, eq(users.id, shiftHandoffs.authorUserId)).where(eq(shiftHandoffs.id, p.handoffId!));
      if (!h) return [];
      return [{ userIds: await handoffRecipients(tx, e.orgId, h.h.propertyId, h.h.authorUserId), kind: "shift.handoff", title: `Shift handoff from ${h.author ?? "the previous shift"}`, body: h.h.notes.slice(0, 280), href: `${base}/shifts/handoff`, entityType: "shift_handoff", entityId: h.h.id }];
    }
    case "asset.down": {
      const [a] = await tx.select().from(assets).where(eq(assets.id, p.assetId!));
      if (!a) return [];
      return [{ userIds: await usersWithPermAt(tx, e.orgId, "asset.manage", a.propertyId, a.buildingId), kind: "asset.down", title: `${a.name} is out of service`, body: p.reason ?? null, href: `${base}/assets/${a.id}`, entityType: "asset", entityId: a.id }];
    }
    default:
      return [];
  }
}
