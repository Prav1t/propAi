import { eq, inArray, isNull, like } from "drizzle-orm";
import { ownerDb } from "./lib";
import * as s from "../src/server/db/schema";
import { hashPassword } from "../src/server/auth/password";
import { seedOps } from "./seed-ops";
import { seedCommunity, seedFile } from "./seed-community";
import { EXTRA_STAFF_DOMAIN, seedFacility, seedFacilityTenant } from "./seed-facility";
import { seedAi } from "./seed-ai";

// deterministic demo data; safe to re-run (removes and recreates demo orgs/users)
export const DEMO_PASSWORD = "DemoPass!2026";

export const DEMO_USERS = {
  superadmin: { email: "superadmin@demo.test", name: "Platform Admin" },
  admin: { email: "admin@demo.test", name: "Priya Sandhu" },
  pm: { email: "pm@demo.test", name: "Marcus Chen" },
  concierge: { email: "concierge@demo.test", name: "Aisha Rahman" },
  facility: { email: "facility@demo.test", name: "Daniel Okafor" },
  staff: { email: "staff@demo.test", name: "Luis Moreno" },
  resident: { email: "resident@demo.test", name: "Emma Tremblay" },
  owner: { email: "owner@demo.test", name: "Noah Williams" },
  vendor: { email: "vendor@demo.test", name: "Jordan Blake" },
  council: { email: "council@demo.test", name: "Harpreet Gill" },
  northshoreAdmin: { email: "admin@northshore.test", name: "Olivia Martin" },
} as const;

// small seeded PRNG so every run produces identical data
function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

const FIRST = ["Olivia","Liam","Emma","Noah","Ava","Ethan","Sophia","Lucas","Mia","Mason","Chloe","Arjun","Mei","Hiro","Fatima","Omar","Zoe","Nathan","Isla","Jack","Aaliyah","Gurpreet","Wei","Ana","Mateo","Sara","Ryan","Leah","Kai","Nadia","Owen","Grace","Ravi","Julia","Theo","Hana","Diego","Amara","Samuel","Elena"];
const LAST = ["Smith","Brown","Tremblay","Martin","Roy","Wilson","Macdonald","Gagnon","Johnson","Taylor","Lee","Wong","Singh","Patel","Nguyen","Kim","Chen","Sandhu","Dhillon","Garcia","Anderson","Campbell","Kowalski","Ahmed","Fraser","Leblanc","Clarke","Grewal","Park","Silva"];

type UnitPlan = { floors: number; perFloor: number; groundCommercial?: number };

