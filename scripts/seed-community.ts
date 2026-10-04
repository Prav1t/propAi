import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as s from "../src/server/db/schema";
import { zonedToUtc } from "../src/lib/time";
import { blobStore } from "../src/server/files/storage";
import { makePdf } from "./lib-pdf";

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

const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const at = (dayOffset: number, hhmm: string, now: Date) => zonedToUtc(`${localDate(new Date(now.getTime() + dayOffset * D))}T${hhmm}`, TZ);

// stores a demo file through the configured BlobStore and returns its `files` row
export async function seedFile(tx: Tx, orgId: string, entityType: string, entityId: string, filename: string, bytes: Uint8Array, contentType: string, visibility = "public", userId: string | null = null) {
  const key = `${orgId}/${entityType}/${randomUUID()}`;
  await blobStore().put(key, bytes, contentType);
  const [f] = await tx.insert(s.files).values({
    orgId, entityType, entityId, storageKey: key, filename, contentType, sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), visibility, scanStatus: "unscanned", uploadedByUserId: userId,
  }).returning();
  return f;
}

// amenities, bookings, packages, announcements, conversations and documents for the demo org
export async function seedCommunity(tx: Tx, orgId: string, now = new Date()) {
  const rand = rng(777001);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

  const props = await tx.select().from(s.properties).where(eq(s.properties.orgId, orgId));
  const P = (code: string) => props.find((p) => p.code === code)!;
  const blds = await tx.select().from(s.buildings).where(eq(s.buildings.orgId, orgId));
  const B = (prop: string, code: string) => blds.find((b) => b.propertyId === P(prop).id && b.code === code)!;
  const mem = await tx.select({ id: s.memberships.id, email: s.users.email, userId: s.users.id, name: s.users.name }).from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId)).where(eq(s.memberships.orgId, orgId));
  const M = (email: string) => mem.find((m) => m.email === email)!;
  const pm = M("pm@demo.test"), concierge = M("concierge@demo.test"), admin = M("admin@demo.test"), emma = M("resident@demo.test"), noah = M("owner@demo.test");
  const occupied = await tx.select({ unitId: s.units.id, number: s.units.number, buildingId: s.units.buildingId, propertyId: s.units.propertyId, residentId: s.residents.id, first: s.residents.firstName, last: s.residents.lastName, userId: s.residents.userId, primary: s.unitOccupancies.isPrimary })
    .from(s.unitOccupancies).innerJoin(s.units, eq(s.units.id, s.unitOccupancies.unitId)).innerJoin(s.residents, eq(s.residents.id, s.unitOccupancies.residentId))
    .where(and(eq(s.unitOccupancies.orgId, orgId), isNull(s.unitOccupancies.endsOn)));
  const primaries = occupied.filter((o) => o.primary);
  const emmaHome = occupied.find((o) => o.userId === emma.userId)!;
  const noahHome = occupied.find((o) => o.userId === noah.userId)!;

  /* ── property contacts ── */
  for (const p of props) {
    await tx.update(s.properties).set({
      emergencyPhone: "604-555-0100", officeHours: p.code === "FRT" ? "Front desk 24/7 · Office Mon–Fri 9–5" : "Mon–Fri 9–5",
      emergencyInfo: "Fire, smoke or someone hurt: call 911 first.\nWater leak: shut off the valve under the sink or behind the toilet, then call the emergency line.\nPower outage: check the building announcements before calling.",
    }).where(eq(s.properties.id, p.id));
  }

  /* ── amenities ── */
  const base = { orgId, active: true, eligibleRoles: [] as string[] };
  const [partyRoom, gym, rooftop, theatre, meeting, hbcGym, clubhouse, pool] = await tx.insert(s.amenities).values([
    { ...base, propertyId: P("FRT").id, buildingId: null, name: "Party Room", kind: "party_room", location: "Tower A, level 2", capacity: 40, maxConcurrent: 1,
      opensAtMinute: 9 * 60, closesAtMinute: 23 * 60, slotMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 300, minNoticeHours: 48, maxAdvanceDays: 90,
      limitCount: 2, limitPeriodDays: 30, cancellationHours: 72, requiresApproval: true, feeCents: 5000, depositCents: 25000,
      description: "Kitchen, 6 tables, 40 chairs and a sound system.", rules: "Music off by 10:30 pm. Leave the room as you found it; a cleaning fee is taken from the deposit otherwise. No confetti or glitter." },
    { ...base, propertyId: P("FRT").id, buildingId: null, name: "Fitness Centre", kind: "gym", location: "Tower B, level 3", capacity: 2, maxConcurrent: 8,
      opensAtMinute: 6 * 60, closesAtMinute: 23 * 60, slotMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 90, minNoticeHours: 0, maxAdvanceDays: 7,
      cancellationHours: 1, requiresApproval: false, description: "Cardio and free weights. Bookings guarantee a spot during busy hours.", rules: "Wipe down equipment after use. Under-16s must be supervised." },
    { ...base, propertyId: P("FRT").id, buildingId: null, name: "Rooftop BBQ Terrace", kind: "bbq", location: "Tower B roof", capacity: 12, maxConcurrent: 1,
      opensAtMinute: 11 * 60, closesAtMinute: 22 * 60, slotMinutes: 60, minDurationMinutes: 120, maxDurationMinutes: 240, minNoticeHours: 4, maxAdvanceDays: 30,
      limitCount: 4, limitPeriodDays: 30, cancellationHours: 24, requiresApproval: false, rules: "Propane only. Close the barbecue lid and turn off the tank when done." },
    { ...base, propertyId: P("FRT").id, buildingId: null, name: "Theatre Room", kind: "theatre", location: "Tower A, level 2", capacity: 14, maxConcurrent: 1,
      opensAtMinute: 10 * 60, closesAtMinute: 23 * 60, slotMinutes: 60, minDurationMinutes: 120, maxDurationMinutes: 240, minNoticeHours: 24, maxAdvanceDays: 30,
      cancellationHours: 24, requiresApproval: false, eligibleRoles: ["owner"], rules: "Owners only (council resolution 2025-04)." },
    { ...base, propertyId: P("HBC").id, buildingId: null, name: "Meeting Room", kind: "meeting_room", location: "Lobby level", capacity: 10, maxConcurrent: 1,
      opensAtMinute: 8 * 60, closesAtMinute: 21 * 60, slotMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180, minNoticeHours: 2, maxAdvanceDays: 30, cancellationHours: 4, requiresApproval: false },
    { ...base, propertyId: P("HBC").id, buildingId: null, name: "Gym", kind: "gym", location: "P1", capacity: 1, maxConcurrent: 5,
      opensAtMinute: 5 * 60, closesAtMinute: 23 * 60, slotMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 60, minNoticeHours: 0, maxAdvanceDays: 3, cancellationHours: 1, requiresApproval: false },
    { ...base, propertyId: P("PCH").id, buildingId: null, name: "Clubhouse", kind: "lounge", location: "Courtyard", capacity: 50, maxConcurrent: 1,
      opensAtMinute: 10 * 60, closesAtMinute: 23 * 60, slotMinutes: 60, minDurationMinutes: 120, maxDurationMinutes: 360, minNoticeHours: 72, maxAdvanceDays: 120,
      limitCount: 1, limitPeriodDays: 60, cancellationHours: 96, requiresApproval: true, feeCents: 7500, depositCents: 50000, eligibleRoles: ["owner", "tenant"] },
    { ...base, propertyId: P("PCH").id, buildingId: null, name: "Pool", kind: "pool", location: "South Building", capacity: 4, maxConcurrent: 6,
      opensAtMinute: 7 * 60, closesAtMinute: 21 * 60, slotMinutes: 60, minDurationMinutes: 60, maxDurationMinutes: 120, minNoticeHours: 0, maxAdvanceDays: 7, cancellationHours: 2, requiresApproval: false },
  ]).returning();

  await tx.insert(s.amenityBlackouts).values([
    { orgId, amenityId: gym.id, startsAt: at(5, "06:00", now), endsAt: at(5, "10:00", now), reason: "Equipment servicing", createdByUserId: pm.userId },
    { orgId, amenityId: partyRoom.id, startsAt: at(20, "09:00", now), endsAt: at(20, "23:00", now), reason: "Strata AGM", createdByUserId: pm.userId },
    { orgId, amenityId: pool.id, startsAt: at(9, "07:00", now), endsAt: at(11, "21:00", now), reason: "Annual pool cleaning", createdByUserId: admin.userId },
  ]);

  /* ── bookings ── */
  let bookingNo = 0;
  const bookingRows: (typeof s.bookings.$inferInsert)[] = [];
  const book = (a: typeof partyRoom, unit: { unitId: string; residentId: string; userId: string | null } | null, start: Date, minutes: number, status: string, extra: Partial<typeof s.bookings.$inferInsert> = {}) => {
    bookingNo++;
    bookingRows.push({
      orgId, number: bookingNo, amenityId: a.id, propertyId: a.propertyId, buildingId: a.buildingId, unitId: unit?.unitId ?? null, residentId: unit?.residentId ?? null,
      bookedByUserId: unit?.userId ?? pm.userId, startsAt: start, endsAt: new Date(start.getTime() + minutes * 60_000), guests: Math.max(1, Math.min(a.capacity ?? 1, 1 + Math.floor(rand() * (a.capacity ?? 1)))),
      status, exclusive: a.maxConcurrent === 1, feeCents: a.feeCents, depositCents: a.depositCents,
      feeStatus: a.feeCents ? (status === "approved" ? pick(["due", "paid", "paid"]) : "due") : "none", depositStatus: a.depositCents ? (status === "approved" ? pick(["due", "held"]) : "due") : "none",
      decidedAt: status === "requested" ? null : new Date(start.getTime() - 3 * D), decidedByUserId: a.requiresApproval && status !== "requested" ? pm.userId : null,
      createdAt: new Date(start.getTime() - (4 + rand() * 10) * D), ...extra,
    });
  };
  const frtUnits = primaries.filter((o) => o.propertyId === P("FRT").id && o.userId === null);
  const pchUnits = primaries.filter((o) => o.propertyId === P("PCH").id);
  const hbcUnits = primaries.filter((o) => o.propertyId === P("HBC").id);
  // exclusive amenities: at most one booking per day, so the no-overlap constraint always holds
  for (let d = -30; d <= 40; d++) {
    if (rand() < 0.22 && d !== 6 && d !== 20) {
      const st = d < 0 ? "approved" : rand() < 0.5 ? "requested" : "approved";
      book(partyRoom, pick(frtUnits), at(d, pick(["13:00", "17:00", "18:00"]), now), pick([180, 240, 300]), st, d < 0 && rand() < 0.15 ? { status: "cancelled", cancelledAt: new Date(now.getTime() + (d - 2) * D), cancelReason: "Plans changed" } : {});
    }
    if (rand() < 0.3) book(rooftop, pick(frtUnits), at(d, pick(["12:00", "16:00", "18:00"]), now), pick([120, 180, 240]), "approved");
    if (rand() < 0.12) book(theatre, pick(frtUnits), at(d, "19:00", now), 180, "approved");
    if (rand() < 0.35) book(meeting, pick(hbcUnits), at(d, pick(["09:00", "13:30", "18:00"]), now), pick([60, 90, 120]), "approved");
    if (rand() < 0.08 && d > -20) book(clubhouse, pick(pchUnits), at(d, "15:00", now), 300, d < 0 ? "approved" : pick(["requested", "approved"]));
    for (let g = 0; g < (rand() < 0.5 ? 2 : 0); g++) book(gym, pick(frtUnits), at(d, pick(["06:30", "07:00", "17:30", "18:00", "19:00"]), now), pick([30, 60, 90]), "approved");
    if (rand() < 0.4) book(hbcGym, pick(hbcUnits), at(d, pick(["06:00", "07:30", "18:00", "20:00"]), now), pick([30, 60]), "approved");
    for (let g = 0; g < (rand() < 0.4 ? 2 : 0); g++) book(pool, pick(pchUnits), at(d, pick(["08:00", "10:00", "15:00", "18:00"]), now), 60, "approved");
  }
  // the demo resident's own bookings
  const emmaUnit = { unitId: emmaHome.unitId, residentId: emmaHome.residentId, userId: emma.userId };
  book(partyRoom, emmaUnit, at(6, "18:00", now), 240, "requested", { purpose: "Birthday dinner", guests: 20 });
  book(rooftop, emmaUnit, at(-9, "16:00", now), 180, "approved", { guests: 6, feeStatus: "none" });
  book(gym, emmaUnit, at(1, "07:00", now), 60, "approved", { guests: 1 });
  book(partyRoom, emmaUnit, at(-25, "13:00", now), 240, "approved", { guests: 25, feeStatus: "paid", depositStatus: "withheld", damageNotes: "Wine stain on two chair cushions; professional cleaning required." });
  book(theatre, { unitId: noahHome.unitId, residentId: noahHome.residentId, userId: noah.userId }, at(3, "19:00", now), 180, "approved", { guests: 6 });
  // the generator above may already hold Emma's slots on exclusive amenities; drop clashes deterministically (latest wins)
  const kept: typeof bookingRows = [];
  for (const b of bookingRows.reverse()) {
    const clash = b.exclusive && ["requested", "approved"].includes(b.status!) && kept.some((k) => k.amenityId === b.amenityId && k.exclusive && ["requested", "approved"].includes(k.status!) && k.startsAt! < b.endsAt! && b.startsAt! < k.endsAt!);
    if (!clash) kept.push(b);
  }
  kept.sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime()).forEach((b, i) => { b.number = i + 1; });
  // one declined request for realism
  const firstRequested = kept.find((b) => b.status === "requested" && b.unitId !== emmaHome.unitId && b.amenityId === partyRoom.id);
  if (firstRequested) Object.assign(firstRequested, { status: "declined", decisionNote: "The room is reserved for the strata's moving-day coordination that afternoon.", decidedAt: new Date(now.getTime() - D), decidedByUserId: pm.userId });
  await tx.insert(s.bookings).values(kept);
  await tx.insert(s.orgCounters).values({ orgId, key: "booking", value: kept.length }).onConflictDoUpdate({ target: [s.orgCounters.orgId, s.orgCounters.key], set: { value: kept.length } });

  /* ── packages ── */
  const CARRIERS = ["Amazon", "Canada Post", "Purolator", "UPS", "FedEx", "Intelcom", "DHL"];
  const tracking = (c: string) => c === "UPS" ? `1Z${Array.from({ length: 16 }, () => "0123456789ABCDEFGHJKLMNPRSTUVWXYZ"[Math.floor(rand() * 33)]).join("")}`
    : c === "Amazon" ? `TBA${Math.floor(100000000000 + rand() * 899999999999)}` : c === "Canada Post" ? String(Math.floor(1e15 + rand() * 8.9e15)) : String(Math.floor(1e11 + rand() * 8.9e11));
  const code = () => String(Math.floor(rand() * 1_000_000)).padStart(6, "0");
  const pkgUnits = primaries.filter((o) => o.propertyId === P("FRT").id || o.propertyId === P("HBC").id);
  const pkgs: (typeof s.packages.$inferInsert)[] = [];
  const addPkg = (o: (typeof occupied)[number], ageH: number, status: string, extra: Partial<typeof s.packages.$inferInsert> = {}) => {
    const carrier = pick(CARRIERS);
    const received = new Date(now.getTime() - ageH * H);
    pkgs.push({
      orgId, propertyId: o.propertyId, buildingId: o.buildingId, unitId: o.unitId, residentId: o.residentId, recipientName: `${o.first} ${o.last}`,
      carrier, trackingNumber: tracking(carrier), size: pick(["envelope", "small", "small", "medium", "medium", "large"]), shelfLocation: `${pick(["A", "B", "C"])}${1 + Math.floor(rand() * 6)}`,
      status, pickupCode: code(), receivedAt: received, receivedByUserId: concierge.userId, createdAt: received,
      ...(status === "picked_up" ? { pickedUpAt: new Date(received.getTime() + (2 + rand() * 60) * H), pickedUpByName: `${o.first} ${o.last}`, releasedByUserId: concierge.userId } : {}),
      ...(ageH > 72 && status === "waiting" ? { reminderSentAt: new Date(received.getTime() + 72 * H) } : {}),
      ...extra,
    });
  };
  for (let i = 0; i < 26; i++) addPkg(pick(pkgUnits), 6 + rand() * 24 * 20, "picked_up");
  for (let i = 0; i < 9; i++) addPkg(pick(pkgUnits), 1 + rand() * 24 * 4, "waiting");
  addPkg(pick(pkgUnits), 24 * 9, "waiting", { notes: "Second notice left under door." });
  addPkg(pick(pkgUnits), 24 * 12, "waiting");
  addPkg(pick(pkgUnits), 5, "waiting", { perishable: true, size: "medium", carrier: "Intelcom", notes: "Grocery delivery, in the fridge." });
  addPkg(pick(pkgUnits), 24 * 16, "returned", { returnedAt: new Date(now.getTime() - 2 * D), returnReason: "Unclaimed after 14 days" });
  addPkg(emmaHome, 3, "waiting", { carrier: "Amazon", trackingNumber: "TBA316248591027", size: "medium", shelfLocation: "B2" });
  addPkg(emmaHome, 27, "waiting", { carrier: "Canada Post", trackingNumber: "7316402215890034", size: "small", shelfLocation: "A4" });
  addPkg(emmaHome, 24 * 6, "picked_up");
  addPkg(emmaHome, 24 * 15, "picked_up");
  addPkg(noahHome, 8, "waiting", { carrier: "UPS", size: "large", shelfLocation: "Floor" });
  await tx.insert(s.packages).values(pkgs);

  /* ── announcements ── */
  const ann = await tx.insert(s.announcements).values([
    { orgId, propertyId: null, audience: "everyone", category: "general", title: "Thanksgiving office hours", status: "published", publishedAt: new Date(now.getTime() - 2 * D), createdByUserId: admin.userId,
      body: "Our offices are closed on Monday for Thanksgiving. The 24/7 emergency line (604-555-0100) stays open, and front desks keep their usual hours." },
    { orgId, propertyId: P("FRT").id, buildingIds: [B("FRT", "B").id], audience: "everyone", category: "maintenance", pinned: true, title: "Tower B elevator modernization: car 2 out of service", status: "published", publishedAt: new Date(now.getTime() - 3 * H), createdByUserId: pm.userId,
      body: "Car 2 in Tower B is out of service while Summit Elevator Services replaces its controller. Car 1 is running normally. Expected back in service within 10 days. If you need help with mobility or a large delivery, contact the front desk." },
    { orgId, propertyId: P("FRT").id, audience: "everyone", category: "maintenance", title: "Annual fire alarm testing", status: "scheduled", publishAt: new Date(now.getTime() + 2 * D), createdByUserId: pm.userId,
      body: "Firewise Safety Systems will test alarms in both towers next week between 9 am and 4 pm. Alarms will sound briefly in each suite. No action is needed." },
    { orgId, propertyId: P("FRT").id, audience: "residents", category: "event", title: "Halloween in the lobby", status: "draft", createdByUserId: concierge.userId,
      body: "Join us in the Tower A lobby on October 31 from 5–7 pm for treats and a costume parade." },
    { orgId, propertyId: P("HBC").id, audience: "everyone", category: "maintenance", title: "Water shut-off Thursday 10 am – 1 pm", status: "published", publishedAt: new Date(now.getTime() - D), expiresAt: new Date(now.getTime() + 3 * D), createdByUserId: pm.userId,
      body: "Domestic water will be shut off on Thursday from 10 am to 1 pm while the riser valve is replaced. Please store water beforehand and keep taps closed." },
    { orgId, propertyId: P("PCH").id, audience: "residents", category: "policy", title: "Notice of Annual General Meeting", status: "published", publishedAt: new Date(now.getTime() - 5 * D), createdByUserId: admin.userId,
      body: "The AGM will be held in the Clubhouse on the 20th at 7 pm. The agenda and budget are in Documents. Proxy forms are available from the office." },
    { orgId, propertyId: P("FRT").id, audience: "everyone", category: "emergency", title: "Boil water advisory lifted", status: "archived", publishedAt: new Date(now.getTime() - 40 * D), createdByUserId: pm.userId,
      body: "The City has lifted the boil water advisory. Run taps for two minutes before use." },
  ]).returning();
  await tx.insert(s.announcementReads).values({ orgId, announcementId: ann[0].id, userId: emma.userId, readAt: new Date(now.getTime() - D) });

  /* ── conversations ── */
  const thread = async (o: { unitId: string; buildingId: string; propertyId: string; residentId: string }, userId: string | null, subject: string, category: string, msgs: [boolean, string, number][], status = "open", assigned: string | null = null) => {
    const last = msgs[msgs.length - 1];
    const [t] = await tx.insert(s.messageThreads).values({
      orgId, propertyId: o.propertyId, buildingId: o.buildingId, unitId: o.unitId, residentId: o.residentId, residentUserId: userId, subject, category, status,
      assignedMembershipId: assigned, createdByUserId: msgs[0][0] ? pm.userId : userId, lastMessageAt: new Date(now.getTime() - last[2] * H), lastMessagePreview: last[1].slice(0, 140), lastFromStaff: last[0],
      createdAt: new Date(now.getTime() - msgs[0][2] * H),
    }).returning();
    await tx.insert(s.messages).values(msgs.map(([staff, body, ago]) => ({ orgId, threadId: t.id, authorUserId: staff ? concierge.userId : userId, fromStaff: staff, body, createdAt: new Date(now.getTime() - ago * H) })));
    return t;
  };
  const conciergeM = mem.find((m) => m.email === "concierge@demo.test")!;
  const t1 = await thread(emmaHome, emma.userId, "Visitor parking for my parents", "parking", [
    [false, "Hi, my parents are visiting next weekend. Can they use visitor parking for two nights?", 52],
    [true, "Hi Emma, yes — visitor stalls allow up to 72 hours. Ask them to register the plate at the front desk when they arrive.", 49],
    [false, "Perfect, thank you!", 48],
  ], "closed", conciergeM.id);
  const t2 = await thread(emmaHome, emma.userId, "Noise from the unit above", "general", [
    [false, "There's been loud thumping from the unit above after midnight for three nights now. Is there anything you can do?", 30],
    [true, "Thanks for letting us know. We've reminded the residents above about quiet hours (11 pm–7 am). If it happens again tonight, please call the front desk so we can document it.", 4],
  ], "open", conciergeM.id);
  await thread(noahHome, noah.userId, "Window cleaning schedule", "maintenance", [[false, "When are the exterior windows on Tower A being cleaned this fall?", 6]]);
  for (const o of frtUnits.slice(0, 4)) {
    await thread(o, null, pick(["Key fob not working", "Move-in date question", "Storage locker request", "Bike room access"]), pick(["general", "parking", "other"]), [[false, "Could someone get back to me about this when you have a moment?", 20 + rand() * 60]]);
  }
  await tx.insert(s.messageReads).values([
    { orgId, threadId: t1.id, userId: emma.userId, lastReadAt: new Date(now.getTime() - 47 * H) },
    { orgId, threadId: t2.id, userId: emma.userId, lastReadAt: new Date(now.getTime() - 29 * H) },
  ]);
  await tx.insert(s.messageTemplates).values([
    { orgId, propertyId: null, name: "Request received", createdByUserId: admin.userId, body: "Hi {{resident_first_name}},\n\nThanks for your message. We've logged it and will get back to you within one business day.\n\n{{staff_name}}\n{{org_name}}" },
    { orgId, propertyId: null, name: "Package waiting", createdByUserId: admin.userId, body: "Hi {{resident_first_name}}, a package for unit {{unit}} is waiting at the {{building}} front desk. Bring your pickup code from the app." },
    { orgId, propertyId: P("FRT").id, name: "Quiet hours reminder", createdByUserId: pm.userId, body: "Hi {{resident_first_name}},\n\nA neighbour has raised concerns about noise late at night. A friendly reminder that quiet hours at {{property}} are 11 pm to 7 am. Thanks for your help.\n\n{{staff_name}}" },
  ]);

  // a couple of saved notification preferences
  await tx.insert(s.notificationPreferences).values([
    { orgId, userId: pm.userId, kind: "booking.request", email: true, inApp: true },
    { orgId, userId: concierge.userId, kind: "message.inbox", email: false, inApp: true },
  ]);

  /* ── documents (real files through the configured storage) ── */
  const doc = async (d: { title: string; category: string; audience: string; propertyId: string | null; buildingId?: string | null; unitId?: string | null; important?: boolean; description?: string }, versions: { name: string; lines: string[]; note?: string; text?: boolean }[]) => {
    const [row] = await tx.insert(s.documents).values({ orgId, propertyId: d.propertyId, buildingId: d.buildingId ?? null, unitId: d.unitId ?? null, title: d.title, description: d.description ?? null,
      category: d.category, audience: d.audience, important: d.important ?? false, currentVersion: versions.length, createdByUserId: pm.userId }).returning();
    let n = 0;
    for (const v of versions) {
      n++;
      const bytes = v.text ? new TextEncoder().encode(`${d.title}\n\n${v.lines.join("\n")}\n`) : makePdf(d.title, v.lines);
      const f = await seedFile(tx, orgId, "document", row.id, v.name, bytes, v.text ? "text/plain" : "application/pdf", n === versions.length ? "public" : "internal", pm.userId);
      await tx.insert(s.documentVersions).values({ orgId, documentId: row.id, version: n, fileId: f.id, notes: v.note ?? null, uploadedByUserId: pm.userId, createdAt: new Date(now.getTime() - (versions.length - n + 1) * 30 * D) });
    }
    return row;
  };
  await doc({ title: "Fraser Towers house rules", category: "rules", audience: "residents", propertyId: P("FRT").id, important: true, description: "Quiet hours, pets, balconies, moving and garbage." },
    [{ name: "fraser-towers-house-rules.pdf", lines: ["1. Quiet hours are 11 pm to 7 am.", "2. Book the service elevator for moves at least 48 hours ahead.", "3. Barbecues: propane only, rooftop terrace only.", "4. Pets must be leashed in common areas.", "5. Recycling and organics go to the P1 room; no bulky items."] }]);
  await doc({ title: "Amenity booking policy", category: "policy", audience: "residents", propertyId: P("FRT").id, important: true },
    [{ name: "amenity-booking-policy.pdf", lines: ["Party Room: approval required, $50 fee and $250 refundable deposit, book 48 hours ahead.", "Fitness Centre: up to 90 minutes, bookings open 7 days ahead.", "Rooftop BBQ Terrace: 2 to 4 hours, 4 bookings per unit per 30 days.", "Theatre Room: owners only."] }]);
  await doc({ title: "Fire safety plan", category: "manual", audience: "residents", propertyId: P("FRT").id, description: "Evacuation routes and muster points." },
    [{ name: "fire-safety-plan-2025.pdf", lines: ["Muster point: Quayside Park, east lawn.", "Do not use elevators during an alarm."], note: "2025 edition" },
     { name: "fire-safety-plan-2026.pdf", lines: ["Muster point: Quayside Park, east lawn.", "Do not use elevators during an alarm.", "New: refuge areas on levels 5 and 10 of each tower."], note: "Updated after the 2026 fire drill" }]);
  await doc({ title: "Strata bylaws (consolidated)", category: "bylaws", audience: "owners", propertyId: P("FRT").id, description: "As amended at the 2026 AGM." },
    [{ name: "bylaws-consolidated.pdf", lines: ["Part 1 — Duties of owners, tenants and occupants.", "Part 2 — Powers and duties of the strata corporation.", "Part 7 — Use of common property: amenity rooms may be restricted to owners by council resolution."] }]);
  await doc({ title: "2026 AGM minutes", category: "minutes", audience: "owners", propertyId: P("FRT").id },
    [{ name: "agm-minutes-2026.txt", text: true, lines: ["Quorum confirmed at 7:05 pm.", "Resolution 1: 2026 operating budget approved.", "Resolution 2: Theatre Room limited to owners — carried."] }]);
  await doc({ title: "Property insurance certificate", category: "insurance", audience: "staff", propertyId: P("FRT").id },
    [{ name: "insurance-certificate.pdf", lines: ["Insured: Fraser Towers Strata Corporation", "Policy period: 2026-04-01 to 2027-03-31"] }]);
  await doc({ title: "Tenancy agreement — Unit 1204", category: "lease", audience: "residents", propertyId: P("FRT").id, buildingId: B("FRT", "B").id, unitId: emmaHome.unitId },
    [{ name: "tenancy-agreement-1204.pdf", lines: ["Tenant: Emma Tremblay", "Unit: Tower B #1204", "Term: 12 months, then month to month."] }]);
  await doc({ title: "Harbour Centre house rules", category: "rules", audience: "residents", propertyId: P("HBC").id, important: true },
    [{ name: "harbour-centre-rules.pdf", lines: ["Quiet hours 10 pm to 7 am.", "Bicycles are not permitted in elevators."] }]);
  await doc({ title: "Water shut-off procedure", category: "manual", audience: "staff", propertyId: P("HBC").id },
    [{ name: "water-shutoff-procedure.txt", text: true, lines: ["Main valve: P2 mechanical room, north wall.", "Notify residents 48 hours ahead via Announcements."] }]);
  await doc({ title: "Resident privacy notice", category: "policy", audience: "residents", propertyId: null, description: "How Pacific Properties handles your personal information." },
    [{ name: "privacy-notice.pdf", lines: ["We collect contact details and unit information to manage your building.", "You can ask for a copy of your information at any time."] }]);

  return { amenities: 8, bookings: kept.length, packages: pkgs.length, announcements: ann.length, documents: 10 };
}


