import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as s from "../src/server/db/schema";
import { zonedToUtc } from "../src/lib/time";
import { addDays, addInterval } from "../src/server/modules/assets/schedule";

type Tx = Parameters<Parameters<NodePgDatabase<typeof s>["transaction"]>[0]>[0];

function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const H = 3_600_000;
const D = 24 * H;
const TZ = "America/Vancouver";
const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const at = (date: string, hhmm: string) => zonedToUtc(`${date}T${hhmm}`, TZ);
const passHash = () => createHash("sha256").update(randomBytes(24).toString("base64url")).digest("hex");

// staff without logins, so schedules rotate realistically (removed and recreated with the demo data)
export const EXTRA_STAFF_DOMAIN = "staff.example.test";
const EXTRA_STAFF = [
  { name: "Ben Ortiz", key: "ben", role: "concierge", title: "Front Desk Concierge", prop: "FRT" },
  { name: "Grace Liu", key: "grace", role: "concierge", title: "Front Desk Concierge (nights)", prop: "FRT" },
  { name: "Samir Haddad", key: "samir", role: "security", title: "Security Officer", prop: "FRT" },
  { name: "Tomás Reyes", key: "tomas", role: "maintenance_staff", title: "Building Technician", prop: "FRT" },
  { name: "Hannah Brooks", key: "hannah", role: "concierge", title: "Concierge", prop: "HBC" },
  { name: "Ivan Petrov", key: "ivan", role: "maintenance_staff", title: "Building Technician", prop: "PCH" },
] as const;

