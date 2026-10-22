// Inside-the-organization IDOR sweep: every detail getter × every restricted demo role × records that are clearly
// outside that role's reach must be refused (Forbidden or NotFound). Cross-organization reads are covered by the
// RLS sweep in tests/integration/tenant-isolation.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, type Principal } from "@/server/authz/authorize";
import type { TenantCtx } from "@/server/modules/context";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { closeDb } from "@/server/db/client";
import { getViolation, getSpace } from "@/server/modules/parking/service";
import { getVendor } from "@/server/modules/vendors/service";
import { getPackage } from "@/server/modules/packages/service";
import { getTask } from "@/server/modules/tasks/service";
import { getAsset } from "@/server/modules/assets/service";
import { getIncident } from "@/server/modules/incidents/service";
import { getBuilding, getProperty, getUnit } from "@/server/modules/portfolio/service";
import { getThread } from "@/server/modules/messaging/service";
import { getAmenity, getBooking } from "@/server/modules/amenities/service";
import { getWorkOrder } from "@/server/modules/maintenance/service";
import { getInspection } from "@/server/modules/inspections/service";
import { getComplaint } from "@/server/modules/complaints/service";
import { getAnnouncement } from "@/server/modules/announcements/service";
import { getVisitor } from "@/server/modules/visitors/service";
import { getDocument } from "@/server/modules/documents/service";
import { getResident, getStaff } from "@/server/modules/people/service";
import { getConversationView } from "@/server/ai/store";
import { getPlanView } from "@/server/ai/approvals";
import { getRule, getRun } from "@/server/automation/service";
import { getEntry } from "@/server/kb/knowledge";
import { getDelivery, getEndpoint } from "@/server/webhooks/service";
import { orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";
import { TEST_ENV } from "../support/test-env";
import { encrypt } from "@/server/auth/crypto";

type Row = { id: string; property_id: string | null; unit_id?: string | null; resident_id?: string | null; vendor_id?: string | null; user_id?: string | null; owner_user_id?: string | null; member_id?: string | null };
type Entity = {
  name: string;
  get: (ctx: TenantCtx, id: string) => Promise<unknown>;
  sql: string; // $1 = org id; returns id, property_id (+ optional unit_id, resident_id, vendor_id, user_id, owner_user_id, member_id)
  perms: string[]; // a role holding none of these (or their .own / .assigned variants) must always be refused
  personal?: boolean; // owned by one user (user_id): nobody else may open it
  unitBound?: boolean; // occupants may only open rows for their own unit / resident record
};

// up to 4 rows per property (and 6 without one), so every role sees out-of-scope rows
const sample = (table: string, cols = "id, property_id", where = "true") =>
  `select * from (select ${cols}, row_number() over (partition by property_id order by id) rn from ${table} where org_id = $1 and ${where}) x where rn <= case when property_id is null then 6 else 4 end`;

const ENTITIES: Entity[] = [
  { name: "property", get: getProperty, sql: `select id, id property_id from properties where org_id = $1`, perms: ["property.read"] },
  { name: "building", get: getBuilding, sql: sample("buildings"), perms: ["property.read"] },
  { name: "unit", get: getUnit, sql: sample("units", "id, property_id, id unit_id"), perms: ["unit.read"], unitBound: true },
  { name: "resident", get: getResident, sql: `select r.id, (select u.property_id from unit_occupancies o join units u on u.id = o.unit_id where o.resident_id = r.id limit 1) property_id, r.id resident_id from residents r where r.org_id = $1 order by r.id limit 40`, perms: ["resident.read"] },
  { name: "staff member", get: getStaff, sql: `select m.id, null::uuid property_id from memberships m join roles r on r.id = m.role_id where m.org_id = $1 and r.category = 'staff' limit 12`, perms: ["member.read", "shift.manage"] },
  { name: "vendor", get: getVendor, sql: `select id, null::uuid property_id, id vendor_id from vendors where org_id = $1`, perms: ["vendor.read"] },
  { name: "work order", get: getWorkOrder, sql: sample("work_orders", "id, property_id, unit_id, resident_id, vendor_id, submitted_by_user_id owner_user_id, assigned_membership_id member_id"), perms: ["workorder.read"], unitBound: true },
  { name: "task", get: getTask, sql: sample("tasks"), perms: ["task.read"] },
  { name: "inspection", get: getInspection, sql: sample("inspections", "id, property_id, unit_id, inspector_membership_id member_id"), perms: ["inspection.read"], unitBound: true },
  { name: "incident", get: getIncident, sql: sample("incidents", "id, property_id, unit_id, reported_by_user_id owner_user_id"), perms: ["incident.read"], unitBound: true },
  { name: "complaint", get: getComplaint, sql: sample("complaints", "id, property_id, unit_id, resident_id, submitted_by_user_id owner_user_id, assigned_membership_id member_id"), perms: ["complaint.read", "complaint.create"], unitBound: true },
  { name: "asset", get: getAsset, sql: sample("assets", "id, property_id, unit_id, vendor_id"), perms: ["asset.read"] },
  { name: "amenity", get: getAmenity, sql: sample("amenities"), perms: ["amenity.read"] },
  { name: "booking", get: getBooking, sql: sample("bookings", "id, property_id, unit_id, resident_id, booked_by_user_id owner_user_id"), perms: ["booking.create", "booking.manage", "amenity.read"], unitBound: true },
  { name: "package", get: getPackage, sql: sample("packages", "id, property_id, unit_id, resident_id"), perms: ["package.read", "package.manage"], unitBound: true },
  { name: "visitor", get: getVisitor, sql: sample("visitors", "id, property_id, unit_id, host_resident_id resident_id"), perms: ["visitor.manage", "visitor.invite"], unitBound: true },
  { name: "parking space", get: getSpace, sql: sample("parking_spaces"), perms: ["parking.manage", "parking.use"] },
  { name: "parking violation", get: getViolation, sql: sample("parking_violations", "id, property_id, unit_id"), perms: ["parking.manage", "parking.use"], unitBound: true },
  { name: "message thread", get: getThread, sql: sample("message_threads", "id, property_id, unit_id, resident_id"), perms: ["message.use", "message.manage"], unitBound: true },
  { name: "announcement", get: getAnnouncement, sql: sample("announcements"), perms: ["announcement.read", "announcement.manage"] },
  { name: "document", get: getDocument, sql: sample("documents", "id, property_id, unit_id"), perms: ["document.read", "document.manage"], unitBound: true },
  { name: "knowledge entry", get: (c, id) => getEntry(c, id), sql: sample("knowledge_entries"), perms: ["knowledge.manage", "document.read"] },
  { name: "automation rule", get: getRule, sql: sample("workflows"), perms: ["automation.manage"] },
  { name: "automation run", get: getRun, sql: sample("workflow_runs"), perms: ["automation.manage"] },
  { name: "assistant conversation", get: getConversationView, sql: `select id, null::uuid property_id, user_id from ai_conversations where org_id = $1 limit 30`, perms: ["ai.use"], personal: true },
  { name: "assistant plan", get: getPlanView, sql: `select id, null::uuid property_id, requested_by_user_id user_id from ai_approvals where org_id = $1 limit 30`, perms: ["ai.use"], personal: true },
  { name: "webhook endpoint", get: (c, id) => getEndpoint(c, id), sql: `select id, null::uuid property_id from webhook_endpoints where org_id = $1`, perms: ["api.manage"] },
  { name: "webhook delivery", get: getDelivery, sql: `select id, null::uuid property_id from webhook_deliveries where org_id = $1 limit 10`, perms: ["api.manage"] },
];

const ROLES = ["pm", "concierge", "council", "facility", "staff", "resident", "owner", "vendor"] as const;

const hasAny = (p: Principal, perms: string[]) => perms.some((x) => p.permissions.has(x) || p.permissions.has(`${x}.own`) || p.permissions.has(`${x}.assigned`));
const reachable = (p: Principal) => new Set([...p.propertyIds, ...p.partialPropertyIds, ...p.occupantPropertyIds]);

// true when this role must never be able to open this row
export function mustDeny(p: Principal, e: Entity, r: Row): string | null {
  if (e.personal) return r.user_id !== p.userId ? "someone else's" : null;
  // a personal link to the record is an access path by design: the reporter, booker, submitter, inspector or assignee
  if ((r.owner_user_id && r.owner_user_id === p.userId) || (r.member_id && r.member_id === p.membershipId)) return null;
  if (!hasAny(p, e.perms)) return "no permission";
  if (p.role.scopeLevel === "org") return null;
  if (p.role.scopeLevel === "assigned") {
    if (e.name === "vendor") return r.vendor_id !== p.vendorId ? "another vendor" : null;
    if (e.name === "work order") return r.vendor_id !== p.vendorId ? "not assigned to this vendor" : null;
    return r.property_id ? "vendor outside assignments" : null;
  }
  if (r.property_id && !reachable(p).has(r.property_id)) return "other property";
  if (p.role.scopeLevel === "occupant" && e.unitBound && r.unit_id && !p.unitIds.has(r.unit_id) && (!r.resident_id || r.resident_id !== p.residentId)) return "another unit";
  return null;
}

const meta = { ip: "203.0.113.20", userAgent: "vitest-security", requestId: "idor" };
const ctxs = new Map<string, TenantCtx>();
let orgId: string;
let endpointId: string | null = null;

beforeAll(async () => {
  orgId = await orgIdBySlug("pacific-properties");
  // the seed has no webhook endpoints; add one with a delivery so those getters are swept too
  const ep = await ownerPool.query("insert into webhook_endpoints (org_id, url, secret_enc, events) values ($1, 'https://hooks.example.com/idor', $2, '{work_order.created}') returning id", [orgId, encrypt("whsec_idor_fixture", TEST_ENV.APP_ENCRYPTION_KEY)]);
  endpointId = ep.rows[0].id;
  await ownerPool.query("insert into webhook_deliveries (org_id, endpoint_id, event_type, payload) values ($1, $2, 'ping', '{}'::jsonb)", [orgId, ep.rows[0].id]);
  for (const r of ROLES) {
    const p = await loadPrincipal(await userIdByEmail(`${r}@demo.test`), "pacific-properties");
    if (!p) throw new Error(`${r} not in pacific-properties`);
    ctxs.set(r, { principal: p, meta });
  }
}, 60_000);
afterAll(async () => {
  if (endpointId) await ownerPool.query("delete from webhook_endpoints where id = $1", [endpointId]);
  await closeDb();
  await ownerPool.end();
});

describe("IDOR sweep inside one organization", () => {
  for (const e of ENTITIES) {
    it(`${e.name}: restricted roles can't open records outside their reach`, async () => {
      const { rows } = await ownerPool.query<Row>(e.sql, [orgId]);
      expect(rows.length, `seed has no ${e.name} rows`).toBeGreaterThan(0);
      const leaks: string[] = [];
      let denials = 0;
      for (const role of ROLES) {
        const ctx = ctxs.get(role)!;
        for (const r of rows) {
          const why = mustDeny(ctx.principal, e, r);
          if (!why) continue;
          try {
            await e.get(ctx, r.id);
            leaks.push(`${role} opened ${e.name} ${r.id} (${why})`);
          } catch (err) {
            if (!(err instanceof ForbiddenError || err instanceof NotFoundError)) throw err;
            denials++;
          }
        }
      }
      expect(leaks).toEqual([]);
      expect(denials).toBeGreaterThan(0); // the sweep actually exercised refusals
    }, 120_000);
  }
});
