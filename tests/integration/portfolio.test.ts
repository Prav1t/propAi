import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addFloor, createBuilding, createPortfolio, createProperty, createUnit, deleteBuilding, deleteProperty, deleteUnit,
  generateUnits, getBuilding, getProperty, getUnit, listPortfolios, listProperties, listUnits, updateProperty, updateUnit,
} from "@/server/modules/portfolio/service";
import {
  addOccupancy, createResident, endOccupancy, getResident, inviteResident, listResidents, listStaff, updateResident, updateStaffProfile,
} from "@/server/modules/people/service";
import {
  addContact, assignVendorProperty, createVendor, deleteVendor, getVendor, inviteVendorUser, listVendors, unassignVendorProperty, updateVendor,
} from "@/server/modules/vendors/service";
import { globalSearch } from "@/server/modules/search/service";
import { acceptInvitationAsNewUser } from "@/server/modules/members/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import type { TenantCtx } from "@/server/modules/context";
import { latestEmailLink, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.9", userAgent: "vitest", requestId: "t" };
const uniq = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

const ids: Record<string, string> = {};
beforeAll(async () => {
  const { rows } = await ownerPool.query("select code, id from properties");
  for (const r of rows) ids[r.code] = r.id;
  const b = await ownerPool.query("select b.id, p.code, b.code bcode from buildings b join properties p on p.id = b.property_id");
  for (const r of b.rows) ids[`${r.code}-${r.bcode}`] = r.id;
});
afterAll(async () => {
  await closeDb();
  await ownerPool.end();
});

describe("properties", () => {
  it("lists with real counts, search and type filter", async () => {
    const admin = await ctxFor("admin@demo.test");
    const all = await listProperties(admin, {});
    expect(all.total).toBe(4);
    const hbc = all.rows.find((r) => r.code === "HBC")!;
    const { rows } = await ownerPool.query("select count(*)::int n from units where property_id = $1", [ids.HBC]);
    expect(hbc.unitCount).toBe(rows[0].n);
    expect((await listProperties(admin, { q: "fras" })).rows.map((r) => r.code)).toEqual(["FRT"]);
    expect((await listProperties(admin, { type: "strata" })).rows.map((r) => r.code)).toEqual(["PCH"]);
  });
  it("scopes a property manager to their properties (list, detail, not found for others)", async () => {
    const pm = await ctxFor("pm@demo.test");
    expect((await listProperties(pm, {})).rows.map((r) => r.code).sort()).toEqual(["FRT", "HBC"]);
    await expect(getProperty(pm, ids.PCH)).rejects.toThrow(ForbiddenError);
    const d = await getProperty(pm, ids.HBC);
    expect(d.canManage).toBe(true);
    expect(d.canDelete).toBe(false);
  });
  it("another org's property id is not found", async () => {
    const ns = await ctxFor("admin@northshore.test", "northshore-strata");
    await expect(getProperty(ns, ids.HBC)).rejects.toThrow(NotFoundError);
    await expect(updateProperty(ns, ids.HBC, { name: "Hijack", code: "HJK", type: "residential", portfolioId: null, addressLine1: null, city: null, region: null, postalCode: null, timezone: "UTC" })).rejects.toThrow(NotFoundError);
  });
  it("property-scoped managers cannot create properties; org admins can, codes are unique", async () => {
    const pm = await ctxFor("pm@demo.test");
    const input = { name: "Test Tower", code: `T${uniq()}`, type: "residential" as const, portfolioId: null, addressLine1: null, city: "Surrey", region: "BC", postalCode: null, timezone: "America/Vancouver" };
    await expect(createProperty(pm, input)).rejects.toThrow(ValidationError); // needs a portfolio they manage
    const admin = await ctxFor("admin@demo.test");
    const p = await createProperty(admin, input);
    await expect(createProperty(admin, input)).rejects.toThrow(/already uses this code/);
    await expect(deleteProperty(admin, p.id, "WRONG")).rejects.toThrow(ValidationError);
    await deleteProperty(admin, p.id, input.code);
    await expect(getProperty(admin, p.id)).rejects.toThrow(NotFoundError);
    const { rows } = await ownerPool.query("select action from audit_logs where entity_id = $1 order by created_at", [p.id]);
    expect(rows.map((r) => r.action)).toEqual(["property.created", "property.deleted"]);
  });
  it("a PM can edit their property but not move it into an arbitrary portfolio", async () => {
    const pm = await ctxFor("pm@demo.test");
    const d = await getProperty(pm, ids.HBC);
    const p = d.property;
    const base = { name: p.name, code: p.code, type: p.type as "residential", portfolioId: p.portfolioId, addressLine1: p.addressLine1, city: p.city, region: p.region, postalCode: p.postalCode, timezone: p.timezone };
    await updateProperty(pm, ids.HBC, { ...base, city: "Vancouver" });
    const other = (await listPortfolios(await ctxFor("admin@demo.test"))).find((x) => x.id !== p.portfolioId)!;
    await expect(updateProperty(pm, ids.HBC, { ...base, portfolioId: other.id })).rejects.toThrow(ForbiddenError);
  });
  it("portfolio-scoped managers see the portfolio's properties; only org admins create portfolios", async () => {
    const fm = await ctxFor("facility@demo.test");
    expect((await listProperties(fm, {})).rows.map((r) => r.code)).toEqual(["FRT"]);
    await expect(createPortfolio(fm, { name: "Mine", description: null })).rejects.toThrow(ForbiddenError);
  });
});

describe("buildings, floors and units", () => {
  it("creates a building with floors, generates units idempotently, and enforces uniqueness", async () => {
    const admin = await ctxFor("admin@demo.test");
    const b = await createBuilding(admin, ids.KWR, { name: "Annex", code: `X${uniq()}`, yearBuilt: 2024, floorsAbove: 2, hasGround: true });
    const g1 = await generateUnits(admin, b.id, { fromLevel: 1, toLevel: 3, perFloor: 4, type: "residential" });
    expect(g1).toEqual({ created: 12, skipped: 0 });
    const g2 = await generateUnits(admin, b.id, { fromLevel: 3, toLevel: 3, perFloor: 5, type: "residential" });
    expect(g2).toEqual({ created: 1, skipped: 4 });
    const d = await getBuilding(admin, b.id);
    expect(d.floors.map((f) => f.level).sort()).toEqual([0, 1, 2, 3]);
    expect(d.units.map((u) => u.number)).toContain("305");
    await expect(addFloor(admin, b.id, { level: 2, name: null })).rejects.toThrow(/already exists/);
    await expect(createUnit(admin, b.id, { number: "101", floorId: null, type: "residential", status: "vacant", bedrooms: null, bathrooms: null, areaSqft: null })).rejects.toThrow(/already has a unit/);
    await deleteBuilding(admin, b.id);
  });
  it("occupant counts on the stacking plan come from the unit's own occupancies", async () => {
    const admin = await ctxFor("admin@demo.test");
    const d = await getBuilding(admin, ids["FRT-B"]);
    const u1204 = d.units.find((u) => u.number === "1204")!;
    const { rows } = await ownerPool.query("select count(*)::int n from unit_occupancies where unit_id = $1 and (ends_on is null or ends_on >= current_date)", [u1204.id]);
    expect(u1204.occupants).toBe(rows[0].n);
    expect(u1204.occupants).toBeGreaterThan(0);
  });
  it("building-scoped staff can't manage units in other buildings", async () => {
    const tech = await ctxFor("staff@demo.test");
    await expect(getBuilding(tech, ids["FRT-A"])).rejects.toThrow(ForbiddenError);
    const hbc = await getBuilding(tech, ids["HBC-MAIN"]);
    expect(hbc.canManageUnits).toBe(false); // maintenance staff can read, not edit
  });
  it("units list honours scope and filters", async () => {
    const pm = await ctxFor("pm@demo.test");
    const all = await listUnits(pm, {});
    const { rows } = await ownerPool.query("select count(*)::int n from units where property_id = any($1)", [[ids.HBC, ids.FRT]]);
    expect(all.total).toBe(rows[0].n);
    expect((await listUnits(pm, { propertyId: ids.PCH })).total).toBe(0);
    const hit = await listUnits(pm, { q: "1204", buildingId: ids["FRT-B"] });
    expect(hit.rows.map((r) => r.number)).toEqual(["1204"]);
  });
  it("residents see only their own unit and never neighbours' contact details", async () => {
    const res = await ctxFor("resident@demo.test");
    const mine = await listUnits(res, {});
    expect(mine.total).toBe(1);
    const unit = await getUnit(res, mine.rows[0].id);
    expect(unit.seeResidentDetails).toBe(false);
    expect(unit.occupancies.every((o) => o.email === null && o.phone === null)).toBe(true);
    const { rows } = await ownerPool.query("select id from units where building_id = $1 and number = '1203'", [ids["FRT-B"]]);
    await expect(getUnit(res, rows[0].id)).rejects.toThrow(ForbiddenError);
  });
  it("units with current residents can't be deleted; edits are audited", async () => {
    const admin = await ctxFor("admin@demo.test");
    const { rows } = await ownerPool.query("select u.* from units u join unit_occupancies o on o.unit_id = u.id where u.property_id = $1 and o.ends_on is null limit 1", [ids.KWR]);
    const u = rows[0];
    await expect(deleteUnit(admin, u.id)).rejects.toThrow(/current residents/);
    await updateUnit(admin, u.id, { number: u.number, floorId: u.floor_id, type: "residential", status: "notice", bedrooms: 2, bathrooms: "1.0", areaSqft: 800 });
    const { rows: a } = await ownerPool.query("select after->>'status' s from audit_logs where entity_id = $1 and action = 'unit.updated' order by created_at desc limit 1", [u.id]);
    expect(a[0].s).toBe("notice");
  });
});

describe("residents", () => {
  it("move-in, move-out and history with unit status updates", async () => {
    const admin = await ctxFor("admin@demo.test");
    const { rows } = await ownerPool.query("select u.id, u.number, u.building_id from units u where u.property_id = $1 and u.status = 'vacant' and u.type = 'residential' limit 1", [ids.KWR]);
    const unit = rows[0];
    const r = await createResident(admin, { firstName: "Nova", lastName: `Tester${uniq()}`, email: `nova-${uniq().toLowerCase()}@example.test`, phone: null, notes: null },
      { buildingId: unit.building_id, unitNumber: unit.number, relationship: "tenant", isPrimary: true, startsOn: "2026-09-01" });
    expect((await ownerPool.query("select status from units where id = $1", [unit.id])).rows[0].status).toBe("occupied");
    const d = await getResident(admin, r.id);
    expect(d.occupancies).toHaveLength(1);
    await expect(endOccupancy(admin, d.occupancies[0].id, "2026-08-01")).rejects.toThrow(/before move-in/);
    await endOccupancy(admin, d.occupancies[0].id, "2026-09-10");
    expect((await ownerPool.query("select status from units where id = $1", [unit.id])).rows[0].status).toBe("vacant");
    const past = await listResidents(admin, { q: r.lastName, status: "past" });
    expect(past.rows.map((x) => x.id)).toEqual([r.id]);
    expect((await listResidents(admin, { q: r.lastName })).total).toBe(0); // not current
  });
  it("scoped managers only see and manage residents in their properties", async () => {
    const pm = await ctxFor("pm@demo.test");
    const list = await listResidents(pm, {});
    const { rows } = await ownerPool.query(`select count(distinct o.resident_id)::int n from unit_occupancies o join units u on u.id = o.unit_id
      where u.property_id = any($1) and (o.ends_on is null or o.ends_on >= current_date)`, [[ids.HBC, ids.FRT]]);
    expect(list.total).toBe(rows[0].n);
    const { rows: other } = await ownerPool.query(`select o.resident_id from unit_occupancies o join units u on u.id = o.unit_id where u.property_id = $1 limit 1`, [ids.PCH]);
    await expect(getResident(pm, other[0].resident_id)).rejects.toThrow(NotFoundError);
    await expect(updateResident(pm, other[0].resident_id, { firstName: "X", lastName: "Y", email: null, phone: null, notes: null })).rejects.toThrow(NotFoundError);
    await expect(addOccupancy(pm, list.rows[0].id, { buildingId: ids["PCH-N"], unitNumber: "101", relationship: "owner", isPrimary: false, startsOn: null })).rejects.toThrow(ForbiddenError);
  });
  it("scoped managers must place new residents in a unit they manage", async () => {
    const pm = await ctxFor("pm@demo.test");
    const input = { firstName: "No", lastName: "Unit", email: null, phone: null, notes: null };
    await expect(createResident(pm, input, null)).rejects.toThrow(ValidationError);
    await expect(createResident(pm, input, { buildingId: ids["PCH-N"], unitNumber: "101", relationship: "tenant", isPrimary: false, startsOn: null })).rejects.toThrow(ForbiddenError);
    await expect(createResident(pm, input, { buildingId: ids["HBC-MAIN"], unitNumber: "9999", relationship: "tenant", isPrimary: false, startsOn: null })).rejects.toThrow(/No unit 9999/);
  });
  it("resident app invitation links the new login to the resident's unit", async () => {
    const admin = await ctxFor("admin@demo.test");
    const { rows } = await ownerPool.query(`select u.number, u.building_id, u.id from units u where u.property_id = $1 and u.status = 'vacant' and u.type = 'residential' limit 1`, [ids.HBC]);
    const email = `res-${uniq().toLowerCase()}@example.test`;
    const r = await createResident(admin, { firstName: "Iris", lastName: "Invitee", email, phone: null, notes: null },
      { buildingId: rows[0].building_id, unitNumber: rows[0].number, relationship: "owner", isPrimary: true, startsOn: null });
    await inviteResident(admin, r.id);
    const token = (await latestEmailLink(email, "/invite/")).split("/invite/")[1];
    await acceptInvitationAsNewUser(token, { name: "Iris Invitee", password: "resident passphrase 9" }, meta);
    const p = await loadPrincipal(await userIdByEmail(email), "pacific-properties");
    expect(p?.role.key).toBe("owner");
    expect([...p!.unitIds]).toEqual([rows[0].id]);
    await expect(inviteResident(admin, r.id)).rejects.toThrow(/already has app access/);
  });
});

describe("staff", () => {
  it("lists staff with coverage; people edit their own profile but not others'", async () => {
    const pm = await ctxFor("pm@demo.test");
    const staff = await listStaff(pm, {});
    expect(staff.some((s) => s.roleKey === "resident" || s.roleKey === "vendor")).toBe(false);
    const concierge = staff.find((s) => s.email === "concierge@demo.test")!;
    expect(concierge.scopes).toEqual(["Fraser Towers"]);
    await updateStaffProfile(pm, pm.principal.membershipId, { title: "Senior PM", phone: "604-555-7777", skills: ["leasing"], employmentType: "full_time", notes: null });
    await expect(updateStaffProfile(pm, concierge.membershipId, { title: null, phone: null, skills: [], employmentType: "full_time", notes: null })).rejects.toThrow(ForbiddenError);
    expect((await listStaff(pm, { q: "leasing" })).map((s) => s.email)).toContain("pm@demo.test");
  });
});

describe("vendors", () => {
  it("org admins manage the directory; names are unique per org", async () => {
    const admin = await ctxFor("admin@demo.test");
    const input = { name: `Acme Glass ${uniq()}`, legalName: null, email: null, phone: null, website: null, categories: ["general_contractor"], serviceAreas: [], status: "active" as const, licenseNumber: null, insuranceExpiresOn: null, hourlyRate: null, slaResponseHours: 24, notes: null };
    const v = await createVendor(admin, input, null);
    await expect(createVendor(admin, { ...input, name: input.name.toUpperCase() }, null)).rejects.toThrow(/already exists/);
    await addContact(admin, v.id, { name: "Pat Glass", title: null, email: null, phone: null, isPrimary: true });
    expect((await listVendors(admin, { category: "general_contractor" })).rows.map((r) => r.id)).toContain(v.id);
    await deleteVendor(admin, v.id);
  });
  it("scoped managers create vendors only for their properties and edit only vendors serving them", async () => {
    const pm = await ctxFor("pm@demo.test");
    const input = { name: `PM Vendor ${uniq()}`, legalName: null, email: null, phone: null, website: null, categories: ["painting"], serviceAreas: [], status: "active" as const, licenseNumber: null, insuranceExpiresOn: null, hourlyRate: null, slaResponseHours: null, notes: null };
    await expect(createVendor(pm, input, null)).rejects.toThrow(ValidationError);
    await expect(createVendor(pm, input, ids.PCH)).rejects.toThrow(ForbiddenError);
    const v = await createVendor(pm, input, ids.HBC);
    await updateVendor(pm, v.id, { ...input, notes: "ok" });
    const { rows } = await ownerPool.query("select id from vendors where name = 'Evergreen Landscaping'");
    await expect(updateVendor(pm, rows[0].id, { ...input, name: "Evergreen Landscaping" })).rejects.toThrow(ForbiddenError); // serves PCH/KWR only
    await expect(assignVendorProperty(pm, v.id, ids.PCH)).rejects.toThrow(ForbiddenError);
    await assignVendorProperty(pm, v.id, ids.FRT);
    await unassignVendorProperty(pm, v.id, ids.FRT);
    await expect(deleteVendor(pm, v.id)).rejects.toThrow(ForbiddenError);
  });
  it("vendor detail hides properties the viewer can't see", async () => {
    const pm = await ctxFor("pm@demo.test");
    const { rows } = await ownerPool.query("select id from vendors where name = 'Coastline Electric'");
    const d = await getVendor(pm, rows[0].id);
    expect(d.properties.map((p) => p.code).sort()).toEqual(["FRT", "HBC"]);
    const listed = (await listVendors(await ctxFor("admin@demo.test"), { q: "coastline" })).rows[0];
    expect(listed.propertyCount).toBe(4);
    expect(listed.primaryContact).toBe("Mei Wong");
  });
  it("vendor users are linked to their company", async () => {
    const vendorUser = await ctxFor("vendor@demo.test");
    const { rows } = await ownerPool.query("select id from vendors where name = 'Blake Plumbing & Heating'");
    expect(vendorUser.principal.vendorId).toBe(rows[0].id);
    await expect(listVendors(vendorUser, {})).rejects.toThrow(ForbiddenError);
    const admin = await ctxFor("admin@demo.test");
    const email = `tech-${uniq().toLowerCase()}@example.test`;
    await inviteVendorUser(admin, rows[0].id, email);
    const token = (await latestEmailLink(email, "/invite/")).split("/invite/")[1];
    await acceptInvitationAsNewUser(token, { name: "Tech Two", password: "vendor passphrase 11" }, meta);
    const p = await loadPrincipal(await userIdByEmail(email), "pacific-properties");
    expect(p?.role.key).toBe("vendor");
    expect(p?.vendorId).toBe(rows[0].id);
  });
});

describe("global search", () => {
  it("is scoped: PMs don't find residents or buildings outside their properties", async () => {
    const pm = await ctxFor("pm@demo.test");
    const hits = await globalSearch(pm, "north", 20);
    expect(hits.some((h) => h.type === "building" && h.title === "North Building")).toBe(false);
    const admin = await ctxFor("admin@demo.test");
    expect((await globalSearch(admin, "north", 20)).some((h) => h.type === "building" && h.title === "North Building")).toBe(true);
  });
  it("never crosses tenants", async () => {
    const admin = await ctxFor("admin@demo.test");
    const hits = await globalSearch(admin, "tremblay", 20);
    expect(hits.some((h) => h.title.includes("Northshore"))).toBe(false);
    expect(hits.some((h) => h.title === "Emma Tremblay")).toBe(true);
    const ns = await ctxFor("admin@northshore.test", "northshore-strata");
    const nsHits = await globalSearch(ns, "tremblay", 20);
    expect(nsHits.map((h) => h.title)).toEqual(["Tremblay Northshore"]);
  });
  it("residents only find their own unit; vendors find nothing", async () => {
    const res = await ctxFor("resident@demo.test");
    const hits = await globalSearch(res, "12", 20);
    expect(hits.every((h) => h.type === "unit")).toBe(true);
    expect(hits.map((h) => h.title)).toEqual(["Unit 1204"]);
    expect(await globalSearch(await ctxFor("vendor@demo.test"), "a", 20)).toEqual([]);
  });
  it("finds residents by email and phone digits", async () => {
    const admin = await ctxFor("admin@demo.test");
    expect((await listResidents(admin, { q: "resident@demo.test" })).rows.map((r) => r.firstName)).toEqual(["Emma"]);
    const { rows } = await ownerPool.query("select phone, id from residents where phone is not null and org_id = (select id from organizations where slug = 'pacific-properties') limit 1");
    expect((await listResidents(admin, { q: rows[0].phone, status: "all" })).rows.map((r) => r.id)).toContain(rows[0].id);
  });
  it("ignores tsquery syntax in user input", async () => {
    const admin = await ctxFor("admin@demo.test");
    await expect(globalSearch(admin, "fra & | ! :* ( ) ' \\", 5)).resolves.toBeInstanceOf(Array);
  });
});