// visitors, parking, shifts and handoffs, assets with preventive maintenance and downtime
export async function seedFacility(tx: Tx, orgId: string, now = new Date()) {
  const rand = rng(505050);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);
  const today = localDate(now);

  const props = await tx.select().from(s.properties).where(eq(s.properties.orgId, orgId));
  const P = (code: string) => props.find((p) => p.code === code)!;
  const blds = await tx.select().from(s.buildings).where(eq(s.buildings.orgId, orgId));
  const B = (prop: string, code: string) => blds.find((b) => b.propertyId === P(prop).id && b.code === code)!;
  const vendorRows = await tx.select().from(s.vendors).where(eq(s.vendors.orgId, orgId));
  const V = (prefix: string) => vendorRows.find((v) => v.name.startsWith(prefix))!;
  const sysRoles = await tx.select().from(s.roles).where(isNull(s.roles.orgId));
  const R = (key: string) => sysRoles.find((r) => r.key === key)!;
  const memberRows = async () => tx.select({ id: s.memberships.id, email: s.users.email, userId: s.users.id, name: s.users.name }).from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId)).where(eq(s.memberships.orgId, orgId));

  /* ── extra staff ── */
  await tx.delete(s.users).where(like(s.users.email, `%@${EXTRA_STAFF_DOMAIN}`));
  for (const x of EXTRA_STAFF) {
    const [u] = await tx.insert(s.users).values({ email: `${x.key}@${EXTRA_STAFF_DOMAIN}`, name: x.name }).returning();
    const [m] = await tx.insert(s.memberships).values({ orgId, userId: u.id, roleId: R(x.role).id, title: x.title }).returning();
    await tx.insert(s.membershipScopes).values({ orgId, membershipId: m.id, propertyId: P(x.prop).id });
    await tx.insert(s.staffProfiles).values({ orgId, membershipId: m.id, phone: `604-555-02${String(EXTRA_STAFF.indexOf(x)).padStart(2, "0")}`, skills: x.role === "maintenance_staff" ? ["plumbing", "hvac basics"] : ["customer service"], employmentType: "full_time" });
  }
  const mem = await memberRows();
  const M = (email: string) => mem.find((m) => m.email === email)!;
  const X = (key: string) => M(`${key}@${EXTRA_STAFF_DOMAIN}`);
  const pm = M("pm@demo.test"), concierge = M("concierge@demo.test"), facility = M("facility@demo.test"), tech = M("staff@demo.test");
  const emma = M("resident@demo.test"), noah = M("owner@demo.test");

  const occupied = await tx.select({ unitId: s.units.id, number: s.units.number, buildingId: s.units.buildingId, propertyId: s.units.propertyId, residentId: s.residents.id, first: s.residents.firstName, last: s.residents.lastName, userId: s.residents.userId, primary: s.unitOccupancies.isPrimary })
    .from(s.unitOccupancies).innerJoin(s.units, eq(s.units.id, s.unitOccupancies.unitId)).innerJoin(s.residents, eq(s.residents.id, s.unitOccupancies.residentId))
    .where(and(eq(s.unitOccupancies.orgId, orgId), isNull(s.unitOccupancies.endsOn)));
  const primaries = occupied.filter((o) => o.primary);
  const emmaHome = occupied.find((o) => o.userId === emma.userId)!;
  const noahHome = occupied.find((o) => o.userId === noah.userId)!;
  const homesAt = (code: string) => primaries.filter((o) => o.propertyId === P(code).id);

  /* ── shifts ── */
  const shiftRows: (typeof s.shifts.$inferInsert)[] = [];
  const addShift = (m: { id: string }, prop: string, start: Date, end: Date, position: string, onCall = false, buildingId: string | null = null) =>
    shiftRows.push({ orgId, propertyId: P(prop).id, buildingId, membershipId: m.id, position, startsAt: start, endsAt: end, onCall, createdByUserId: pm.userId,
      clockedInAt: start < now ? new Date(start.getTime() + between(-10, 5) * 60_000) : null, clockedOutAt: end < now ? new Date(end.getTime() + between(0, 12) * 60_000) : null });
  // Fraser Towers front desk: three fixed 8-hour blocks a day; the demo concierge always holds the block happening now
  const blocks = ["07:00", "15:00", "23:00"];
  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now);
  const h = Number(nowLocal);
  const currentBlock = h >= 7 && h < 15 ? 0 : h >= 15 && h < 23 ? 1 : 2;
  const deskCrew = [concierge, X("ben"), X("grace")];
  const crewFor = (block: number) => deskCrew[(block - currentBlock + 3) % 3];
  for (let d = -7; d <= 14; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    blocks.forEach((b, i) => {
      const start = at(date, b);
      addShift(crewFor(i), "FRT", start, new Date(start.getTime() + 8 * H), "front_desk");
    });
    // the night block that started yesterday also covers the early hours of today
    if (dow !== 1 && dow !== 2) addShift(X("samir"), "FRT", at(date, "19:00"), at(addDays(date, 1), "03:00"), "security");
    if (dow >= 1 && dow <= 5) {
      addShift(X("tomas"), "FRT", at(date, "08:00"), at(date, "16:00"), "maintenance");
      addShift(X("hannah"), "HBC", at(date, "08:00"), at(date, "16:00"), "front_desk");
      addShift(tech, "HBC", at(date, "07:30"), at(date, "15:30"), "maintenance");
      addShift(X("ivan"), "PCH", at(date, "09:00"), at(date, "17:00"), "maintenance");
    }
    // after-hours on call: emergencies with nobody assigned are routed to whoever holds this
    addShift(X("tomas"), "FRT", at(date, dow >= 1 && dow <= 5 ? "16:00" : "08:00"), at(addDays(date, 1), "08:00"), "maintenance", true);
    if (dow === 0 || dow === 6) addShift(tech, "HBC", at(date, "08:00"), at(addDays(date, 1), "07:30"), "maintenance", true);
  }
  await tx.insert(s.shifts).values(shiftRows);

  // recent handoffs at the Fraser Towers desk (the last one waits for the current shift to acknowledge it)
  const handoffs = [
    { by: X("grace"), ago: 32, ack: concierge, notes: "Quiet night. Lobby door closer on Tower B is sticking again; put a work order in. 2 perishable packages for 1507 still on the shelf.", snap: { packages: { waiting: 11, perishable: 2, overdue: 1 }, visitors: { onSite: [], expectedNext4h: 1 }, messagesNeedingReply: 2, parkingToReview: 1 } },
    { by: X("ben"), ago: 16, ack: X("grace"), notes: "Elevator tech from Summit came and left; car 2 still intermittent. Party room booked tonight for 1102, deposit collected. Resident in 905 asked about storage lockers — passed to management.", snap: { packages: { waiting: 9, perishable: 0, overdue: 1 }, visitors: { onSite: [{ name: "Arjun Patel", unit: null, overstay: false }], expectedNext4h: 3 }, messagesNeedingReply: 1, bookingsRestOfToday: 1 } },
    { by: crewFor((currentBlock + 2) % 3), ago: 0.4, ack: null, notes: "Tower B car 2 is down again (stuck on 9 with doors open) — Summit is assigned, residents above 10 using the stairs. Contractor from Summit expected today, already on the visitor list. Guest for 1204 arriving this evening needs visitor parking.", snap: { packages: { waiting: 14, perishable: 1, overdue: 1 }, visitors: { onSite: [{ name: "Daniel Kim", unit: "702", overstay: true }], expectedNext4h: 2 }, emergencies: [{ number: 0, title: "Tower B elevator out of service", status: "assigned" }], messagesNeedingReply: 3, parkingToReview: 2 } },
  ];
  for (const x of handoffs) {
    await tx.insert(s.shiftHandoffs).values({
      orgId, propertyId: P("FRT").id, authorUserId: x.by.userId, notes: x.notes, snapshot: { at: new Date(now.getTime() - x.ago * H).toISOString(), ...x.snap },
      createdAt: new Date(now.getTime() - x.ago * H), acknowledgedByUserId: x.ack?.userId ?? null, acknowledgedAt: x.ack ? new Date(now.getTime() - (x.ago - 0.5) * H) : null,
    });
  }

  /* ── parking spaces ── */
  const spaces: (typeof s.parkingSpaces.$inferSelect)[] = [];
  const addSpaces = async (prop: string, prefix: string, from: number, to: number, kind: string, level: string | null, pad = 3) => {
    const rows = await tx.insert(s.parkingSpaces).values(Array.from({ length: to - from + 1 }, (_, i) => ({
      orgId, propertyId: P(prop).id, code: `${prefix}${String(from + i).padStart(pad, "0")}`, kind, level,
    }))).returning();
    spaces.push(...rows);
  };
  await addSpaces("FRT", "P1-", 1, 60, "resident", "P1");
  await addSpaces("FRT", "P2-", 1, 40, "resident", "P2");
  await addSpaces("FRT", "V-", 1, 8, "visitor", "P1", 2);
  await addSpaces("FRT", "A-", 1, 2, "accessible", "P1", 2);
  await addSpaces("FRT", "EV-", 1, 4, "ev", "P2", 2);
  await addSpaces("FRT", "L-", 1, 1, "loading", "Ground", 2);
  await addSpaces("HBC", "P1-", 1, 30, "resident", "P1");
  await addSpaces("HBC", "V-", 1, 4, "visitor", "P1", 2);
  await addSpaces("PCH", "S-", 1, 40, "resident", "Surface");
  await addSpaces("PCH", "V-", 1, 6, "visitor", "Surface", 2);
  await addSpaces("KWR", "P-", 1, 25, "resident", "P1");
  await addSpaces("KWR", "V-", 1, 3, "visitor", "P1", 2);
  const SP = (prop: string, code: string) => spaces.find((x) => x.propertyId === P(prop).id && x.code === code)!;
  await tx.update(s.parkingSpaces).set({ status: "out_of_service", notes: "Ceiling leak above — coned off" }).where(eq(s.parkingSpaces.id, SP("FRT", "P2-031").id));

  // assign resident spaces to homes (the demo resident and owner get known spaces)
  const assigned = new Map<string, string>(); // spaceId → unitId
  const fixed: [string, string, string][] = [["FRT", "P2-014", emmaHome.unitId], ["FRT", "P1-008", noahHome.unitId]];
  for (const [prop, code, unitId] of fixed) assigned.set(SP(prop, code).id, unitId);
  for (const code of ["FRT", "HBC", "PCH", "KWR"]) {
    const free = spaces.filter((x) => x.propertyId === P(code).id && x.kind === "resident" && x.status === "available" && !assigned.has(x.id));
    const homes = homesAt(code).filter((o) => o.unitId !== emmaHome.unitId && o.unitId !== noahHome.unitId);
    for (const sp of free) { if (rand() < 0.85 && homes.length) assigned.set(sp.id, homes.splice(Math.floor(rand() * homes.length), 1)[0].unitId); }
  }
  for (const [spaceId, unitId] of assigned) await tx.update(s.parkingSpaces).set({ assignedUnitId: unitId }).where(eq(s.parkingSpaces.id, spaceId));

  /* ── vehicles & permits ── */
  const L = "ABCDEFGHJKLMNPRSTVWXYZ";
  const usedPlates = new Set<string>(["KX742M", "WLM805"]);
  const plate = () => {
    for (;;) {
      const p = rand() < 0.5 ? `${pick([...L])}${pick([...L])}${Math.floor(rand() * 10)}${Math.floor(rand() * 10)}${Math.floor(rand() * 10)}${pick([...L])}` : `${pick([...L])}${pick([...L])}${pick([...L])}${Math.floor(100 + rand() * 900)}`;
      if (!usedPlates.has(p)) { usedPlates.add(p); return p; }
    }
  };
  const MAKES = [["Toyota", "RAV4"], ["Honda", "Civic"], ["Tesla", "Model 3"], ["Subaru", "Outback"], ["Mazda", "CX-5"], ["Hyundai", "Ioniq 5"], ["Ford", "F-150"], ["Volkswagen", "Golf"], ["Kia", "Niro"], ["BMW", "X3"]];
  const COLOURS = ["White", "Black", "Grey", "Silver", "Blue", "Red"];
  let permitNo = 0;
  const vehicleRows: { id: string; plate: string; unitId: string; propertyId: string }[] = [];
  const spaceOfUnit = new Map<string, string>([...assigned].map(([sid, uid]) => [uid, sid]));
  const permitRows: (typeof s.parkingPermits.$inferInsert)[] = [];
  const homesWithCars = primaries.filter((o) => spaceOfUnit.has(o.unitId) && (o.unitId === emmaHome.unitId || o.unitId === noahHome.unitId || rand() < 0.65));
  for (const o of homesWithCars) {
    const count = o.unitId === noahHome.unitId ? 1 : o.unitId === emmaHome.unitId ? 1 : rand() < 0.15 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const p = o.unitId === emmaHome.unitId ? "KX742M" : o.unitId === noahHome.unitId ? "WLM805" : plate();
      const [mk, md] = o.unitId === emmaHome.unitId ? ["Honda", "Civic"] : o.unitId === noahHome.unitId ? ["Volvo", "XC60"] : pick(MAKES);
      const [v] = await tx.insert(s.vehicles).values({ orgId, propertyId: o.propertyId, unitId: o.unitId, residentId: o.residentId, plate: p, region: "BC", make: mk, model: md, color: pick(COLOURS), createdByUserId: o.userId ?? pm.userId, createdAt: new Date(now.getTime() - between(20, 400) * D) }).returning();
      vehicleRows.push({ id: v.id, plate: p, unitId: o.unitId, propertyId: o.propertyId });
      permitRows.push({ orgId, number: ++permitNo, propertyId: o.propertyId, kind: "resident", plate: p, vehicleId: v.id, unitId: o.unitId, spaceId: i === 0 ? spaceOfUnit.get(o.unitId)! : null,
        validFrom: at(addDays(today, -Math.floor(between(30, 400))), "00:00"), validUntil: null, issuedByUserId: pm.userId });
    }
  }
  const vehicleOf = (unitId: string) => vehicleRows.find((v) => v.unitId === unitId)!;

  /* ── visitors ── */
  const GUESTS = ["Sophie Tremblay", "Lucas Martin", "Chloé Roy", "Daniel Kim", "Priya Nair", "Marco Rossi", "Aiko Tanaka", "Jordan Lee", "Fatima Hassan", "Owen Clarke", "Leah Gagnon", "Ravi Dhillon", "Mia Wong", "Theo Silva", "Nadia Ahmed", "Ethan Park"];
  const visitorRows: (typeof s.visitors.$inferInsert & { id: string })[] = [];
  const visitorSpaces = spaces.filter((x) => x.kind === "visitor");
  const busy = new Map<string, [number, number][]>();
  const freeVisitorSpace = (propertyId: string, from: Date, to: Date) => visitorSpaces.find((x) => x.propertyId === propertyId && !(busy.get(x.id) ?? []).some(([a, b]) => a < to.getTime() && from.getTime() < b));
  const addVisitor = (o: typeof primaries[number] | null, v: Partial<typeof s.visitors.$inferInsert> & { name: string; expectedFrom: Date; expectedUntil: Date }) => {
    const id = crypto.randomUUID();
    const home = o ?? null;
    const row = {
      id, orgId, propertyId: v.propertyId ?? home!.propertyId, buildingId: v.buildingId ?? home!.buildingId, unitId: home?.unitId ?? null, hostResidentId: home?.residentId ?? null,
      invitedByUserId: home?.userId ?? null, createdByUserId: home?.userId ?? concierge.userId, kind: "guest", status: "expected", ...v,
    };
    visitorRows.push(row);
    return row;
  };
  // the last 30 days: arrivals and departures, with visitor parking where a space was free
  for (let i = 0; i < 70; i++) {
    const o = pick(primaries.filter((x) => x.propertyId !== P("KWR").id));
    const day = addDays(today, -1 - Math.floor(rand() * 30));
    const from = at(day, pick(["10:00", "12:30", "15:00", "17:30", "18:00", "19:00"]));
    const until = new Date(from.getTime() + between(1.5, 5) * H);
    const contractor = rand() < 0.12;
    const p = rand() < 0.4 ? plate() : null;
    const row = addVisitor(o, {
      name: contractor ? pick(["Arjun Patel", "Mei Wong", "Liam Fraser"]) : pick(GUESTS), company: contractor ? pick(["Summit Elevator Services", "Coastline Electric", "Firewise Safety Systems"]) : null,
      kind: contractor ? "contractor" : rand() < 0.1 ? "delivery" : "guest", expectedFrom: from, expectedUntil: until, plate: p, needsParking: !!p,
      status: rand() < 0.08 ? "cancelled" : "checked_out", invitedByUserId: rand() < 0.7 ? o.userId : null,
    });
    if (row.status === "checked_out") {
      row.checkedInAt = new Date(from.getTime() + between(-20, 30) * 60_000); row.checkedInByUserId = pick(deskCrew).userId;
      row.checkedOutAt = new Date(until.getTime() + between(-60, 30) * 60_000); row.checkedOutByUserId = pick(deskCrew).userId;
      const sp = p ? freeVisitorSpace(row.propertyId!, row.checkedInAt, row.checkedOutAt) : null;
      if (sp) {
        busy.set(sp.id, [...(busy.get(sp.id) ?? []), [row.checkedInAt.getTime(), row.checkedOutAt.getTime()]]);
        permitRows.push({ orgId, number: ++permitNo, propertyId: row.propertyId!, kind: "visitor", plate: p!, unitId: row.unitId, spaceId: sp.id, visitorId: row.id, validFrom: row.checkedInAt, validUntil: row.checkedOutAt, issuedByUserId: row.checkedInByUserId });
      }
    } else row.cancelledAt = new Date(from.getTime() - between(2, 30) * H);
  }
  const towerB = B("FRT", "B");
  const [elevatorWo] = await tx.select().from(s.workOrders).where(and(eq(s.workOrders.orgId, orgId), eq(s.workOrders.title, "Tower B elevator out of service")));
  // today at Fraser Towers
  const frtHomes = homesAt("FRT");
  addVisitor(null, { propertyId: P("FRT").id, buildingId: towerB.id, name: "Arjun Patel", company: "Summit Elevator Services", kind: "contractor", purpose: "Car 2 controller replacement", workOrderId: elevatorWo?.id ?? null,
    expectedFrom: at(today, "09:00"), expectedUntil: at(today, "17:00"), passTokenHash: passHash(), createdByUserId: concierge.userId });
  addVisitor(emmaHome, { name: "Sophie Tremblay", expectedFrom: at(today, "18:00"), expectedUntil: at(today, "23:00"), plate: "SLT204", needsParking: true, purpose: "My sister, staying for dinner", passTokenHash: passHash() });
  addVisitor(pick(frtHomes), { name: "Marco Rossi", expectedFrom: new Date(now.getTime() + 1.5 * H), expectedUntil: new Date(now.getTime() + 4.5 * H), passTokenHash: passHash() });
  addVisitor(pick(frtHomes), { name: "Aiko Tanaka", kind: "service", company: "Bright Home Cleaning", expectedFrom: new Date(now.getTime() + 0.5 * H), expectedUntil: new Date(now.getTime() + 3.5 * H), passTokenHash: passHash() });
  addVisitor(pick(frtHomes), { name: "Ravi Dhillon", expectedFrom: new Date(now.getTime() + 3 * H), expectedUntil: new Date(now.getTime() + 6 * H), plate: plate(), needsParking: true, passTokenHash: passHash() });
  // on site now (one is past their window)
  const onSite = [
    addVisitor(pick(frtHomes.filter((o) => o.buildingId === B("FRT", "A").id)), { name: "Daniel Kim", expectedFrom: new Date(now.getTime() - 5 * H), expectedUntil: new Date(now.getTime() - 1 * H), status: "checked_in" }),
    addVisitor(pick(frtHomes), { name: "Leah Gagnon", expectedFrom: new Date(now.getTime() - 1.5 * H), expectedUntil: new Date(now.getTime() + 2 * H), status: "checked_in", plate: "LGN442", needsParking: true }),
    addVisitor(null, { propertyId: P("FRT").id, buildingId: B("FRT", "A").id, name: "Liam Fraser", company: "Firewise Safety Systems", kind: "contractor", purpose: "Quarterly fire panel check", expectedFrom: new Date(now.getTime() - 2 * H), expectedUntil: new Date(now.getTime() + 3 * H), status: "checked_in", createdByUserId: facility.userId }),
  ];
  for (const v of onSite) { v.checkedInAt = new Date(v.expectedFrom.getTime() + 10 * 60_000); v.checkedInByUserId = concierge.userId; v.passTokenHash = null; }
  const leah = onSite[1];
  const leahSpace = freeVisitorSpace(leah.propertyId!, leah.checkedInAt!, leah.expectedUntil);
  if (leahSpace) {
    busy.set(leahSpace.id, [...(busy.get(leahSpace.id) ?? []), [leah.checkedInAt!.getTime(), leah.expectedUntil.getTime()]]);
    permitRows.push({ orgId, number: ++permitNo, propertyId: leah.propertyId!, kind: "visitor", plate: "LGN442", unitId: leah.unitId, spaceId: leahSpace.id, visitorId: leah.id, validFrom: leah.checkedInAt!, validUntil: leah.expectedUntil, issuedByUserId: concierge.userId });
  }
  // upcoming
  addVisitor(emmaHome, { name: "Lucas Martin", expectedFrom: at(addDays(today, 2), "18:30"), expectedUntil: at(addDays(today, 2), "22:30"), passTokenHash: passHash() });
  addVisitor(emmaHome, { name: "Chloé Roy", expectedFrom: at(addDays(today, 5), "14:00"), expectedUntil: at(addDays(today, 8), "12:00"), plate: "CRY118", needsParking: true, purpose: "Visiting for the long weekend", passTokenHash: passHash() });
  addVisitor(noahHome, { name: "Grace Williams", expectedFrom: at(addDays(today, 3), "11:00"), expectedUntil: at(addDays(today, 3), "16:00"), passTokenHash: passHash() });
  for (let i = 0; i < 6; i++) {
    const o = pick(primaries.filter((x) => x.propertyId !== P("KWR").id));
    const day = addDays(today, 1 + Math.floor(rand() * 10));
    const from = at(day, pick(["11:00", "14:00", "17:00", "19:00"]));
    addVisitor(o, { name: pick(GUESTS), expectedFrom: from, expectedUntil: new Date(from.getTime() + 4 * H), passTokenHash: passHash() });
  }
  await tx.insert(s.visitors).values(visitorRows);
  await tx.insert(s.parkingPermits).values(permitRows);

  /* ── parking violations (reports → human review → notices) ── */
  let violationNo = 0;
  const unregistered = () => plate();
  const noahCar = vehicleOf(noahHome.unitId);
  const someCar = pick(vehicleRows.filter((v) => v.propertyId === P("FRT").id && v.unitId !== emmaHome.unitId && v.unitId !== noahHome.unitId));
  const violations: Omit<typeof s.parkingViolations.$inferInsert, "orgId" | "number" | "propertyId">[] = [
    { plate: unregistered(), kind: "no_permit", source: "detection", confidence: "0.820", status: "reported", location: "P1 ramp camera", spaceId: SP("FRT", "P1-044").id, observedAt: new Date(now.getTime() - 2.5 * H) },
    { plate: unregistered(), kind: "blocking", source: "staff", status: "reported", location: "Loading bay by Tower B", spaceId: SP("FRT", "L-01").id, reportedByUserId: X("samir").userId, description: "Silver hatchback left in the loading bay overnight, blocking the moving-truck lane.", observedAt: new Date(now.getTime() - 7 * H) },
    { plate: someCar.plate, kind: "wrong_space", source: "staff", status: "confirmed", spaceId: SP("FRT", "P1-031").id, reportedByUserId: concierge.userId, reviewedByUserId: pm.userId, reviewNote: "Checked the permit list: assigned elsewhere.", observedAt: new Date(now.getTime() - 26 * H), vehicleId: someCar.id, unitId: someCar.unitId, hadValidPermit: true },
    { plate: noahCar.plate, kind: "visitor_overstay", source: "staff", status: "warned", spaceId: SP("FRT", "V-03").id, reportedByUserId: X("grace").userId, reviewedByUserId: concierge.userId, observedAt: new Date(now.getTime() - 4 * D), vehicleId: noahCar.id, unitId: noahCar.unitId, hadValidPermit: false,
      warnedAt: new Date(now.getTime() - 3.8 * D), warningText: "Your vehicle WLM 805 was parked in visitor space V-03 overnight on the weekend. Visitor spaces are for guests only — please use your assigned space P1-008. Contact the front desk if you think this is a mistake." },
    { plate: unregistered(), kind: "fire_lane", source: "staff", status: "resolved", location: "Fire lane, east entrance", reportedByUserId: X("samir").userId, reviewedByUserId: pm.userId, resolution: "Owner located through the visitor log and moved the vehicle within 10 minutes.", observedAt: new Date(now.getTime() - 9 * D) },
    { plate: unregistered(), kind: "no_permit", source: "detection", confidence: "0.640", status: "dismissed", location: "P2 camera", reviewedByUserId: concierge.userId, reviewNote: "Plate misread from the footage — the vehicle has a valid resident permit.", observedAt: new Date(now.getTime() - 6 * D) },
    { plate: unregistered(), kind: "accessible", source: "staff", status: "resolved", spaceId: SP("FRT", "A-01").id, reportedByUserId: concierge.userId, reviewedByUserId: pm.userId, resolution: "Delivery driver; moved when asked.", observedAt: new Date(now.getTime() - 15 * D) },
    { plate: unregistered(), kind: "no_permit", source: "staff", status: "dismissed", location: "Visitor area", reportedByUserId: X("ben").userId, reviewedByUserId: pm.userId, reviewNote: "Guest was checked in; permit issued late.", observedAt: new Date(now.getTime() - 21 * D) },
  ];
  for (const v of violations) {
    const warned = v.status === "warned" || (v.status === "resolved" && v.warnedAt);
    await tx.insert(s.parkingViolations).values({
      orgId, number: ++violationNo, propertyId: P("FRT").id, ...v, hadValidPermit: v.hadValidPermit ?? false,
      reviewedAt: v.reviewedByUserId ? new Date(v.observedAt.getTime() + 2 * H) : null, resolvedAt: ["resolved", "dismissed"].includes(v.status!) ? new Date(v.observedAt.getTime() + 3 * H) : null,
      warnedAt: warned ? v.warnedAt : null, createdAt: v.observedAt,
    });
  }

  /* ── assets ── */
  const assetRows: (typeof s.assets.$inferSelect)[] = [];
  const addAsset = async (prop: string, bld: string | null, a: Partial<typeof s.assets.$inferInsert> & { name: string; category: string }) => {
    const [row] = await tx.insert(s.assets).values({ orgId, propertyId: P(prop).id, buildingId: bld ? B(prop, bld).id : null, ...a }).returning();
    assetRows.push(row);
    return row;
  };
  const A = (name: string) => assetRows.find((a) => a.name === name)!;
  // Fraser Towers
  await addAsset("FRT", "A", { name: "Tower A elevator car 1", tag: "FRT-ELV-A1", category: "elevator", make: "KONE", model: "MonoSpace 500", location: "Tower A elevator bank", criticality: "high", installedOn: "2016-05-01", expectedLifeYears: 25, vendorId: V("Summit").id, replacementCost: "185000.00" });
  await addAsset("FRT", "A", { name: "Tower A elevator car 2", tag: "FRT-ELV-A2", category: "elevator", make: "KONE", model: "MonoSpace 500", location: "Tower A elevator bank", criticality: "high", installedOn: "2016-05-01", expectedLifeYears: 25, vendorId: V("Summit").id, replacementCost: "185000.00" });
  await addAsset("FRT", "B", { name: "Tower B elevator car 1", tag: "FRT-ELV-B1", category: "elevator", make: "Otis", model: "Gen2", location: "Tower B elevator bank", criticality: "high", installedOn: "2018-03-15", expectedLifeYears: 25, vendorId: V("Summit").id, replacementCost: "190000.00" });
  await addAsset("FRT", "B", { name: "Tower B elevator car 2", tag: "FRT-ELV-B2", category: "elevator", make: "Otis", model: "Gen2", location: "Tower B elevator bank", criticality: "high", installedOn: "2018-03-15", expectedLifeYears: 25, vendorId: V("Summit").id, replacementCost: "190000.00", notes: "Controller replacement quoted in September." });
  await addAsset("FRT", "A", { name: "Boiler B-1", tag: "FRT-BLR-1", category: "hvac", make: "Viessmann", model: "Vitocrossal 200", location: "Tower A mechanical room, P1", criticality: "critical", installedOn: "2016-02-10", warrantyUntil: "2026-02-10", expectedLifeYears: 20, vendorId: V("Blake").id, replacementCost: "68000.00" });
  await addAsset("FRT", "A", { name: "Boiler B-2", tag: "FRT-BLR-2", category: "hvac", make: "Viessmann", model: "Vitocrossal 200", location: "Tower A mechanical room, P1", criticality: "critical", installedOn: "2016-02-10", expectedLifeYears: 20, vendorId: V("Blake").id, replacementCost: "68000.00" });
  await addAsset("FRT", null, { name: "Make-up air unit MAU-1", tag: "FRT-MAU-1", category: "hvac", make: "Engineered Air", location: "Tower A roof", criticality: "medium", installedOn: "2016-04-01", vendorId: V("Blake").id });
  await addAsset("FRT", "A", { name: "Fire alarm panel — Tower A", tag: "FRT-FAP-A", category: "fire_safety", make: "Edwards", model: "EST3", location: "Tower A lobby", criticality: "critical", installedOn: "2016-04-20", vendorId: V("Firewise").id });
  await addAsset("FRT", "B", { name: "Fire alarm panel — Tower B", tag: "FRT-FAP-B", category: "fire_safety", make: "Edwards", model: "EST3", location: "Tower B lobby", criticality: "critical", installedOn: "2018-02-20", vendorId: V("Firewise").id });
  await addAsset("FRT", null, { name: "Emergency generator", tag: "FRT-GEN-1", category: "generator", make: "Cummins", model: "C250D6", location: "P2 generator room", criticality: "critical", installedOn: "2016-03-01", vendorId: V("Coastline").id, replacementCost: "120000.00" });
  await addAsset("FRT", "B", { name: "Domestic hot water tank DHW-1", tag: "FRT-DHW-1", category: "plumbing", make: "A.O. Smith", location: "Tower B mechanical room", criticality: "high", installedOn: "2018-01-15", warrantyUntil: "2027-01-15", vendorId: V("Blake").id });
  await addAsset("FRT", null, { name: "Parkade gate operator", tag: "FRT-GATE-1", category: "doors_access", make: "LiftMaster", model: "MegaArm", location: "Parkade entrance", criticality: "medium", installedOn: "2019-06-01", status: "needs_attention", notes: "Arm sensor intermittent; replacement on order." });
  // Harbour Centre
  for (const n of [1, 2, 3, 4]) await addAsset("HBC", "MAIN", { name: `Rooftop unit RTU-${n}`, tag: `HBC-RTU-0${n}`, category: "hvac", make: "Carrier", model: "WeatherMaker 48FC", location: "Main Tower roof", criticality: n === 4 ? "high" : "medium", installedOn: n === 4 ? "2011-07-01" : "2014-07-01", expectedLifeYears: 15, vendorId: V("Blake").id, replacementCost: "42000.00" });
  await addAsset("HBC", "MAIN", { name: "Passenger elevator 1", tag: "HBC-ELV-1", category: "elevator", make: "Schindler", model: "3300", location: "Main lobby", criticality: "high", installedOn: "2004-09-01", vendorId: V("Summit").id });
  await addAsset("HBC", "MAIN", { name: "Passenger elevator 2", tag: "HBC-ELV-2", category: "elevator", make: "Schindler", model: "3300", location: "Main lobby", criticality: "high", installedOn: "2004-09-01", vendorId: V("Summit").id });
  await addAsset("HBC", "MAIN", { name: "Sprinkler system", tag: "HBC-SPR-1", category: "fire_safety", location: "Building-wide", criticality: "critical", vendorId: V("Firewise").id });
  await addAsset("HBC", "MAIN", { name: "Domestic booster pump", tag: "HBC-PMP-1", category: "plumbing", make: "Grundfos", location: "P1 pump room", criticality: "high", installedOn: "2004-09-01" });
  // Pacific Heights and Kingsway
  await addAsset("PCH", null, { name: "Pool circulation pump", tag: "PCH-POOL-1", category: "pool", make: "Pentair", location: "Clubhouse pool room", criticality: "medium", installedOn: "2019-05-01" });
  await addAsset("PCH", null, { name: "Pool heater", tag: "PCH-POOL-2", category: "pool", make: "Raypak", location: "Clubhouse pool room", criticality: "low", installedOn: "2019-05-01" });
  await addAsset("PCH", "N", { name: "North Building elevator", tag: "PCH-ELV-N", category: "elevator", make: "Otis", location: "North lobby", criticality: "high", installedOn: "2011-06-01" });
  await addAsset("PCH", "S", { name: "South Building elevator", tag: "PCH-ELV-S", category: "elevator", make: "Otis", location: "South lobby", criticality: "high", installedOn: "2012-06-01" });
  await addAsset("KWR", "MAIN", { name: "Boiler", tag: "KWR-BLR-1", category: "hvac", make: "Lochinvar", location: "Basement boiler room", criticality: "critical", installedOn: "2009-10-01", vendorId: V("Blake").id });
  await addAsset("KWR", "MAIN", { name: "Elevator", tag: "KWR-ELV-1", category: "elevator", location: "Lobby", criticality: "high", installedOn: "1998-08-01" });
  await addAsset("KWR", "MAIN", { name: "Garbage compactor", tag: "KWR-CMP-1", category: "appliance", location: "Garbage room", criticality: "low", installedOn: "2015-03-01" });

  /* ── links to existing work orders, plus asset history ── */
  let [{ n: woNumber }] = (await tx.execute(sql`select coalesce(max(number), 0)::int as n from work_orders where org_id = ${orgId}`)).rows as { n: number }[];
  const histWo = async (a: typeof assetRows[number], w: { title: string; ageDays: number; costMin: number; costMax: number; vendor?: string | null; pm?: string | null; open?: boolean; desc?: string; durationH?: number; category?: string }) => {
    const createdAt = new Date(now.getTime() - w.ageDays * D);
    const completedAt = w.open ? null : new Date(createdAt.getTime() + (w.durationH ?? between(4, 48)) * H);
    const [row] = await tx.insert(s.workOrders).values({
      orgId, number: ++woNumber, propertyId: a.propertyId, buildingId: a.buildingId, area: a.location, category: w.category ?? (a.category === "elevator" ? "elevator" : a.category === "fire_safety" ? "fire_safety" : a.category === "plumbing" ? "plumbing" : a.category === "doors_access" ? "parking" : a.category === "generator" ? "electrical" : "hvac"),
      priority: w.pm ? "normal" : "high", title: w.title, description: w.desc ?? "", status: w.open ? "assigned" : "closed", source: w.pm ? "system" : "staff",
      submittedByUserId: w.pm ? null : pick([pm.userId, facility.userId, tech.userId]), vendorId: w.vendor === null ? null : (w.vendor ? V(w.vendor).id : a.vendorId),
      respondDueAt: new Date(createdAt.getTime() + 4 * H), resolveDueAt: new Date(createdAt.getTime() + (w.pm ? 7 * D : 48 * H)), firstResponseAt: new Date(createdAt.getTime() + 1.5 * H),
      completedAt, closedAt: completedAt ? new Date(completedAt.getTime() + 12 * H) : null, cost: completedAt ? between(w.costMin, w.costMax).toFixed(2) : null,
      resolutionNotes: completedAt ? (w.pm ? "Scheduled maintenance completed; no defects found." : pick(["Replaced failed component and tested.", "Reset and recalibrated; monitoring.", "Cleaned and adjusted; running normally."])) : null,
      sourceType: w.pm ? "pm_schedule" : null, sourceId: w.pm ?? null, assetId: a.id, createdAt, updatedAt: completedAt ?? createdAt,
    }).returning();
    await tx.insert(s.timelineEvents).values({ orgId, entityType: "work_order", entityId: row.id, kind: "created", toStatus: "new", visibility: "public", body: w.pm ? `Request #${row.number} opened from the preventive maintenance schedule.` : `Request #${row.number} submitted.`, createdAt });
    if (completedAt) await tx.insert(s.timelineEvents).values({ orgId, entityType: "work_order", entityId: row.id, kind: "status", fromStatus: "assigned", toStatus: "closed", visibility: "public", actorUserId: pm.userId, createdAt: completedAt });
    return row;
  };
  const downtime = async (a: typeof assetRows[number], wo: { id: string; createdAt: Date; completedAt: Date | null }, reason: string) =>
    tx.insert(s.assetDowntime).values({ orgId, assetId: a.id, propertyId: a.propertyId, startedAt: wo.createdAt, endedAt: wo.completedAt, reason, workOrderId: wo.id, startedByUserId: facility.userId });

  // HBC RTU-4: the recurring-HVAC pattern (6 requests in 90 days, recorded downtime)
  const rtu4 = A("Rooftop unit RTU-4");
  const rtu4Issues = [
    { title: "RTU-4 not cooling top-floor corridors", ageDays: 84, durationH: 30 }, { title: "RTU-4 compressor tripping on high pressure", ageDays: 66, durationH: 20 },
    { title: "RTU-4 short cycling", ageDays: 47, durationH: 8 }, { title: "RTU-4 condenser fan motor noisy", ageDays: 31, durationH: 6 },
    { title: "RTU-4 compressor tripping again", ageDays: 14, durationH: 26 }, { title: "RTU-4 high-pressure alarm", ageDays: 2, open: true },
  ];
  for (const w of rtu4Issues) {
    const wo = await histWo(rtu4, { ...w, costMin: 320, costMax: 1450, vendor: "Blake" });
    if (w.durationH && w.durationH >= 20) await downtime(rtu4, wo, w.title);
  }
  // FRT parkade gate: 4 reactive requests in 60 days
  for (const [t, age] of [["Parkade gate arm not lifting", 58], ["Gate closing on vehicles", 37], ["Gate remote receiver not responding", 19], ["Parkade gate stuck open", 4]] as [string, number][]) {
    await histWo(A("Parkade gate operator"), { title: t, ageDays: age, costMin: 120, costMax: 480, vendor: null, open: age < 5, category: "parking" });
  }
  // existing elevator requests at Fraser Towers belong to the Tower B cars; the urgent one keeps car 2 down right now
  const frtElevatorWos = await tx.select().from(s.workOrders).where(and(eq(s.workOrders.orgId, orgId), eq(s.workOrders.propertyId, P("FRT").id), eq(s.workOrders.category, "elevator"), isNull(s.workOrders.assetId)));
  for (const w of frtElevatorWos) {
    const car = w.title === "Tower B elevator out of service" ? A("Tower B elevator car 2") : w.buildingId === towerB.id ? pick([A("Tower B elevator car 1"), A("Tower B elevator car 2")]) : pick([A("Tower A elevator car 1"), A("Tower A elevator car 2")]);
    await tx.update(s.workOrders).set({ assetId: car.id }).where(eq(s.workOrders.id, w.id));
  }
  if (elevatorWo) {
    await tx.insert(s.assetDowntime).values({ orgId, assetId: A("Tower B elevator car 2").id, propertyId: P("FRT").id, startedAt: elevatorWo.createdAt, reason: "Stuck on level 9 with doors open", workOrderId: elevatorWo.id, startedByUserId: concierge.userId });
    await tx.update(s.assets).set({ status: "down" }).where(eq(s.assets.id, A("Tower B elevator car 2").id));
  }
  // a few HBC hvac requests belong to RTU-1..3
  const hbcHvac = await tx.select().from(s.workOrders).where(and(eq(s.workOrders.orgId, orgId), eq(s.workOrders.propertyId, P("HBC").id), eq(s.workOrders.category, "hvac"), isNull(s.workOrders.assetId)));
  for (const w of hbcHvac.slice(0, 3)) await tx.update(s.workOrders).set({ assetId: pick([A("Rooftop unit RTU-1"), A("Rooftop unit RTU-2"), A("Rooftop unit RTU-3")]).id }).where(eq(s.workOrders.id, w.id));

  /* ── preventive maintenance schedules (with a year of completed history) ── */
  const pm_ = async (assetName: string, x: { title: string; unit: "day" | "week" | "month" | "year"; every: number; dueIn: number; lead?: number; vendor?: string; staff?: { id: string }; instructions?: string; history?: number; cost?: [number, number] }) => {
    const a = A(assetName);
    const nextDueOn = addDays(today, x.dueIn);
    const [sch] = await tx.insert(s.pmSchedules).values({
      orgId, assetId: a.id, propertyId: a.propertyId, title: x.title, instructions: x.instructions ?? null, intervalUnit: x.unit, intervalCount: x.every, nextDueOn, leadDays: x.lead ?? 7,
      assignVendorId: x.vendor ? V(x.vendor).id : null, assignMembershipId: x.staff?.id ?? null,
    }).returning();
    // past occurrences, oldest first
    let due = nextDueOn;
    const past: string[] = [];
    for (let i = 0; i < (x.history ?? 0); i++) { due = addInterval(due, x.unit, -x.every); if (due < addDays(today, -365)) break; past.unshift(due); }
    let last: { id: string } | null = null;
    for (const d of past) {
      last = await histWo(a, { title: `${x.title} — ${a.name}`, ageDays: (now.getTime() - at(d, "09:00").getTime()) / D + (x.lead ?? 7), costMin: x.cost?.[0] ?? 0, costMax: x.cost?.[1] ?? 0, vendor: x.vendor ?? null, pm: sch.id, durationH: between(48, 150) });
    }
    if (last) await tx.update(s.pmSchedules).set({ lastWorkOrderId: last.id, lastGeneratedAt: new Date(now.getTime() - 20 * D) }).where(eq(s.pmSchedules.id, sch.id));
  };
  const elevatorPm = { title: "Monthly elevator maintenance", unit: "month" as const, every: 1, vendor: "Summit", history: 6, cost: [280, 420] as [number, number], instructions: "Inspect hoistway, door operators and safety circuits; log readings in the machine-room book." };
  await pm_("Tower A elevator car 1", { ...elevatorPm, dueIn: 12 });
  await pm_("Tower A elevator car 2", { ...elevatorPm, dueIn: 12 });
  await pm_("Tower B elevator car 1", { ...elevatorPm, dueIn: 19 });
  await pm_("Tower B elevator car 2", { ...elevatorPm, dueIn: 19 });
  await pm_("Boiler B-1", { title: "Annual boiler inspection", unit: "year", every: 1, dueIn: 41, lead: 21, vendor: "Blake", history: 1, cost: [650, 900] });
  await pm_("Boiler B-1", { title: "Monthly boiler check", unit: "month", every: 1, dueIn: 9, staff: X("tomas"), history: 5, instructions: "Check pressure, flue temperature and condensate drain; record readings." });
  await pm_("Boiler B-2", { title: "Monthly boiler check", unit: "month", every: 1, dueIn: 9, staff: X("tomas"), history: 5 });
  await pm_("Emergency generator", { title: "Monthly generator load test", unit: "month", every: 1, dueIn: 3, staff: X("tomas"), history: 6, instructions: "Run under load for 30 minutes; check fuel level, battery and transfer switch." });
  await pm_("Fire alarm panel — Tower A", { title: "Annual fire alarm inspection", unit: "year", every: 1, dueIn: 64, lead: 30, vendor: "Firewise", history: 1, cost: [900, 1300] });
  await pm_("Fire alarm panel — Tower B", { title: "Annual fire alarm inspection", unit: "year", every: 1, dueIn: 64, lead: 30, vendor: "Firewise", history: 1, cost: [900, 1300] });
  await pm_("Make-up air unit MAU-1", { title: "Quarterly filter change", unit: "month", every: 3, dueIn: 26, vendor: "Blake", history: 3, cost: [180, 260] });
  for (const n of [1, 2, 3, 4]) await pm_(`Rooftop unit RTU-${n}`, { title: "Quarterly filter change", unit: "month", every: 3, dueIn: 6 + n * 7, vendor: "Blake", history: 3, cost: [150, 240] });
  await pm_("Passenger elevator 1", { ...elevatorPm, dueIn: 22 });
  await pm_("Sprinkler system", { title: "Annual sprinkler inspection", unit: "year", every: 1, dueIn: 120, lead: 30, vendor: "Firewise", history: 1, cost: [700, 950] });
  await pm_("Pool circulation pump", { title: "Weekly pool chemistry and pump check", unit: "week", every: 1, dueIn: 2, lead: 1, staff: X("ivan"), history: 8 });

  /* ── counters ── */
  const setCounter = (key: string, value: number) => tx.insert(s.orgCounters).values({ orgId, key, value }).onConflictDoUpdate({ target: [s.orgCounters.orgId, s.orgCounters.key], set: { value } });
  await setCounter("work_order", woNumber);
  await setCounter("parking_permit", permitNo);
  await setCounter("parking_violation", violationNo);

  return { shifts: shiftRows.length, visitors: visitorRows.length, spaces: spaces.length, vehicles: vehicleRows.length, permits: permitRows.length, violations: violations.length, assets: assetRows.length, extraStaff: EXTRA_STAFF.length };
}

