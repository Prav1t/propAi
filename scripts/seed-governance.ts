import { and, asc, eq, sql } from "drizzle-orm";
import { db, withContext } from "../src/server/db/client";
import { buildings, properties, unitOccupancies, units, users } from "../src/server/db/schema";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import type { TenantCtx } from "../src/server/modules/context";
import { addActionItem, addMotion, approveMinutes, castVote, createMeeting, decideMotion, getMeeting, saveMinutes, setMeetingStatus } from "../src/server/modules/meetings/service";
import { createLease, endLease, getLease, giveNotice, recordPayment } from "../src/server/modules/leases/service";
import { addDays, addMonths, monthStart, todayIn } from "../src/lib/leasing";

// Demo data for governance (Pacific Heights, the strata property) and leasing (Kingsway Residences, the rental
// building), created through the real services so every rule, audit entry and rent charge is what the product makes.
export async function seedGovernance(): Promise<{ meetings: number; motions: number; leases: number; charges: number }> {
  const ctxFor = async (email: string): Promise<TenantCtx> => {
    const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
    const p = u ? await loadPrincipal(u.id, "pacific-properties") : null;
    if (!p) throw new Error(`seed-governance: ${email} missing`);
    return { principal: p, meta: null };
  };
  const [admin, council] = await Promise.all([ctxFor("admin@demo.test"), ctxFor("council@demo.test")]);
  const orgId = admin.principal.orgId;
  const prop = async (code: string) => (await withContext({ orgId, system: true }, (tx) => tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, orgId), eq(properties.code, code)))))[0].id;
  const [pch, kwr] = await Promise.all([prop("PCH"), prop("KWR")]);
  const day = 86_400_000;
  const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * day); d.setUTCHours(hour + 8, 0, 0, 0); return d; }; // evening, Pacific time
  let motions = 0;

  // last month's council meeting: held, decided, minutes approved, one action item
  const m1 = await createMeeting(council, { propertyId: pch, kind: "council", title: "Council meeting, last month", scheduledAt: "", location: "Amenity room, level 2",
    agenda: ["Call to order and approval of the agenda", "Landscaping contract renewal", "Move-in fee review", "Parkade membrane inspection report", "Other business"] }, at(-30, 19));
  const mo1 = await addMotion(council, m1.id, { text: "That the council renew the landscaping contract with Evergreen Landscaping for two years at the quoted rate.", movedBy: "H. Gill", secondedBy: "M. Okonkwo", threshold: "majority" });
  const mo2 = await addMotion(council, m1.id, { text: "That the move-in fee be increased from $150 to $250 effective January 1.", movedBy: "D. Laurent", secondedBy: "H. Gill", threshold: "three_quarters" });
  await setMeetingStatus(council, m1.id, "held");
  await decideMotion(council, mo1.id, { outcome: "count", votesFor: 5, votesAgainst: 1, votesAbstain: 0 });
  await decideMotion(council, mo2.id, { outcome: "count", votesFor: 3, votesAgainst: 3, votesAbstain: 0 });
  const d1 = await getMeeting(council, m1.id);
  const mins = ["Called to order at 7:02 PM. Agenda approved as circulated.", "Two quotes were reviewed. The incumbent's rate is unchanged from last year. Motion 1 carried.",
    "Discussion of costs of elevator bookings and wall protection. Motion 2 did not reach three-quarters and was defeated.", "The engineer's report recommends resealing two expansion joints next summer. Council asked management for a quote.", "None."];
  await saveMinutes(council, m1.id, { attendees: "H. Gill (president), M. Okonkwo, D. Laurent, S. Park, R. Mehta, J. Castillo; C. Reyes for management", quorum: true, minutes: "Adjourned at 8:20 PM. Next meeting as scheduled." },
    Object.fromEntries(d1.agenda.map((it, i) => [it.id, mins[i] ?? ""])));
  await addActionItem(admin, m1.id, { title: "Get a quote for resealing the parkade expansion joints", dueAt: null, assignedMembershipId: null }, at(21, 12));
  await approveMinutes(council, m1.id);
  motions += 2;

  // this month's meeting: coming up, two motions open, the council president has voted on one
  const m2 = await createMeeting(council, { propertyId: pch, kind: "council", title: "Council meeting, this month", scheduledAt: "", location: "Amenity room, level 2",
    agenda: ["Call to order and approval of the agenda", "Approval of last month's minutes", "2027 operating budget", "E-bike storage bylaw", "Other business"] }, at(6, 19));
  const mo3 = await addMotion(council, m2.id, { text: "That the council approve the 2027 operating budget as circulated.", movedBy: "S. Park", secondedBy: null, threshold: "majority" });
  await addMotion(council, m2.id, { text: "That bylaw 12 be amended to allow e-bikes to be stored in the level P1 bike room, subject to the fire safety rules attached.", movedBy: "R. Mehta", secondedBy: "S. Park", threshold: "three_quarters" });
  await castVote(council, mo3.id, "for");
  motions += 2;

  // the annual general meeting, further out
  await createMeeting(admin, { propertyId: pch, kind: "agm", title: "Annual general meeting", scheduledAt: "", location: "Community hall, 4850 Bennett St",
    agenda: ["Registration and proof of notice", "Approval of the previous AGM minutes", "President's report", "Insurance report", "Approval of the budget", "Election of council"] }, at(40, 18));

  // leases for the tenants of Kingsway Residences
  const today = todayIn(admin.principal.orgTimezone ?? "UTC");
  const thisMonth = monthStart(today);
  const tenants = await withContext({ orgId, system: true }, (tx) => tx
    .select({ unitId: units.id, number: units.number, residentId: unitOccupancies.residentId })
    .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId)).innerJoin(buildings, eq(buildings.id, units.buildingId))
    .where(and(eq(unitOccupancies.orgId, orgId), eq(buildings.propertyId, kwr), eq(unitOccupancies.isPrimary, true), sql`${unitOccupancies.endsOn} is null`))
    .orderBy(asc(units.number)).limit(36));
  let leaseCount = 0, charges = 0;
  for (const [i, t] of tenants.entries()) {
    // i = 0: a tenancy that ended last month. Others: started 2 to 11 months ago, most on a one-year term.
    const startedMonthsAgo = i === 0 ? 14 : 2 + (i * 3) % 10;
    const startsOn = addMonths(thisMonth, -startedMonthsAgo);
    const monthToMonth = i % 6 === 5;
    const endsOn = i === 0 ? null : monthToMonth ? null : addDays(addMonths(startsOn, 12), -1);
    const rent = 165_000 + ((i * 37) % 14) * 10_000;
    const l = await createLease(admin, { unitId: t.unitId, residentId: t.residentId, startsOn, endsOn, rent, deposit: rent / 2, dueDay: 1, notes: i === 3 ? "Asked about a parking stall for a second car." : null });
    leaseCount++;
    if (i === 0) await endLease(admin, l.id, addDays(thisMonth, -1));
    if (i === 7) await giveNotice(admin, l.id, addDays(today, 24));
    const d = await getLease(admin, l.id);
    charges += d.charges.length;
    for (const c of d.charges) {
      const current = c.period === thisMonth;
      const last = c.period === addMonths(thisMonth, -1);
      // most rent is in; a few tenants are late this month, one paid part, one is two months behind
      if (current && [4, 11, 19, 26].includes(i)) continue;
      if ((current || last) && i === 15) continue;
      if (current && i === 22) { await recordPayment(admin, c.id, { amount: Math.round(rent / 2), paidOn: c.dueOn <= today ? c.dueOn : today, note: "Part payment by e-transfer" }); continue; }
      await recordPayment(admin, c.id, { amount: c.amountCents - c.paidCents, paidOn: c.dueOn <= today ? c.dueOn : today, note: null });
    }
  }
  return { meetings: 3, motions, leases: leaseCount, charges };
}
