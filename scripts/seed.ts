import { inArray, isNull } from "drizzle-orm";
import { ownerDb } from "./lib";
import * as s from "../src/server/db/schema";
import { hashPassword } from "../src/server/auth/password";

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
            unitValues.push({
              orgId: pac.id, propertyId: prop.id, buildingId: bld.id, floorId: f.id,
              number: `${f.level}${String(n).padStart(2, "0")}`, type: "residential", bedrooms: beds, bathrooms: beds >= 2 ? "2.0" : "1.0",
              areaSqft: 450 + beds * 280 + Math.floor(rand() * 120),
              status: r < 0.9 ? "occupied" : r < 0.95 ? "vacant" : r < 0.98 ? "notice" : "renovation",
            });
          }
        }
        const unitRows = await tx.insert(s.units).values(unitValues).returning();
        unitCount += unitRows.length;

        // residents for occupied residential units
        for (const u of unitRows.filter((x) => x.status !== "vacant" && x.type === "residential" && x.status !== "renovation")) {
          const isDemoResident = p.code === "FRT" && b.code === "B" && u.number === "1204";
          const count = isDemoResident ? 1 : pick([1, 1, 2, 2, 3]);
          for (let i = 0; i < count; i++) {
            const first = isDemoResident ? "Emma" : pick(FIRST);
            const last = isDemoResident ? "Tremblay" : pick(LAST);
            const [res] = await tx.insert(s.residents).values({
              orgId: pac.id, userId: isDemoResident ? U(DEMO_USERS.resident.email).id : null, firstName: first, lastName: last,
              email: isDemoResident ? DEMO_USERS.resident.email : `${first}.${last}.${residentCount}@example.com`.toLowerCase(),
              phone: `604-555-${String(1000 + (residentCount % 9000)).padStart(4, "0")}`,
            }).returning();
            residentCount++;
            const relationship = p.type === "rental" ? (i === 0 ? "tenant" : "occupant") : i === 0 ? pick(["owner", "resident", "tenant"]) : "occupant";
            await tx.insert(s.unitOccupancies).values({
              orgId: pac.id, unitId: u.id, residentId: res.id, relationship: isDemoResident ? "resident" : relationship, isPrimary: i === 0,
              startsOn: `20${pick(["19", "20", "21", "22", "23", "24", "25"])}-0${1 + Math.floor(rand() * 9)}-01`,
            });
            if (isDemoResident) residentUnitId = u.id;
          }
        }
      }
    }
    if (!residentUnitId) throw new Error("demo resident unit not created");

    // memberships with realistic scopes
    const member = async (email: string, roleKey: string, title: string, scope?: { propertyId?: string; buildingId?: string; portfolioId?: string }[]) => {
      const [m] = await tx.insert(s.memberships).values({ orgId: pac.id, userId: U(email).id, roleId: R(roleKey).id, title }).returning();
      for (const sc of scope ?? []) await tx.insert(s.membershipScopes).values({ orgId: pac.id, membershipId: m.id, ...sc });
      await tx.insert(s.auditLogs).values({ orgId: pac.id, actorUserId: U(DEMO_USERS.admin.email).id, action: "member.added", entityType: "membership", entityId: m.id, after: { email, role: roleKey } });
      return m;
    };
    await member(DEMO_USERS.admin.email, "org_admin", "Director of Operations");
    await member(DEMO_USERS.pm.email, "property_manager", "Property Manager", [{ propertyId: propIds.HBC }, { propertyId: propIds.FRT }]);
    await member(DEMO_USERS.concierge.email, "concierge", "Front Desk Concierge", [{ propertyId: propIds.FRT }]);
    await member(DEMO_USERS.facility.email, "facility_manager", "Facility Manager", [{ portfolioId: pfMix.id }]);
    await member(DEMO_USERS.staff.email, "maintenance_staff", "Building Technician", [{ buildingId: buildingIds["HBC-MAIN"] }]);
    await member(DEMO_USERS.resident.email, "resident", "Resident, Tower B #1204");
    await member(DEMO_USERS.vendor.email, "vendor", "Blake Plumbing & Heating");
    await member(DEMO_USERS.council.email, "council_member", "Council President", [{ propertyId: propIds.PCH }]);
    await tx.insert(s.auditLogs).values({ orgId: pac.id, actorUserId: U(DEMO_USERS.admin.email).id, action: "org.created", entityType: "organization", entityId: pac.id, after: { name: pac.name, source: "seed" } });

    /* ── Northshore Strata (second tenant, used for isolation demos/tests) ── */
    const [ns] = await tx.insert(s.organizations).values({ name: "Northshore Strata Corporation", slug: "northshore-strata", kind: "strata" }).returning();
    const [nsProp] = await tx.insert(s.properties).values({ orgId: ns.id, name: "Lonsdale Quay Lofts", code: "LQL", type: "strata", addressLine1: "123 Carrie Cates Ct", city: "North Vancouver", region: "BC", postalCode: "V7M 3K7" }).returning();
    const [nsBld] = await tx.insert(s.buildings).values({ orgId: ns.id, propertyId: nsProp.id, name: "Lofts", code: "L", yearBuilt: 2009 }).returning();
    for (let f = 1; f <= 5; f++) {
      const [fl] = await tx.insert(s.floors).values({ orgId: ns.id, buildingId: nsBld.id, level: f, name: `Level ${f}` }).returning();
      await tx.insert(s.units).values(Array.from({ length: 6 }, (_, i) => ({ orgId: ns.id, propertyId: nsProp.id, buildingId: nsBld.id, floorId: fl.id, number: `${f}0${i + 1}`, bedrooms: 1 + (i % 2), areaSqft: 700 + i * 40 })));
    }
    await tx.insert(s.memberships).values({ orgId: ns.id, userId: U(DEMO_USERS.northshoreAdmin.email).id, roleId: R("org_admin").id, title: "Strata Council Treasurer" });
    // the platform demo admin also sits on the Northshore council, to demo org switching
    const [adminNs] = await tx.insert(s.memberships).values({ orgId: ns.id, userId: U(DEMO_USERS.admin.email).id, roleId: R("council_member").id, title: "Council Member" }).returning();
    await tx.insert(s.membershipScopes).values({ orgId: ns.id, membershipId: adminNs.id, propertyId: nsProp.id });

    console.log(`✓ seeded 2 orgs, ${Object.keys(propIds).length + 1} properties, ${unitCount + 30} units, ${residentCount} residents, ${userRows.length} demo users`);
  });
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
