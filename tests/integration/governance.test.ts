// Iteration 13: strata governance (meetings, motions, votes, minutes) and leasing (leases, rent charges, payments).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ConflictError, ValidationError, type TenantCtx } from "@/server/modules/context";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { closeDb } from "@/server/db/client";
import {
  addActionItem, addAgendaItem, addMotion, approveMinutes, castVote, createMeeting, decideMotion, getMeeting, listMeetings, listOpenMotions, saveMinutes, setMeetingStatus,
} from "@/server/modules/meetings/service";
import { changeTerms, createLease, endLease, generateRentCharges, getLease, giveNotice, listLeases, recordPayment, withdrawNotice } from "@/server/modules/leases/service";
import { deleteResident } from "@/server/modules/people/service";
import { addMonths, monthStart, todayIn } from "@/lib/leasing";
import { asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.50", userAgent: "vitest", requestId: "governance" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const tag = `G${Math.random().toString(36).slice(2, 7)}`;
let admin: TenantCtx, pm: TenantCtx, council: TenantCtx, resident: TenantCtx, staff: TenantCtx, other: TenantCtx;
let org: string, pch: string, frt: string;
const soon = new Date(Date.now() + 5 * 86_400_000);
const meeting = (propertyId: string, title: string, agenda: string[] = []) => ({ propertyId, kind: "council" as const, title: `${tag} ${title}`, scheduledAt: "", location: null, agenda });
const motion = (text: string, threshold: "majority" | "three_quarters" | "unanimous" = "majority") => ({ text, movedBy: null, secondedBy: null, threshold });
const count = (f: number | null, a: number | null, ab: number | null) => ({ outcome: "count" as const, votesFor: f, votesAgainst: a, votesAbstain: ab });

beforeAll(async () => {
  [admin, pm, council, resident, staff] = await Promise.all(["admin", "pm", "council", "resident", "staff"].map((u) => ctxFor(`${u}@demo.test`)));
  other = await ctxFor("admin@northshore.test", "northshore-strata");
  org = await orgIdBySlug("pacific-properties");
  const props = await ownerPool.query("select code, id from properties where org_id = $1", [org]);
  pch = props.rows.find((r) => r.code === "PCH").id;
  frt = props.rows.find((r) => r.code === "FRT").id;
});
afterAll(async () => {
  await ownerPool.query("delete from tasks where source_type = 'meeting' and source_id in (select id from meetings where title like $1)", [`${tag}%`]);
  await ownerPool.query("delete from meetings where title like $1", [`${tag}%`]);
  await ownerPool.query("delete from leases where notes = $1", [tag]);
  await closeDb();
  await ownerPool.end();
});

describe("meetings: who can see and run them", () => {
  it("a council member schedules a meeting for their property; people outside it can't find it", async () => {
    const m = await createMeeting(council, meeting(pch, "Scope", ["Call to order", "Budget"]), soon);
    const d = await getMeeting(council, m.id);
    expect(d.agenda.map((a) => a.title)).toEqual(["Call to order", "Budget"]);
    expect(d.access).toMatchObject({ read: true, manage: true, vote: true, edit: true });
    expect((await listMeetings(council, { view: "upcoming" })).rows.some((r) => r.id === m.id)).toBe(true);
    // the property manager runs other properties: for them this meeting doesn't exist
    await expect(getMeeting(pm, m.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMeetings(pm, { view: "all" })).rows.some((r) => r.id === m.id)).toBe(false);
    await expect(addAgendaItem(pm, m.id, { title: "Sneak this in", notes: null })).rejects.toBeInstanceOf(NotFoundError);
    // residents and maintenance staff have no meetings at all
    await expect(listMeetings(resident, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMeeting(resident, m.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMeeting(staff, m.id)).rejects.toBeInstanceOf(NotFoundError);
    // another organization
    await expect(getMeeting(other, m.id)).rejects.toBeInstanceOf(NotFoundError);
    // and the council member can't schedule one for a property that isn't theirs
    await expect(createMeeting(council, meeting(frt, "Not mine"), soon)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the database refuses a meeting, motion or vote written into another organization", async () => {
    const otherOrg = await orgIdBySlug("northshore-strata");
    const otherProp = (await ownerPool.query("select id from properties where org_id = $1 limit 1", [otherOrg])).rows[0].id;
    const m = await createMeeting(council, meeting(pch, "RLS"), soon);
    const as = (sql: string, params: unknown[]) => asApp({ orgId: org, userId: council.principal.userId }, (q) => q(sql, params));
    await expect(as("insert into meetings (org_id, property_id, title, scheduled_at) values ($1, $2, 'x', now())", [otherOrg, otherProp])).rejects.toThrow(/row-level security/);
    await expect(as("insert into meeting_motions (org_id, meeting_id, number, text) values ($1, $2, 99, 'x')", [otherOrg, m.id])).rejects.toThrow(/row-level security/);
    // and from the other organization, ours are invisible
    const seen = await asApp({ orgId: otherOrg, userId: other.principal.userId }, (q) => q("select count(*)::int as n from meetings"));
    expect(seen.rows[0].n).toBe(0);
  });
});

describe("motions and votes", () => {
  it("council members vote once each and can change their mind until the result is recorded", async () => {
    const m = await createMeeting(council, meeting(pch, "Votes"), soon);
    const mo = await addMotion(council, m.id, motion("That the fence be repainted."));
    expect(mo.number).toBe(1);
    expect((await addMotion(council, m.id, motion("That the gate be replaced."))).number).toBe(2);
    await castVote(council, mo.id, "for");
    await castVote(council, mo.id, "against"); // changed, not counted twice
    await castVote(admin, mo.id, "for");
    let d = await getMeeting(council, m.id);
    expect(d.motions[0]).toMatchObject({ myVote: "against", votesCast: 2, castTally: { for: 1, against: 1, abstain: 0 }, status: "open" });
    expect((await listOpenMotions(council)).some((x) => x.id === mo.id)).toBe(true);
    await castVote(council, mo.id, "for");
    const decided = await decideMotion(council, mo.id, count(null, null, null)); // uses the votes cast
    expect(decided).toMatchObject({ status: "carried", votesFor: 2, votesAgainst: 0, votesAbstain: 0 });
    // closed means closed
    await expect(castVote(council, mo.id, "against")).rejects.toBeInstanceOf(ConflictError);
    await expect(decideMotion(council, mo.id, count(0, 5, 0))).rejects.toBeInstanceOf(ConflictError);
    d = await getMeeting(council, m.id);
    expect(d.motions[0].status).toBe("carried");
    // the audit log says who voted, never how
    const { rows } = await ownerPool.query("select after from audit_logs where action = 'meeting.vote' and entity_id = $1", [mo.id]);
    expect(rows.length).toBe(4);
    expect(JSON.stringify(rows)).not.toMatch(/"choice"|against|"for"/);
  });

  it("managers run meetings but don't vote; a hand count follows the motion's threshold", async () => {
    const m = await createMeeting(pm, meeting(frt, "Manager"), soon);
    const a = await addMotion(pm, m.id, motion("Needs three quarters, gets it.", "three_quarters"));
    const b = await addMotion(pm, m.id, motion("Needs three quarters, misses.", "three_quarters"));
    const c = await addMotion(pm, m.id, motion("Nobody voted."));
    const u = await addMotion(pm, m.id, motion("Unanimous with one against.", "unanimous"));
    await expect(castVote(pm, a.id, "for")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(castVote(council, a.id, "for")).rejects.toBeInstanceOf(NotFoundError); // council of another property
    expect(await decideMotion(pm, a.id, count(3, 1, 2))).toMatchObject({ status: "carried", votesAbstain: 2 });
    expect(await decideMotion(pm, b.id, count(5, 2, null))).toMatchObject({ status: "defeated", votesFor: 5, votesAgainst: 2, votesAbstain: 0 });
    await expect(decideMotion(pm, c.id, count(null, null, null))).rejects.toBeInstanceOf(ValidationError);
    expect(await decideMotion(pm, c.id, { outcome: "tabled", votesFor: null, votesAgainst: null, votesAbstain: null })).toMatchObject({ status: "tabled", votesFor: 0 });
    expect(await decideMotion(pm, u.id, count(6, 1, 0))).toMatchObject({ status: "defeated" });
  });
});

describe("minutes and the closed record", () => {
  it("minutes are approved only for a held meeting with no open motions, and then nothing changes", async () => {
    const m = await createMeeting(council, meeting(pch, "Minutes", ["Roof", "Garden"]), new Date(Date.now() - 86_400_000));
    const mo = await addMotion(council, m.id, motion("That the roof quote be accepted."));
    const d0 = await getMeeting(council, m.id);
    await saveMinutes(council, m.id, { attendees: "A, B, C", quorum: true, minutes: "Adjourned 8 PM." }, { [d0.agenda[0].id]: "Quote reviewed.", "not-an-item": "ignored" });
    await expect(approveMinutes(council, m.id)).rejects.toThrow(/held/);
    await setMeetingStatus(council, m.id, "held");
    await expect(approveMinutes(council, m.id)).rejects.toThrow(/1 motion is still open/);
    await decideMotion(council, mo.id, count(4, 0, 0));
    const task = await addActionItem(admin, m.id, { title: `${tag} sign the roof contract`, dueAt: null, assignedMembershipId: null }, null);
    await approveMinutes(council, m.id);
    const d = await getMeeting(council, m.id);
    expect(d.meeting.minutesApprovedAt).not.toBeNull();
    expect(d.agenda[0].minutes).toBe("Quote reviewed.");
    expect(d.agenda[1].minutes).toBeNull();
    expect(d.access).toMatchObject({ edit: false, locked: true });
    expect(d.actions.map((t) => t.id)).toEqual([task.id]);
    const { rows } = await ownerPool.query("select source, source_type, property_id from tasks where id = $1", [task.id]);
    expect(rows[0]).toEqual({ source: "meeting", source_type: "meeting", property_id: pch });
    for (const change of [
      () => saveMinutes(council, m.id, { attendees: "rewritten", quorum: false, minutes: null }, {}),
      () => addAgendaItem(council, m.id, { title: "Late item", notes: null }),
      () => addMotion(council, m.id, motion("A motion after the fact.")),
      () => setMeetingStatus(council, m.id, "cancelled"),
      () => approveMinutes(council, m.id),
    ]) await expect(change()).rejects.toBeInstanceOf(ConflictError);
    expect((await getMeeting(council, m.id)).meeting.attendees).toBe("A, B, C");
  });

  it("there must be minutes to approve, and cancelling a meeting withdraws its open motions", async () => {
    const empty = await createMeeting(council, meeting(pch, "Empty"), soon);
    await setMeetingStatus(council, empty.id, "held");
    await expect(approveMinutes(council, empty.id)).rejects.toThrow(/no minutes/);
    const m = await createMeeting(council, meeting(pch, "Cancelled"), soon);
    const mo = await addMotion(council, m.id, motion("That we meet again."));
    await castVote(council, mo.id, "for");
    await setMeetingStatus(council, m.id, "cancelled");
    const d = await getMeeting(council, m.id);
    expect(d.motions[0].status).toBe("withdrawn");
    await expect(castVote(council, mo.id, "against")).rejects.toBeInstanceOf(ConflictError);
    await expect(addMotion(council, m.id, motion("On a cancelled meeting."))).rejects.toBeInstanceOf(ConflictError);
    expect((await listOpenMotions(council)).some((x) => x.id === mo.id)).toBe(false);
  });
});

describe("leases and rent", () => {
  let unitId: string, residentId: string, leaseId: string;
  const today = todayIn("America/Vancouver");
  const thisMonth = monthStart(today);
  const base = () => ({ unitId, residentId, startsOn: addMonths(thisMonth, -2), endsOn: null as string | null, rent: 200_000, deposit: 100_000, dueDay: 1, notes: tag });

  beforeAll(async () => {
    const { rows } = await ownerPool.query(`select u.id as unit, o.resident_id as resident from units u join buildings b on b.id = u.building_id join unit_occupancies o on o.unit_id = u.id and o.ends_on is null and o.is_primary
      where b.property_id = $1 and not exists (select 1 from leases l where l.unit_id = u.id) order by u.number limit 1`, [frt]);
    unitId = rows[0].unit;
    residentId = rows[0].resident;
  });

  it("a lease charges rent for every month so far, and only people with that property can see it", async () => {
    const l = await createLease(pm, base());
    leaseId = l.id;
    const d = await getLease(pm, l.id);
    expect(d.charges.map((c) => c.period)).toEqual([thisMonth, addMonths(thisMonth, -1), addMonths(thisMonth, -2)]);
    expect(d.charges.every((c) => c.amountCents === 200_000 && c.paidCents === 0 && c.dueOn.endsWith("-01"))).toBe(true);
    expect(d.owingCents).toBe(600_000);
    expect(d.access.manage).toBe(true);
    // one lease in force per unit, and the tenant must live there
    await expect(createLease(pm, base())).rejects.toThrow(/already has a lease in force/);
    const stranger = (await ownerPool.query("select resident_id from unit_occupancies where org_id = $1 and unit_id <> $2 limit 1", [org, unitId])).rows[0].resident_id;
    await expect(createLease(admin, { ...base(), residentId: stranger })).rejects.toThrow(/recorded as living in this unit/);
    await expect(createLease(pm, { ...base(), endsOn: addMonths(thisMonth, -6) })).rejects.toBeInstanceOf(ValidationError);
    // the council member (another property), residents and maintenance staff can't see leases; nor can another organization
    await expect(getLease(council, l.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listLeases(resident, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLeases(staff, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getLease(other, l.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createLease(council, base())).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listLeases(pm, { view: "current" })).rows.some((r) => r.id === l.id)).toBe(true);
    const audit = await ownerPool.query("select after from audit_logs where action = 'lease.create' and entity_id = $1", [l.id]);
    expect(audit.rows[0].after).toMatchObject({ rentCents: 200_000, depositCents: 100_000 });
  });

  it("payments are recorded in part or in full, never more than is owing or dated in the future", async () => {
    const before = (await listLeases(pm, { view: "overdue" })).summary;
    const d = await getLease(pm, leaseId);
    const oldest = d.charges[d.charges.length - 1];
    await expect(recordPayment(council, oldest.id, { amount: 1000, paidOn: today, note: null })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPayment(pm, oldest.id, { amount: 200_001, paidOn: today, note: null })).rejects.toThrow(/more than/);
    await expect(recordPayment(pm, oldest.id, { amount: 1000, paidOn: "2999-01-01", note: null })).rejects.toThrow(/future/);
    const part = await recordPayment(pm, oldest.id, { amount: 50_000, paidOn: oldest.dueOn, note: "cheque 12" });
    expect(part.charge).toMatchObject({ paidCents: 50_000, paidOn: null });
    const full = await recordPayment(pm, oldest.id, { amount: 150_000, paidOn: today, note: "e-transfer" });
    expect(full.charge).toMatchObject({ paidCents: 200_000, paidOn: today, note: "cheque 12; e-transfer" });
    await expect(recordPayment(pm, oldest.id, { amount: 100, paidOn: today, note: null })).rejects.toBeInstanceOf(ConflictError);
    const after = (await listLeases(pm, { view: "overdue" })).summary;
    expect(before.overdueCents - after.overdueCents).toBe(200_000);
    expect((await getLease(pm, leaseId)).owingCents).toBe(400_000);
    // the database also refuses an overpayment written directly
    await expect(ownerPool.query("update rent_charges set paid_cents = amount_cents + 1 where id = $1", [oldest.id])).rejects.toThrow(/rent_charges_money_ck/);
  });

  it("a new rent applies to months not yet charged; the hourly job adds this month once", async () => {
    await changeTerms(pm, leaseId, { rent: 215_000, endsOn: null, notes: tag });
    expect((await getLease(pm, leaseId)).charges.every((c) => c.amountCents === 200_000)).toBe(true);
    await ownerPool.query("delete from rent_charges where lease_id = $1 and period = $2", [leaseId, thisMonth]);
    expect(await generateRentCharges()).toBeGreaterThanOrEqual(1);
    expect(await generateRentCharges()).toBe(0); // nothing to add the second time
    const d = await getLease(pm, leaseId);
    expect(d.charges[0]).toMatchObject({ period: thisMonth, amountCents: 215_000 });
    expect(d.charges).toHaveLength(3);
  });

  it("notice, withdrawal and ending; an ended lease frees the unit and keeps its record", async () => {
    await expect(endLease(pm, leaseId, "2999-01-01")).rejects.toThrow(/future date/);
    const n = await giveNotice(pm, leaseId, "2999-01-31");
    expect(n).toMatchObject({ status: "notice", moveOutOn: "2999-01-31", noticeGivenOn: today });
    expect((await listLeases(pm, { view: "ending" })).rows.some((r) => r.id === leaseId)).toBe(false); // not within 60 days
    await withdrawNotice(pm, leaseId);
    await expect(withdrawNotice(pm, leaseId)).rejects.toBeInstanceOf(ConflictError);
    // a tenant named on a lease can't simply be deleted: the records are kept
    await expect(deleteResident(admin, residentId)).rejects.toThrow(/named on a lease/);
    await endLease(pm, leaseId, today);
    const d = await getLease(pm, leaseId);
    expect(d.lease).toMatchObject({ status: "ended", moveOutOn: today });
    expect(d.owingCents).toBe(415_000); // still owing, still on the record
    for (const change of [() => endLease(pm, leaseId, today), () => giveNotice(pm, leaseId, today), () => changeTerms(pm, leaseId, { rent: 1, endsOn: null, notes: null })]) await expect(change()).rejects.toBeInstanceOf(ConflictError);
    expect(await generateRentCharges()).toBe(0); // ended leases are not charged again
    const next = await createLease(pm, { ...base(), startsOn: addMonths(thisMonth, 1) }); // starts next month: nothing charged yet
    expect((await getLease(pm, next.id))).toMatchObject({ upcoming: true, charges: [] });
  });

  it("the database keeps rent in one organization", async () => {
    const otherOrg = await orgIdBySlug("northshore-strata");
    const seen = await asApp({ orgId: otherOrg, userId: other.principal.userId }, (q) => q("select (select count(*) from leases)::int as l, (select count(*) from rent_charges)::int as c"));
    expect(seen.rows[0]).toEqual({ l: 0, c: 0 });
    await expect(asApp({ orgId: org, userId: pm.principal.userId }, (q) => q("insert into rent_charges (org_id, lease_id, period, amount_cents, due_on) values ($1, $2, '2020-01-01', 100, '2020-01-01')", [otherOrg, leaseId]))).rejects.toThrow(/row-level security/);
  });
});