// one row per table in the second tenant, so isolation tests cover them
export async function seedFacilityTenant(tx: Tx, ns: { orgId: string; propertyId: string; buildingId: string; unitId: string; membershipId: string; userId: string }) {
  const now = new Date();
  const [sp] = await tx.insert(s.parkingSpaces).values({ orgId: ns.orgId, propertyId: ns.propertyId, code: "V-01", kind: "visitor" }).returning();
  const [veh] = await tx.insert(s.vehicles).values({ orgId: ns.orgId, propertyId: ns.propertyId, unitId: ns.unitId, plate: "NSH101" }).returning();
  const [v] = await tx.insert(s.visitors).values({ orgId: ns.orgId, propertyId: ns.propertyId, buildingId: ns.buildingId, unitId: ns.unitId, name: "Northshore Guest", expectedFrom: now, expectedUntil: new Date(now.getTime() + 4 * H), passTokenHash: passHash() }).returning();
  await tx.insert(s.parkingPermits).values({ orgId: ns.orgId, number: 1, propertyId: ns.propertyId, kind: "visitor", plate: "NSH202", spaceId: sp.id, visitorId: v.id, validFrom: now, validUntil: new Date(now.getTime() + 4 * H) });
  await tx.insert(s.parkingViolations).values({ orgId: ns.orgId, number: 1, propertyId: ns.propertyId, plate: "NSH303", kind: "no_permit", observedAt: now, vehicleId: veh.id });
  const [sh] = await tx.insert(s.shifts).values({ orgId: ns.orgId, propertyId: ns.propertyId, membershipId: ns.membershipId, startsAt: now, endsAt: new Date(now.getTime() + 8 * H) }).returning();
  await tx.insert(s.shiftHandoffs).values({ orgId: ns.orgId, propertyId: ns.propertyId, shiftId: sh.id, authorUserId: ns.userId, notes: "All quiet." });
  const [a] = await tx.insert(s.assets).values({ orgId: ns.orgId, propertyId: ns.propertyId, name: "Lofts boiler", category: "hvac", tag: "LQL-BLR" }).returning();
  await tx.insert(s.pmSchedules).values({ orgId: ns.orgId, assetId: a.id, propertyId: ns.propertyId, title: "Annual service", intervalUnit: "year", intervalCount: 1, nextDueOn: addDays(localDate(now), 200) });
  await tx.insert(s.assetDowntime).values({ orgId: ns.orgId, assetId: a.id, propertyId: ns.propertyId, startedAt: new Date(now.getTime() - 30 * D), endedAt: new Date(now.getTime() - 29 * D), reason: "Pilot light out" });
  await tx.insert(s.orgCounters).values([{ orgId: ns.orgId, key: "parking_permit", value: 1 }, { orgId: ns.orgId, key: "parking_violation", value: 1 }]);
}
