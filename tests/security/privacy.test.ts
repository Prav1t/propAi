// Personal data requests (Iteration 11): export, erasure with legal holds, retention, consent history
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRetention, erasePerson, exportPerson, openExport, placeLegalHold, releaseLegalHold, saveRetention } from "@/server/privacy/service";
import { savePreferences } from "@/server/modules/notifications/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError } from "@/server/authz/authorize";
import { closeDb } from "@/server/db/client";
import type { TenantCtx } from "@/server/modules/context";
import { orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.50", userAgent: "vitest-privacy", requestId: "priv" };
let orgId: string;
let admin: TenantCtx;
let pm: TenantCtx;
type Person = { userId: string; residentId: string; unitId: string; propertyId: string; buildingId: string; email: string };

async function ctxFor(email: string): Promise<TenantCtx> {
  return { principal: (await loadPrincipal(await userIdByEmail(email), "pacific-properties"))!, meta };
}

const made: Person[] = [];

// a resident with an account, a vehicle, a message, an assistant conversation, a work order and a visitor
async function makePerson(label: string): Promise<Person> {
  const email = `${label.toLowerCase()}-${randomUUID().slice(0, 6)}@privacy.test`;
  const u = await ownerPool.query("insert into users (email, name, email_verified_at) values ($1, $2, now()) returning id", [email, label]);
  const unit = (await ownerPool.query("select u.id, u.property_id, u.building_id from units u join properties p on p.id = u.property_id where p.org_id = $1 and p.code = 'HBC' order by u.number desc limit 1", [orgId])).rows[0];
  const r = await ownerPool.query("insert into residents (org_id, user_id, first_name, last_name, email, phone) values ($1, $2, $3, 'Example', $4, '+16045550199') returning id", [orgId, u.rows[0].id, label, email]);
  await ownerPool.query("insert into unit_occupancies (org_id, unit_id, resident_id, relationship) values ($1, $2, $3, 'tenant')", [orgId, unit.id, r.rows[0].id]);
  await ownerPool.query("insert into memberships (org_id, user_id, role_id) values ($1, $2, (select id from roles where key = 'tenant' and org_id is null))", [orgId, u.rows[0].id]);
  await ownerPool.query("insert into vehicles (org_id, property_id, unit_id, resident_id, plate, make) values ($1, $2, $3, $4, $5, 'Civic')", [orgId, unit.property_id, unit.id, r.rows[0].id, `PRV${label.length}${randomUUID().slice(0, 3).toUpperCase()}`]);
  const t = await ownerPool.query("insert into message_threads (org_id, property_id, unit_id, resident_id, resident_user_id, subject, last_message_at) values ($1, $2, $3, $4, $5, 'Noise', now()) returning id", [orgId, unit.property_id, unit.id, r.rows[0].id, u.rows[0].id]);
  await ownerPool.query("insert into messages (org_id, thread_id, author_user_id, body) values ($1, $2, $3, 'My neighbour plays drums at 2am — call me on 604-555-0199')", [orgId, t.rows[0].id, u.rows[0].id]);
  await ownerPool.query("insert into ai_conversations (org_id, user_id, title) values ($1, $2, 'my lease')", [orgId, u.rows[0].id]);
  await ownerPool.query(`insert into work_orders (org_id, number, property_id, building_id, unit_id, category, priority, title, description, status, source, submitted_by_user_id, resident_id, entry_notes)
    values ($1, (select coalesce(max(number), 0) + 1 from work_orders where org_id = $1), $2, $3, $4, 'plumbing', 'normal', $5, 'Drip under the sink', 'new', 'resident', $6, $7, 'Key under the mat')`,
  [orgId, unit.property_id, unit.building_id, unit.id, `Sink drip for ${label}`, u.rows[0].id, r.rows[0].id]);
  const person = { userId: u.rows[0].id, residentId: r.rows[0].id, unitId: unit.id, propertyId: unit.property_id, buildingId: unit.building_id, email };
  made.push(person);
  return person;
}

beforeAll(async () => {
  orgId = await orgIdBySlug("pacific-properties");
  admin = await ctxFor("admin@demo.test");
  pm = await ctxFor("pm@demo.test");
}, 60_000);
afterAll(async () => {
  // everything this file made, so other files see the seeded organization
  const r = made.map((m) => m.residentId);
  const u = made.map((m) => m.userId);
  const del = (sql: string, ids: string[]) => ownerPool.query(sql, [ids]);
  await del("delete from messages where thread_id in (select id from message_threads where resident_id = any($1))", r);
  await del("delete from message_threads where resident_id = any($1)", r);
  await del("delete from work_orders where resident_id = any($1)", r);
  await del("delete from visitors where host_resident_id = any($1)", r);
  await del("delete from vehicles where resident_id = any($1)", r);
  await del("delete from legal_holds where resident_id = any($1)", r);
  await del("delete from privacy_requests where resident_id = any($1)", r);
  await del("delete from unit_occupancies where resident_id = any($1)", r);
  await del("delete from residents where id = any($1)", r);
  await del("delete from ai_conversations where user_id = any($1)", u);
  await del("delete from memberships where user_id = any($1)", u);
  await del("delete from users where id = any($1)", u);
  await ownerPool.query("delete from retention_policies where org_id = $1", [orgId]);
  await closeDb();
  await ownerPool.end();
});

describe("export", () => {
  it("collects this person's records — not anyone else's — and only privacy managers can run or download it", async () => {
    const a = await makePerson("Ada");
    const b = await makePerson("Bea");
    await expect(exportPerson(pm, a.residentId)).rejects.toThrow(ForbiddenError);
    const { requestId, counts } = await exportPerson(admin, a.residentId);
    expect(counts).toMatchObject({ vehicles: 1, workOrders: 1, messageThreads: 1, assistantConversations: 1, occupancies: 1 });
    await expect(openExport(pm, requestId)).rejects.toThrow(ForbiddenError);
    const { bytes, filename } = await openExport(admin, requestId);
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    expect(filename).toMatch(/^personal-data-ada-example-/);
    expect(doc.profile.email).toBe(a.email);
    expect(JSON.stringify(doc)).toContain("Sink drip for Ada");
    expect(JSON.stringify(doc)).not.toContain(b.email);
    expect(JSON.stringify(doc)).not.toContain("Sink drip for Bea");
    const audit = await ownerPool.query("select action from audit_logs where org_id = $1 and action in ('privacy.exported','privacy.export_downloaded') and entity_id in ($2, $3)", [orgId, a.residentId, requestId]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(["privacy.export_downloaded", "privacy.exported"]);
  });
});

describe("erasure and legal holds", () => {
  it("a legal hold blocks erasure (and the attempt is recorded); after release the person is erased", async () => {
    const p = await makePerson("Cy");
    const hold = await placeLegalHold(admin, p.residentId, "insurance claim 2026-114");
    const blocked = await erasePerson(admin, p.residentId, { reason: "request by email" });
    expect(blocked.status).toBe("blocked");
    expect((await ownerPool.query("select first_name from residents where id = $1", [p.residentId])).rows[0].first_name).toBe("Cy");
    await releaseLegalHold(admin, hold.id);

    const done = await erasePerson(admin, p.residentId, { reason: "request by email" });
    expect(done.status).toBe("completed");
    const r = (await ownerPool.query("select first_name, last_name, email, phone, user_id from residents where id = $1", [p.residentId])).rows[0];
    expect(r).toEqual({ first_name: "Former", last_name: "resident", email: null, phone: null, user_id: null });
    expect((await ownerPool.query("select plate, make, active from vehicles where resident_id = $1", [p.residentId])).rows[0]).toEqual({ plate: "ERASED", make: null, active: false });
    expect((await ownerPool.query("select body from messages where author_user_id = $1", [p.userId])).rows.map((x) => x.body)).toEqual(["[erased]"]);
    expect((await ownerPool.query("select count(*)::int n from ai_conversations where user_id = $1", [p.userId])).rows[0].n).toBe(0);
    const wo = (await ownerPool.query("select title, entry_notes from work_orders where resident_id = $1", [p.residentId])).rows[0];
    expect(wo).toEqual({ title: "Sink drip for Cy", entry_notes: null }); // building history stays, without the personal note
    // their only membership was here, so the account itself is anonymized and signed out
    const u = (await ownerPool.query("select email, name, status from users where id = $1", [p.userId])).rows[0];
    expect(u).toEqual({ email: `erased-${p.userId}@invalid`, name: "Erased user", status: "deactivated" });
    // the audit entry says an erasure happened, without the person's details
    const a = (await ownerPool.query("select after::text t from audit_logs where org_id = $1 and action = 'privacy.erased' and entity_id = $2", [orgId, p.residentId])).rows[0].t as string;
    expect(a).not.toContain(p.email);
  });

  it("an account that belongs to other organizations too is kept (only this organization's data goes)", async () => {
    const p = await makePerson("Dee");
    const north = await orgIdBySlug("northshore-strata");
    await ownerPool.query("insert into memberships (org_id, user_id, role_id) values ($1, $2, (select id from roles where key = 'owner' and org_id is null))", [north, p.userId]);
    await erasePerson(admin, p.residentId, { reason: "moved out, asked us to delete" });
    expect((await ownerPool.query("select status, email from users where id = $1", [p.userId])).rows[0]).toEqual({ status: "active", email: p.email });
    expect((await ownerPool.query("select status from memberships where user_id = $1 and org_id = $2", [p.userId, orgId])).rows[0].status).toBe("deactivated");
  });
});

describe("retention", () => {
  it("deletes what's older than the settings say, except for people on legal hold", async () => {
    const free = await makePerson("Eve");
    const held = await makePerson("Fay");
    await placeLegalHold(admin, held.residentId, "pending complaint review");
    const visit = (host: Person, name: string) => ownerPool.query(`insert into visitors (org_id, property_id, building_id, unit_id, host_resident_id, name, kind, expected_from, expected_until, status, checked_out_at)
      values ($1, $2, $3, $4, $5, $6, 'guest', now() - interval '11 years', now() - interval '11 years' + interval '1 hour', 'checked_out', now() - interval '11 years') returning id`, [orgId, host.propertyId, host.buildingId, host.unitId, host.residentId, name]);
    const v1 = await visit(free, "Old guest of Eve");
    const v2 = await visit(held, "Old guest of Fay");
    await ownerPool.query("update messages set created_at = now() - interval '11 years' where author_user_id in ($1, $2)", [free.userId, held.userId]);
    // ten-year cutoffs reach only these decade-old fixtures, never the seeded history other files rely on
    await saveRetention(admin, { messagesDays: 3650, visitorsDays: 3650, parkingEvidenceDays: null, assistantDays: null, auditDays: 3650 });
    const out = await applyRetention();
    expect(out.visitors).toBeGreaterThanOrEqual(1);
    expect((await ownerPool.query("select 1 from visitors where id = $1", [v1.rows[0].id])).rowCount).toBe(0);
    expect((await ownerPool.query("select 1 from visitors where id = $1", [v2.rows[0].id])).rowCount).toBe(1);
    expect((await ownerPool.query("select count(*)::int n from messages where author_user_id = $1", [free.userId])).rows[0].n).toBe(0);
    expect((await ownerPool.query("select count(*)::int n from messages where author_user_id = $1", [held.userId])).rows[0].n).toBe(1);
    await saveRetention(admin, { messagesDays: null, visitorsDays: null, parkingEvidenceDays: null, assistantDays: null, auditDays: null });
  });
});

describe("consent", () => {
  it("records a row when someone turns email on or off — not on every save", async () => {
    const resident = { principal: (await loadPrincipal(await userIdByEmail("resident@demo.test"), "pacific-properties"))!, meta };
    const rows = async () => (await ownerPool.query("select granted, source from consents where org_id = $1 and user_id = $2 order by created_at", [orgId, resident.principal.userId])).rows;
    const before = (await rows()).length;
    await savePreferences(resident, [{ kind: "package.arrived", email: false, inApp: true }]);
    await savePreferences(resident, [{ kind: "package.arrived", email: false, inApp: false }]);
    await savePreferences(resident, [{ kind: "package.arrived", email: true, inApp: true }]);
    const after = await rows();
    expect(after.slice(before)).toEqual([{ granted: false, source: "preferences" }, { granted: true, source: "preferences" }]);
  });
});