async function main() {
  const { db, pool } = ownerDb();
  const demoEmails = Object.values(DEMO_USERS).map((u) => u.email);

  await db.transaction(async (tx) => {
    // wipe previous demo data
    await tx.delete(s.organizations).where(inArray(s.organizations.slug, ["pacific-properties", "northshore-strata"]));
    await tx.delete(s.users).where(inArray(s.users.email, demoEmails));
    await tx.delete(s.users).where(like(s.users.email, `%@${EXTRA_STAFF_DOMAIN}`));

    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const verified = new Date("2026-01-15T17:00:00Z");
    const userRows = await tx.insert(s.users).values(
      Object.values(DEMO_USERS).map((u) => ({ email: u.email, name: u.name, passwordHash, emailVerifiedAt: verified, isPlatformAdmin: u.email === DEMO_USERS.superadmin.email })),
    ).returning();
    const U = (email: string) => userRows.find((u) => u.email === email)!;

    const sysRoles = await tx.select().from(s.roles).where(isNull(s.roles.orgId));
    const R = (key: string) => {
      const r = sysRoles.find((x) => x.key === key);
      if (!r) throw new Error(`System role ${key} missing — run npm run db:migrate first`);
      return r;
    };

    /* ── Pacific Properties Management ── */
    const [pac] = await tx.insert(s.organizations).values({ name: "Pacific Properties Management", slug: "pacific-properties", kind: "property_management", planKey: "professional" }).returning();
    const [pfRes] = await tx.insert(s.portfolios).values({ orgId: pac.id, name: "Vancouver Residential", description: "Residential and strata buildings in Metro Vancouver" }).returning();
    const [pfMix] = await tx.insert(s.portfolios).values({ orgId: pac.id, name: "Mixed-Use & Commercial", description: "Mixed-use towers with retail at grade" }).returning();

    const plan: { name: string; code: string; type: string; city: string; address: string; postal: string; portfolioId: string; buildings: { name: string; code: string; year: number; units: UnitPlan }[] }[] = [
      { name: "Harbour Centre", code: "HBC", type: "residential", city: "Vancouver", address: "555 W Hastings St", postal: "V6B 4N6", portfolioId: pfRes.id,
        buildings: [{ name: "Main Tower", code: "MAIN", year: 2004, units: { floors: 12, perFloor: 6 } }] },
      { name: "Pacific Heights", code: "PCH", type: "strata", city: "Burnaby", address: "4880 Bennett St", postal: "V5H 0A5", portfolioId: pfRes.id,
        buildings: [
          { name: "North Building", code: "N", year: 2011, units: { floors: 8, perFloor: 4 } },
          { name: "South Building", code: "S", year: 2012, units: { floors: 8, perFloor: 4 } },
        ] },
      { name: "Fraser Towers", code: "FRT", type: "mixed_use", city: "New Westminster", address: "660 Quayside Dr", postal: "V3M 0E1", portfolioId: pfMix.id,
        buildings: [
          { name: "Tower A", code: "A", year: 2016, units: { floors: 15, perFloor: 5, groundCommercial: 3 } },
          { name: "Tower B", code: "B", year: 2018, units: { floors: 15, perFloor: 5, groundCommercial: 2 } },
        ] },
      { name: "Kingsway Residences", code: "KWR", type: "rental", city: "Vancouver", address: "3355 Kingsway", postal: "V5R 5K6", portfolioId: pfRes.id,
        buildings: [{ name: "Kingsway Residences", code: "MAIN", year: 1998, units: { floors: 6, perFloor: 8 } }] },
    ];

    const propIds: Record<string, string> = {};
    const buildingIds: Record<string, string> = {};
    let residentCount = 0;
    let unitCount = 0;
    let residentUnitId = "";

    for (const p of plan) {
      const [prop] = await tx.insert(s.properties).values({
        orgId: pac.id, portfolioId: p.portfolioId, name: p.name, code: p.code, type: p.type, addressLine1: p.address, city: p.city, region: "BC", postalCode: p.postal,
      }).returning();
      propIds[p.code] = prop.id;
      for (const b of p.buildings) {
        const [bld] = await tx.insert(s.buildings).values({ orgId: pac.id, propertyId: prop.id, name: b.name, code: b.code, yearBuilt: b.year }).returning();
        buildingIds[`${p.code}-${b.code}`] = bld.id;
        const floorRows = await tx.insert(s.floors).values(
          Array.from({ length: b.units.floors + (b.units.groundCommercial ? 1 : 0) }, (_, i) => {
            const level = b.units.groundCommercial ? i : i + 1;
            return { orgId: pac.id, buildingId: bld.id, level, name: level === 0 ? "Ground" : `Level ${level}` };
          }),
        ).returning();

        const unitValues: (typeof s.units.$inferInsert)[] = [];
        for (const f of floorRows) {
          if (f.level === 0) {
            for (let c = 1; c <= (b.units.groundCommercial ?? 0); c++) {
              unitValues.push({ orgId: pac.id, propertyId: prop.id, buildingId: bld.id, floorId: f.id, number: `CRU-${c}`, type: "commercial", areaSqft: 1200 + Math.floor(rand() * 1800), status: rand() < 0.8 ? "occupied" : "vacant" });
            }
            continue;
          }
          for (let n = 1; n <= b.units.perFloor; n++) {
            const beds = pick([0, 1, 1, 2, 2, 2, 3]);
            const r = rand();
            const forceOccupied = p.code === "FRT" && b.code === "A" && f.level === 8 && n === 5; // demo owner's home
            unitValues.push({
              orgId: pac.id, propertyId: prop.id, buildingId: bld.id, floorId: f.id,
              number: `${f.level}${String(n).padStart(2, "0")}`, type: "residential", bedrooms: beds, bathrooms: beds >= 2 ? "2.0" : "1.0",
              areaSqft: 450 + beds * 280 + Math.floor(rand() * 120),
              status: forceOccupied || r < 0.9 ? "occupied" : r < 0.95 ? "vacant" : r < 0.98 ? "notice" : "renovation",
            });
          }
        }
        const unitRows = await tx.insert(s.units).values(unitValues).returning();
        unitCount += unitRows.length;

        // residents for occupied residential units
        for (const u of unitRows.filter((x) => x.status !== "vacant" && x.type === "residential" && x.status !== "renovation")) {
          const isDemoResident = p.code === "FRT" && b.code === "B" && u.number === "1204";
          const isDemoOwner = p.code === "FRT" && b.code === "A" && u.number === "805";
          const count = isDemoResident ? 1 : isDemoOwner ? 2 : pick([1, 1, 2, 2, 3]);
          for (let i = 0; i < count; i++) {
            const demoUser = isDemoResident ? DEMO_USERS.resident : isDemoOwner && i === 0 ? DEMO_USERS.owner : null;
            const first = isDemoResident ? "Emma" : demoUser ? "Noah" : isDemoOwner ? "Leila" : pick(FIRST);
            const last = isDemoResident ? "Tremblay" : isDemoOwner ? "Williams" : pick(LAST);
            const [res] = await tx.insert(s.residents).values({
              orgId: pac.id, userId: demoUser ? U(demoUser.email).id : null, firstName: first, lastName: last,
              email: demoUser ? demoUser.email : `${first}.${last}.${residentCount}@example.com`.toLowerCase(),
              phone: `604-555-${String(1000 + (residentCount % 9000)).padStart(4, "0")}`,
            }).returning();
            residentCount++;
            const relationship = p.type === "rental" ? (i === 0 ? "tenant" : "occupant") : i === 0 ? pick(["owner", "resident", "tenant"]) : "occupant";
            await tx.insert(s.unitOccupancies).values({
              orgId: pac.id, unitId: u.id, residentId: res.id, relationship: isDemoResident ? "resident" : isDemoOwner ? (i === 0 ? "owner" : "occupant") : relationship, isPrimary: i === 0,
              startsOn: `20${pick(["19", "20", "21", "22", "23", "24", "25"])}-0${1 + Math.floor(rand() * 9)}-01`,
            });
            if (isDemoResident) residentUnitId = u.id;
          }
        }
        // former residents of now-vacant units, so move-out history exists
        for (const u of unitRows.filter((x) => x.status === "vacant" && x.type === "residential")) {
          const first = pick(FIRST);
          const last = pick(LAST);
          const [res] = await tx.insert(s.residents).values({ orgId: pac.id, firstName: first, lastName: last, email: `${first}.${last}.${residentCount}@example.com`.toLowerCase() }).returning();
          residentCount++;
          await tx.insert(s.unitOccupancies).values({ orgId: pac.id, unitId: u.id, residentId: res.id, relationship: "tenant", isPrimary: true, startsOn: "2022-03-01", endsOn: "2026-06-30" });
        }
      }
    }
    if (!residentUnitId) throw new Error("demo resident unit not created");

    // vendors with contacts and property approvals
    const VENDORS: { name: string; cats: string[]; props: string[]; phone: string; sla: number; rate: string; contact: string; areas: string[]; ins: string }[] = [
      { name: "Blake Plumbing & Heating", cats: ["plumbing", "hvac"], props: ["HBC", "FRT", "KWR"], phone: "604-555-0142", sla: 4, rate: "115.00", contact: "Jordan Blake", areas: ["Vancouver", "Burnaby", "New Westminster"], ins: "2027-03-31" },
      { name: "Coastline Electric", cats: ["electrical"], props: ["HBC", "PCH", "FRT", "KWR"], phone: "604-555-0177", sla: 8, rate: "125.00", contact: "Mei Wong", areas: ["Metro Vancouver"], ins: "2026-11-30" },
      { name: "Summit Elevator Services", cats: ["elevator"], props: ["HBC", "FRT"], phone: "604-555-0199", sla: 2, rate: "180.00", contact: "Arjun Patel", areas: ["Metro Vancouver"], ins: "2027-01-15" },
      { name: "Evergreen Landscaping", cats: ["landscaping", "snow_removal"], props: ["PCH", "KWR"], phone: "604-555-0120", sla: 48, rate: "65.00", contact: "Sara Kim", areas: ["Burnaby", "Vancouver"], ins: "2026-10-01" },
      { name: "Pristine Commercial Cleaning", cats: ["cleaning"], props: ["HBC", "PCH", "FRT", "KWR"], phone: "604-555-0133", sla: 24, rate: "48.00", contact: "Ana Silva", areas: ["Metro Vancouver"], ins: "2027-06-30" },
      { name: "Pacific Pest Control", cats: ["pest_control"], props: ["KWR", "PCH"], phone: "604-555-0188", sla: 24, rate: "95.00", contact: "Omar Ahmed", areas: ["Metro Vancouver"], ins: "2026-12-31" },
      { name: "Firewise Safety Systems", cats: ["fire_safety", "security"], props: ["HBC", "PCH", "FRT", "KWR"], phone: "604-555-0111", sla: 4, rate: "140.00", contact: "Liam Fraser", areas: ["Metro Vancouver", "Fraser Valley"], ins: "2027-02-28" },
      { name: "Northwest Roofing", cats: ["roofing"], props: [], phone: "604-555-0166", sla: 72, rate: "110.00", contact: "Grace Campbell", areas: ["Lower Mainland"], ins: "2026-09-30" },
    ];
    const vendorIds: Record<string, string> = {};
    for (const v of VENDORS) {
      const [row] = await tx.insert(s.vendors).values({
        orgId: pac.id, name: v.name, legalName: `${v.name} Ltd.`, email: `dispatch@${v.name.toLowerCase().split(/[^a-z]+/)[0]}.example.com`,
        phone: v.phone, categories: v.cats, serviceAreas: v.areas, slaResponseHours: v.sla, hourlyRate: v.rate, insuranceExpiresOn: v.ins,
        licenseNumber: `BC-${Math.floor(100000 + rand() * 899999)}`, status: v.name === "Northwest Roofing" ? "inactive" : "active",
      }).returning();
      vendorIds[v.name] = row.id;
      await tx.insert(s.vendorContacts).values({ orgId: pac.id, vendorId: row.id, name: v.contact, title: "Dispatch", phone: v.phone, email: `${v.contact.split(" ")[0].toLowerCase()}@example.com`, isPrimary: true });
      for (const code of v.props) await tx.insert(s.vendorProperties).values({ orgId: pac.id, vendorId: row.id, propertyId: propIds[code] });
    }

    // memberships with realistic scopes
    const member = async (email: string, roleKey: string, title: string, scope?: { propertyId?: string; buildingId?: string; portfolioId?: string }[], vendorId?: string) => {
      const [m] = await tx.insert(s.memberships).values({ orgId: pac.id, userId: U(email).id, roleId: R(roleKey).id, title, vendorId }).returning();
      for (const sc of scope ?? []) await tx.insert(s.membershipScopes).values({ orgId: pac.id, membershipId: m.id, ...sc });
      await tx.insert(s.auditLogs).values({ orgId: pac.id, actorUserId: U(DEMO_USERS.admin.email).id, action: "member.added", entityType: "membership", entityId: m.id, after: { email, role: roleKey } });
      return m;
    };
    const profile = async (m: { id: string }, phone: string, skills: string[], employmentType = "full_time") =>
      tx.insert(s.staffProfiles).values({ orgId: pac.id, membershipId: m.id, phone, skills, employmentType });
    await profile(await member(DEMO_USERS.admin.email, "org_admin", "Director of Operations"), "604-555-0101", ["operations", "budgeting"]);
    await profile(await member(DEMO_USERS.pm.email, "property_manager", "Property Manager", [{ propertyId: propIds.HBC }, { propertyId: propIds.FRT }]), "604-555-0102", ["tenant relations", "vendor management"]);
    await profile(await member(DEMO_USERS.concierge.email, "concierge", "Front Desk Concierge", [{ propertyId: propIds.FRT }]), "604-555-0103", ["first aid", "french"], "part_time");
    await profile(await member(DEMO_USERS.facility.email, "facility_manager", "Facility Manager", [{ portfolioId: pfMix.id }]), "604-555-0104", ["hvac", "preventive maintenance", "bms"]);
    await profile(await member(DEMO_USERS.staff.email, "maintenance_staff", "Building Technician", [{ buildingId: buildingIds["HBC-MAIN"] }]), "604-555-0105", ["plumbing", "electrical", "painting"]);
    await member(DEMO_USERS.resident.email, "resident", "Resident, Tower B #1204");
    await member(DEMO_USERS.owner.email, "owner", "Owner, Tower A #805");
    await member(DEMO_USERS.vendor.email, "vendor", "Owner", undefined, vendorIds["Blake Plumbing & Heating"]);
    await profile(await member(DEMO_USERS.council.email, "council_member", "Council President", [{ propertyId: propIds.PCH }]), "604-555-0106", ["governance"], "on_call");
    await tx.insert(s.auditLogs).values({ orgId: pac.id, actorUserId: U(DEMO_USERS.admin.email).id, action: "org.created", entityType: "organization", entityId: pac.id, after: { name: pac.name, source: "seed" } });

    /* ── Northshore Strata (second tenant, used for isolation demos/tests) ── */
    const [ns] = await tx.insert(s.organizations).values({ name: "Northshore Strata Corporation", slug: "northshore-strata", kind: "strata" }).returning();
    const [nsProp] = await tx.insert(s.properties).values({ orgId: ns.id, name: "Lonsdale Quay Lofts", code: "LQL", type: "strata", addressLine1: "123 Carrie Cates Ct", city: "North Vancouver", region: "BC", postalCode: "V7M 3K7" }).returning();
    const [nsBld] = await tx.insert(s.buildings).values({ orgId: ns.id, propertyId: nsProp.id, name: "Lofts", code: "L", yearBuilt: 2009 }).returning();
    for (let f = 1; f <= 5; f++) {
      const [fl] = await tx.insert(s.floors).values({ orgId: ns.id, buildingId: nsBld.id, level: f, name: `Level ${f}` }).returning();
      await tx.insert(s.units).values(Array.from({ length: 6 }, (_, i) => ({ orgId: ns.id, propertyId: nsProp.id, buildingId: nsBld.id, floorId: fl.id, number: `${f}0${i + 1}`, bedrooms: 1 + (i % 2), areaSqft: 700 + i * 40 })));
    }
    const [nsAdmin] = await tx.insert(s.memberships).values({ orgId: ns.id, userId: U(DEMO_USERS.northshoreAdmin.email).id, roleId: R("org_admin").id, title: "Strata Council Treasurer" }).returning();
    await tx.insert(s.staffProfiles).values({ orgId: ns.id, membershipId: nsAdmin.id, phone: "604-555-0900", skills: ["finance"] });
    const [nsVendor] = await tx.insert(s.vendors).values({ orgId: ns.id, name: "North Shore Plumbing", categories: ["plumbing"], phone: "604-555-0901" }).returning();
    await tx.insert(s.vendorContacts).values({ orgId: ns.id, vendorId: nsVendor.id, name: "Kai Park", isPrimary: true });
    await tx.insert(s.vendorProperties).values({ orgId: ns.id, vendorId: nsVendor.id, propertyId: nsProp.id });
    const [nsRes] = await tx.insert(s.residents).values({ orgId: ns.id, firstName: "Tremblay", lastName: "Northshore", email: "tremblay.ns@example.com" }).returning();
    const [nsUnit] = await tx.select().from(s.units).where(eq(s.units.propertyId, nsProp.id)).limit(1);
    await tx.insert(s.unitOccupancies).values({ orgId: ns.id, unitId: nsUnit.id, residentId: nsRes.id, relationship: "owner", isPrimary: true });
    // the platform demo admin also sits on the Northshore council, to demo org switching
    const [adminNs] = await tx.insert(s.memberships).values({ orgId: ns.id, userId: U(DEMO_USERS.admin.email).id, roleId: R("council_member").id, title: "Council Member" }).returning();
    await tx.insert(s.membershipScopes).values({ orgId: ns.id, membershipId: adminNs.id, propertyId: nsProp.id });

    // a little operations data in the second tenant so isolation tests cover every ops table
    const nsUser = U(DEMO_USERS.northshoreAdmin.email).id;
    const [nsWo] = await tx.insert(s.workOrders).values({ orgId: ns.id, number: 1, propertyId: nsProp.id, buildingId: nsBld.id, unitId: nsUnit.id, category: "plumbing", priority: "normal", title: "Dripping tap in 101", status: "assigned", vendorId: nsVendor.id, submittedByUserId: nsUser, source: "staff" }).returning();
    await tx.insert(s.timelineEvents).values({ orgId: ns.id, entityType: "work_order", entityId: nsWo.id, kind: "created", visibility: "public", actorUserId: nsUser, body: "Request #1 submitted." });
    await tx.insert(s.slaPolicies).values({ orgId: ns.id, priority: "urgent", respondMinutes: 30, resolveMinutes: 720 });
    await tx.insert(s.triageRules).values({ orgId: ns.id, name: "Leaks", keywords: ["leak"], setPriority: "high" });
    const [nsTask] = await tx.insert(s.tasks).values({ orgId: ns.id, propertyId: nsProp.id, title: "Renew strata insurance", createdByUserId: nsUser, assignedMembershipId: nsAdmin.id }).returning();
    await tx.insert(s.taskChecklistItems).values({ orgId: ns.id, taskId: nsTask.id, label: "Collect quotes" });
    const [nsTpl] = await tx.insert(s.inspectionTemplates).values({ orgId: ns.id, name: "Annual walk-through", kind: "property", items: [{ section: "General", label: "Roof drains clear" }] }).returning();
    const [nsInsp] = await tx.insert(s.inspections).values({ orgId: ns.id, templateId: nsTpl.id, propertyId: nsProp.id, buildingId: nsBld.id, kind: "property", title: "Annual walk-through", scheduledFor: "2026-11-15" }).returning();
    await tx.insert(s.inspectionItems).values({ orgId: ns.id, inspectionId: nsInsp.id, section: "General", label: "Roof drains clear" });
    await tx.insert(s.incidents).values({ orgId: ns.id, number: 1, propertyId: nsProp.id, buildingId: nsBld.id, type: "security", severity: "low", title: "Lobby door left propped open", occurredAt: new Date(), reportedByUserId: nsUser });
    await tx.insert(s.complaints).values({ orgId: ns.id, number: 1, propertyId: nsProp.id, buildingId: nsBld.id, unitId: nsUnit.id, category: "noise", subject: "Barking dog", description: "Dog barks most afternoons." });
    await tx.insert(s.orgCounters).values([{ orgId: ns.id, key: "work_order", value: 1 }, { orgId: ns.id, key: "incident", value: 1 }, { orgId: ns.id, key: "complaint", value: 1 }]);
    await tx.insert(s.notifications).values({ orgId: ns.id, userId: nsUser, kind: "workorder.created", title: "New request #1", href: `/o/northshore-strata/maintenance/${nsWo.id}`, entityType: "work_order", entityId: nsWo.id });
    await tx.insert(s.notificationPreferences).values({ orgId: ns.id, userId: nsUser, kind: "task.assigned", email: true, inApp: true });
    await tx.insert(s.outboxEvents).values({ orgId: ns.id, type: "workorder.created", payload: { workOrderId: nsWo.id }, processedAt: new Date() });
    // one already-delivered event in the demo org too, so the outbox isolation checks never depend on test order
    await tx.insert(s.outboxEvents).values({ orgId: pac.id, type: "seed.completed", payload: {}, processedAt: new Date() });

    // community rows in the second tenant too, so isolation tests cover every table
    const [nsAm] = await tx.insert(s.amenities).values({ orgId: ns.id, propertyId: nsProp.id, name: "Guest Lounge", kind: "lounge" }).returning();
    await tx.insert(s.amenityBlackouts).values({ orgId: ns.id, amenityId: nsAm.id, startsAt: new Date("2026-12-24T08:00:00Z"), endsAt: new Date("2026-12-26T08:00:00Z"), reason: "Holidays" });
    await tx.insert(s.bookings).values({ orgId: ns.id, number: 1, amenityId: nsAm.id, propertyId: nsProp.id, unitId: nsUnit.id, residentId: nsRes.id, startsAt: new Date("2026-11-07T02:00:00Z"), endsAt: new Date("2026-11-07T04:00:00Z"), status: "approved" });
    await tx.insert(s.packages).values({ orgId: ns.id, propertyId: nsProp.id, buildingId: nsBld.id, unitId: nsUnit.id, residentId: nsRes.id, recipientName: "Tremblay Northshore", carrier: "Canada Post", pickupCode: "424242" });
    const [nsAnn] = await tx.insert(s.announcements).values({ orgId: ns.id, propertyId: nsProp.id, title: "Window washing Friday", body: "Please keep blinds closed.", status: "published", publishedAt: new Date() }).returning();
    await tx.insert(s.announcementReads).values({ orgId: ns.id, announcementId: nsAnn.id, userId: nsUser });
    const [nsThread] = await tx.insert(s.messageThreads).values({ orgId: ns.id, propertyId: nsProp.id, buildingId: nsBld.id, unitId: nsUnit.id, residentId: nsRes.id, subject: "Locker key", lastMessagePreview: "Spare key?" }).returning();
    await tx.insert(s.messages).values({ orgId: ns.id, threadId: nsThread.id, body: "Spare key?" });
    await tx.insert(s.messageReads).values({ orgId: ns.id, threadId: nsThread.id, userId: nsUser });
    await tx.insert(s.messageTemplates).values({ orgId: ns.id, name: "Thanks", body: "Thanks {{resident_first_name}}!" });
    const [nsDoc] = await tx.insert(s.documents).values({ orgId: ns.id, propertyId: nsProp.id, title: "Lonsdale bylaws", category: "bylaws", audience: "owners", currentVersion: 1 }).returning();
    const nsFile = await seedFile(tx, ns.id, "document", nsDoc.id, "bylaws.txt", new TextEncoder().encode("Lonsdale Quay Lofts bylaws\n"), "text/plain");
    await tx.insert(s.documentVersions).values({ orgId: ns.id, documentId: nsDoc.id, version: 1, fileId: nsFile.id });
    await seedFacilityTenant(tx, { orgId: ns.id, propertyId: nsProp.id, buildingId: nsBld.id, unitId: nsUnit.id, membershipId: nsAdmin.id, userId: nsUser });

    const ops = await seedOps(tx, pac.id);
    console.log(`✓ operations: ${ops.workOrders} work orders, ${ops.tasks} tasks, ${ops.inspections} inspections, ${ops.incidents} incidents, ${ops.complaints} complaints`);
    const com = await seedCommunity(tx, pac.id);
    console.log(`✓ community: ${com.amenities} amenities, ${com.bookings} bookings, ${com.packages} packages, ${com.announcements} announcements, ${com.documents} documents`);
    const fac = await seedFacility(tx, pac.id);
    console.log(`✓ front desk & facility: ${fac.visitors} visitors, ${fac.spaces} parking spaces, ${fac.vehicles} vehicles, ${fac.permits} permits, ${fac.violations} violation reports, ${fac.shifts} shifts, ${fac.assets} assets`);
    console.log(`✓ seeded 2 orgs, ${Object.keys(propIds).length + 1} properties, ${unitCount + 30} units, ${residentCount} residents, ${userRows.length} demo users`);
  });
  await pool.end();
  // after the commit: the assistant runs through the app's own connection and permission checks
  const ai = await seedAi();
  console.log(`✓ assistant: ${ai.conversations} conversations, ${ai.toolCalls} tool calls, ${ai.plans} plans (demo model)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
