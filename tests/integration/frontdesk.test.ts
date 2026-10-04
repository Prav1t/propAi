import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelVisitor, checkInSchema, checkInVisitor, checkOutVisitor, denyVisitor, getVisitor, listVisitors, publicPass, regeneratePass, registerVisitor, resolvePass, visitorSchema,
} from "@/server/modules/visitors/service";
import { newPass } from "@/server/modules/visitors/pass";
import {
  addVehicle, getViolation, ingestDetection, issuePermit, listPermits, lookupPlate, myParking, permitSchema, removeVehicle, reportViolation, reviewViolation,
  vehicleSchema, violationSchema, warnViolation, resolveViolation,
} from "@/server/modules/parking/service";
import {
  acknowledgeHandoff, clockIn, createHandoff, createShifts, listHandoffs, listShifts, schedulableStaff, shiftSchema,
} from "@/server/modules/shifts/service";
import {
  assetSchema, createAsset, createPmSchedule, generatePreventiveMaintenance, getAsset, listAssets, pmSchema, setAssetStatus, statusSchema,
} from "@/server/modules/assets/service";
import { calendarEvents } from "@/server/modules/calendar/service";
import { createWorkOrder, createWoSchema, getWorkOrder, transitionWorkOrder } from "@/server/modules/maintenance/service";
import { drainOutbox } from "@/server/modules/notifications/service";
import { openFile } from "@/server/files/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb, withContext } from "@/server/db/client";
import { visitors } from "@/server/db/schema";
import { addDays } from "@/server/modules/assets/schedule";
import { zonedParts } from "@/lib/time";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.10", userAgent: "vitest", requestId: "t" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const TZ = "America/Vancouver";
const H = 3_600_000;
const today = () => zonedParts(new Date(), TZ).date;
// a visit window starting `offset` hours from now, `length` hours long, as form fields
function win(offset: number, length: number) {
  const a = zonedParts(new Date(Date.now() + offset * H), TZ);
  const b = zonedParts(new Date(Date.now() + (offset + length) * H), TZ);
  return { date: a.date, from: a.time, until: b.time, throughDate: b.date !== a.date ? b.date : "" };
}
const notifs = async (email: string, entityId: string) =>
  (await ownerPool.query("select kind, title, body from notifications where entity_id = $1 and user_id = (select id from users where email = $2)", [entityId, email])).rows as { kind: string; title: string; body: string | null }[];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const plate = () => `T${Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;

let pm: TenantCtx, admin: TenantCtx, emma: TenantCtx, noah: TenantCtx, concierge: TenantCtx, tech: TenantCtx, facility: TenantCtx, ns: TenantCtx;
const ids: Record<string, string> = {};

beforeAll(async () => {
  [pm, admin, emma, noah, concierge, tech, facility] = await Promise.all(["pm", "admin", "resident", "owner", "concierge", "staff", "facility"].map((u) => ctxFor(`${u}@demo.test`)));
  ns = await ctxFor("admin@northshore.test", "northshore-strata");
  for (const r of (await ownerPool.query("select code, id from properties")).rows) ids[r.code] = r.id;
  for (const r of (await ownerPool.query("select b.id, p.code, b.code bcode from buildings b join properties p on p.id = b.property_id")).rows) ids[`${r.code}-${r.bcode}`] = r.id;
  await drainOutbox();
});
afterAll(async () => {
  await closeDb();
  await ownerPool.end();
});

/* ───────────── visitors ───────────── */

describe("visitors and guest passes", () => {
  it("a resident invites a guest; the pass shows only what the desk needs", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Sophie Example-Tremblay", ...win(0.5, 3), plate: "ab-123c", needsParking: "on" }));
    expect(r.visitor.unitId).toBe([...emma.principal.unitIds][0]);
    expect(r.visitor.plate).toBe("AB123C");
    expect(r.passToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // only the hash is stored
    const stored = (await ownerPool.query("select pass_token_hash from visitors where id = $1", [r.visitor.id])).rows[0].pass_token_hash;
    expect(stored).not.toContain(r.passToken!);
    const pass = await publicPass(r.passToken!);
    expect(pass).toMatchObject({ guestName: "Sophie E.", buildingName: "Tower B", propertyName: "Fraser Towers", state: "valid" });
    expect(JSON.stringify(pass)).not.toMatch(/1204|Emma/);
    // the owner of another unit can't see it
    await expect(getVisitor(noah, r.visitor.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listVisitors(noah, { view: "all" })).rows.some((v) => v.id === r.visitor.id)).toBe(false);
  });

  it("residents can only invite to their own home, and can't check people in", async () => {
    const noahUnit = [...noah.principal.unitIds][0];
    await expect(registerVisitor(emma, visitorSchema.parse({ name: "Gate Crasher", ...win(1, 2), unitId: noahUnit }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(registerVisitor(emma, visitorSchema.parse({ name: "Walk In", ...win(0, 2), arrivingNow: "on" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(registerVisitor(emma, visitorSchema.parse({ name: "Long Stay", ...win(1, 24 * 20) }))).rejects.toThrow(/at most 14 days/);
    await expect(registerVisitor(emma, visitorSchema.parse({ name: "Past Guest", ...win(-5, 2) }))).rejects.toThrow(/already passed/);
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Some Guest", ...win(1, 2) }));
    await expect(checkInVisitor(emma, r.visitor.id, checkInSchema.parse({}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the desk scans the pass, checks the guest in (host notified), and checks them out (pass dead)", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Scan Guest", ...win(0.25, 3) }));
    const id = await resolvePass(concierge, `http://localhost:3000/pass/${r.passToken}`);
    expect(id).toBe(r.visitor.id);
    await checkInVisitor(concierge, id, checkInSchema.parse({}));
    await drainOutbox();
    expect((await notifs("resident@demo.test", id)).map((n) => n.title)).toContain("Scan Guest has arrived");
    expect((await listVisitors(concierge, { view: "on_site" })).rows.some((v) => v.id === id)).toBe(true);
    await checkOutVisitor(concierge, id);
    expect(await publicPass(r.passToken!)).toBeNull();
    await expect(resolvePass(concierge, r.passToken!)).rejects.toBeInstanceOf(ValidationError);
    await expect(checkOutVisitor(concierge, id)).rejects.toThrow(/isn't checked in/);
  });

  it("outside the pass window the desk must override with a reason, which is audited", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Early Bird", ...win(26, 2) }));
    await expect(checkInVisitor(concierge, r.visitor.id, checkInSchema.parse({}))).rejects.toThrow(/isn't valid yet/);
    await expect(checkInVisitor(concierge, r.visitor.id, checkInSchema.parse({ override: "on" }))).rejects.toThrow(/override/);
    await checkInVisitor(concierge, r.visitor.id, checkInSchema.parse({ override: "on", note: "Host came down to meet them" }));
    const audit = (await ownerPool.query("select after from audit_logs where entity_id = $1 and action = 'visitor.checked_in'", [r.visitor.id])).rows[0];
    expect(audit.after.override).toBe("Host came down to meet them");
  });

  it("visitor parking: a free visitor space is issued at check-in, never twice, and freed at check-out", async () => {
    const d = await getVisitor(concierge, (await registerVisitor(emma, visitorSchema.parse({ name: "Driver One", ...win(0.25, 3), plate: plate(), needsParking: "on" }))).visitor.id);
    const space = d.freeSpaces[0];
    expect(space).toBeTruthy();
    const second = await registerVisitor(noah, visitorSchema.parse({ name: "Driver Two", ...win(0.25, 3), plate: plate() }));
    const noPlate = await registerVisitor(noah, visitorSchema.parse({ name: "No Plate", ...win(0.25, 3) }));
    await expect(checkInVisitor(concierge, noPlate.visitor.id, checkInSchema.parse({ spaceId: space.id }))).rejects.toThrow(/licence plate/);
    const r1 = await checkInVisitor(concierge, d.visitor.id, checkInSchema.parse({ spaceId: space.id }));
    expect(r1.parking?.spaceCode).toBe(space.code);
    await expect(checkInVisitor(concierge, second.visitor.id, checkInSchema.parse({ spaceId: space.id }))).rejects.toThrow(/just taken/);
    // the failed attempt left the second visitor untouched
    expect((await getVisitor(concierge, second.visitor.id)).visitor.status).toBe("expected");
    await checkOutVisitor(concierge, d.visitor.id);
    const [permit] = (await ownerPool.query("select valid_until from parking_permits where visitor_id = $1", [d.visitor.id])).rows;
    expect(new Date(permit.valid_until).getTime()).toBeLessThanOrEqual(Date.now());
    await checkInVisitor(concierge, second.visitor.id, checkInSchema.parse({ spaceId: space.id }));
  });

  it("a new pass link replaces the old one; cancelled passes stop working", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Reissue Guest", ...win(3, 2) }));
    const again = await regeneratePass(emma, r.visitor.id);
    expect(await publicPass(r.passToken!)).toBeNull();
    expect((await publicPass(again.passToken))?.guestName).toBe("Reissue G.");
    await cancelVisitor(emma, r.visitor.id);
    expect(await publicPass(again.passToken)).toBeNull();
    await expect(regeneratePass(emma, r.visitor.id)).rejects.toThrow(/upcoming/);
  });

  it("passes are scoped: other buildings' desks and other organizations get nothing", async () => {
    // a Harbour Centre visit can't be scanned in at the Fraser Towers desk
    const hbc = await registerVisitor(admin, visitorSchema.parse({ name: "HBC Guest", ...win(0.5, 2), buildingId: ids["HBC-MAIN"], unitNumber: "101" }));
    await expect(resolvePass(concierge, hbc.passToken!)).rejects.toBeInstanceOf(ValidationError);
    await expect(getVisitor(concierge, hbc.visitor.id)).rejects.toBeInstanceOf(NotFoundError);
    // a Northshore pass resolves on its own public page only
    const nsv = await registerVisitor(ns, visitorSchema.parse({ name: "Lofts Guest", ...win(0.5, 2), unitNumber: "101", buildingId: (await ownerPool.query("select id from buildings where org_id = $1", [ns.principal.orgId])).rows[0].id }));
    expect((await publicPass(nsv.passToken!))?.propertyName).toBe("Lonsdale Quay Lofts");
    await expect(resolvePass(concierge, nsv.passToken!)).rejects.toBeInstanceOf(ValidationError);
    // junk never reaches the database; unknown well-formed tokens find nothing
    expect(await publicPass("not a token")).toBeNull();
    expect(await publicPass(newPass().token)).toBeNull();
  });

  it("the pass-token database policy exposes exactly one row and nothing else", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Policy Guest", ...win(1, 2) }));
    const { hash } = { hash: (await ownerPool.query("select pass_token_hash from visitors where id = $1", [r.visitor.id])).rows[0].pass_token_hash as string };
    const seen = await withContext({ passTokenHash: hash }, (tx) => tx.select({ id: visitors.id }).from(visitors));
    expect(seen.map((x) => x.id)).toEqual([r.visitor.id]);
    expect(await withContext({}, (tx) => tx.select({ id: visitors.id }).from(visitors))).toEqual([]);
  });

  it("walk-ins are checked in immediately; contractors link to a work order at the same property", async () => {
    const walk = await registerVisitor(concierge, visitorSchema.parse({ name: "Courier Walk-in", kind: "delivery", ...win(0, 1), buildingId: ids["FRT-B"], unitNumber: "1204", arrivingNow: "on" }));
    expect(walk.visitor.status).toBe("checked_in");
    expect(walk.passToken).toBeNull();
    await drainOutbox();
    expect((await notifs("resident@demo.test", walk.visitor.id)).length).toBe(1);
    const hbcWo = (await ownerPool.query("select number from work_orders where property_id = $1 limit 1", [ids.HBC])).rows[0].number;
    await expect(registerVisitor(concierge, visitorSchema.parse({ name: "Wrong Site Tech", kind: "contractor", ...win(1, 2), buildingId: ids["FRT-B"], workOrderNumber: String(hbcWo) }))).rejects.toThrow(/No work order/);
    await expect(registerVisitor(concierge, visitorSchema.parse({ name: "Lost Guest", ...win(1, 2), buildingId: ids["FRT-B"] }))).rejects.toThrow(/Which unit/);
  });

  it("turning someone away tells the host and kills the pass", async () => {
    const r = await registerVisitor(emma, visitorSchema.parse({ name: "Turned Away", ...win(0.25, 2) }));
    await denyVisitor(concierge, r.visitor.id, { reason: "Host didn't answer" });
    await drainOutbox();
    expect((await notifs("resident@demo.test", r.visitor.id))[0].title).toBe("Turned Away wasn't let in");
    expect(await publicPass(r.passToken!)).toBeNull();
  });
});

/* ───────────── parking ───────────── */

describe("parking", () => {
  it("residents register their own vehicles (unique plates, a per-unit limit); removing one revokes its permits", async () => {
    const p1 = plate();
    const v = await addVehicle(emma, vehicleSchema.parse({ plate: p1, make: "Kia" }));
    await expect(addVehicle(noah, vehicleSchema.parse({ plate: p1 }))).rejects.toThrow(/already registered/);
    await expect(addVehicle(emma, vehicleSchema.parse({ plate: plate(), unitId: [...noah.principal.unitIds][0] }))).rejects.toBeInstanceOf(ForbiddenError);
    const permit = await issuePermit(concierge, permitSchema.parse({ propertyId: ids.FRT, kind: "resident", plate: p1, buildingId: ids["FRT-B"], unitNumber: "1204", fromDate: today() }));
    expect(permit.vehicleId).toBe(v.id);
    expect((await removeVehicle(emma, v.id)).revoked).toBe(1);
    // the plate can be registered again once the old record is inactive
    await addVehicle(emma, vehicleSchema.parse({ plate: p1 }));
    // KX742M + p1 + two more reaches the limit of four
    await addVehicle(emma, vehicleSchema.parse({ plate: plate() }));
    await addVehicle(emma, vehicleSchema.parse({ plate: plate() }));
    await expect(addVehicle(emma, vehicleSchema.parse({ plate: plate() }))).rejects.toThrow(/up to 4 vehicles/);
    const mine = await myParking(emma);
    expect(mine.vehicles.some((x) => x.plate === p1)).toBe(true);
    expect(mine.spaces.map((s) => s.code)).toContain("P2-014");
  });

  it("a space can't carry two overlapping permits; visitor permits use visitor spaces", async () => {
    const base = { propertyId: ids.FRT, kind: "staff", fromDate: today(), untilDate: addDays(today(), 3) };
    await issuePermit(pm, permitSchema.parse({ ...base, plate: plate(), spaceCode: "EV-04" }));
    await expect(issuePermit(pm, permitSchema.parse({ ...base, plate: plate(), spaceCode: "ev-04" }))).rejects.toThrow(/already has a permit/);
    // back-to-back is fine
    await issuePermit(pm, permitSchema.parse({ ...base, plate: plate(), spaceCode: "EV-04", fromDate: addDays(today(), 3), fromTime: "23:59", untilDate: addDays(today(), 5) }));
    await expect(issuePermit(pm, permitSchema.parse({ ...base, kind: "visitor", plate: plate(), spaceCode: "P2-039" }))).rejects.toThrow(/visitor spaces/);
    await expect(issuePermit(pm, permitSchema.parse({ ...base, plate: plate(), spaceCode: "P2-031" }))).rejects.toThrow(/out of service/);
    await expect(issuePermit(emma, permitSchema.parse({ ...base, plate: plate() }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("plate lookup reports facts within the desk's scope", async () => {
    const r = await lookupPlate(concierge, "kx7 42m");
    expect(r.plate).toBe("KX742M");
    expect(r.vehicles[0].unitNumber).toBe("1204");
    expect(r.validPermitNow).toBe(true);
    // a Harbour Centre car is invisible to the Fraser Towers desk
    const hbcPlate = (await ownerPool.query("select plate from vehicles where property_id = $1 and active limit 1", [ids.HBC])).rows[0].plate;
    const other = await lookupPlate(concierge, hbcPlate);
    expect(other.vehicles).toEqual([]);
    expect(other.permits).toEqual([]);
    await expect(lookupPlate(emma, "KX742M")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports need human review before a notice; the resident sees only the notice", async () => {
    const photo = new File([PNG as BlobPart], "evidence.png", { type: "image/png" });
    const v = await reportViolation(concierge, violationSchema.parse({ propertyId: ids.FRT, plate: "WLM 805", kind: "wrong_space", spaceCode: "P1-020", description: "In someone else's space" }), [photo]);
    expect(v).toMatchObject({ status: "reported", unitId: [...noah.principal.unitIds][0], hadValidPermit: true, source: "staff" });
    // nothing reaches the resident before review
    await expect(getViolation(noah, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(warnViolation(pm, v.id, { message: "Please move your car from P1-020." })).rejects.toThrow(/Review and confirm/);
    await reviewViolation(pm, v.id, reviewSchema({ decision: "confirm" }));
    const w = await warnViolation(pm, v.id, { message: "Please move your car from P1-020 — it's assigned to another unit." });
    expect(w.notified).toBe(true);
    await drainOutbox();
    expect((await notifs("owner@demo.test", v.id))[0]).toMatchObject({ kind: "parking.notice", title: "Parking notice for WLM805" });
    const seen = await getViolation(noah, v.id);
    expect("evidence" in seen).toBe(false);
    expect(JSON.stringify(seen)).not.toMatch(/Aisha|reportedBy/);
    expect((await myParking(noah)).notices.some((n) => n.id === v.id)).toBe(true);
    await expect(getViolation(emma, v.id)).rejects.toBeInstanceOf(NotFoundError);
    // evidence is internal: staff can open it, the resident can't
    const evidence = (await ownerPool.query("select id, visibility from files where entity_id = $1", [v.id])).rows[0];
    expect(evidence.visibility).toBe("internal");
    await expect(openFile(noah, evidence.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await openFile(pm, evidence.id)).kind).toBe("bytes");
    await resolveViolation(pm, v.id, { resolution: "Moved." });
  });

  it("with second-person review on, reporters can't confirm their own reports", async () => {
    await ownerPool.query(`update organizations set settings = settings || '{"parkingSecondReviewer": true}' where id = $1`, [pm.principal.orgId]);
    try {
      const v = await reportViolation(concierge, violationSchema.parse({ propertyId: ids.FRT, plate: plate(), kind: "no_permit", location: "Visitor row" }));
      await expect(reviewViolation(concierge, v.id, reviewSchema({ decision: "confirm" }))).rejects.toThrow(/Another staff member/);
      await reviewViolation(pm, v.id, reviewSchema({ decision: "dismiss", note: "Guest was checked in." }));
      await expect(reviewViolation(pm, v.id, reviewSchema({ decision: "confirm" }))).rejects.toThrow(/already been reviewed/);
    } finally {
      await ownerPool.query(`update organizations set settings = settings - 'parkingSecondReviewer' where id = $1`, [pm.principal.orgId]);
    }
  });

  it("camera detections are labelled, go to parking staff for review, and never straight to residents", async () => {
    const v = await ingestDetection(pm.principal.orgId, { propertyId: ids.FRT, plate: "wlm-805", kind: "no_permit", confidence: 0.91, observedAt: new Date(), location: "P1 camera" });
    expect(v).toMatchObject({ source: "detection", status: "reported", confidence: "0.910", plate: "WLM805" });
    await drainOutbox();
    expect((await notifs("concierge@demo.test", v.id))[0].title).toMatch(/^Camera detection #\d+ to review: WLM805/);
    expect(await notifs("owner@demo.test", v.id)).toEqual([]);
    await expect(ingestDetection(pm.principal.orgId, { propertyId: ids.FRT, plate: "?", kind: "no_permit", confidence: 0.5, observedAt: new Date() })).rejects.toThrow(/Unreadable/);
    await expect(ingestDetection(pm.principal.orgId, { propertyId: ids.FRT, plate: "ABC123", kind: "no_permit", confidence: 1.5, observedAt: new Date() })).rejects.toThrow(/Confidence/);
  });

  it("permit lists are scoped to the desk's properties", async () => {
    const list = await listPermits(concierge, { view: "all", page: 1 });
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.rows.every((r) => r.propertyName === "Fraser Towers")).toBe(true);
  });
});

function reviewSchema(v: { decision: "confirm" | "dismiss"; note?: string }) {
  return { decision: v.decision, note: v.note ?? null };
}

/* ───────────── shifts, handoffs and on-call ───────────── */

describe("shifts and handoffs", () => {
  const nextWeek = () => addDays(today(), 21);
  it("managers schedule staff who cover the property; overlaps and outsiders are refused", async () => {
    const staff = await schedulableStaff(pm);
    const ben = staff.find((s) => s.name === "Ben Ortiz")!;
    const hannah = staff.find((s) => s.name === "Hannah Brooks")!;
    const r = await createShifts(pm, shiftSchema.parse({ membershipId: ben.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: nextWeek(), startTime: "07:00", endTime: "15:00", repeatWeeks: "2" }));
    expect(r.count).toBe(3);
    await expect(createShifts(pm, shiftSchema.parse({ membershipId: ben.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: nextWeek(), startTime: "14:00", endTime: "18:00" }))).rejects.toThrow(/overlaps/);
    await expect(createShifts(pm, shiftSchema.parse({ membershipId: hannah.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: nextWeek(), startTime: "07:00", endTime: "15:00" }))).rejects.toThrow(/isn't an active staff member at this property/);
    await expect(createShifts(pm, shiftSchema.parse({ membershipId: ben.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: addDays(today(), 30), startTime: "06:00", endTime: "23:30" }))).rejects.toThrow(/at most 16 hours/);
    await expect(createShifts(concierge, shiftSchema.parse({ membershipId: ben.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: addDays(today(), 31), startTime: "07:00", endTime: "15:00" }))).rejects.toBeInstanceOf(ForbiddenError);
    // an end before the start runs overnight
    const night = await createShifts(pm, shiftSchema.parse({ membershipId: ben.membershipId, propertyId: ids.FRT, position: "front_desk", startDate: addDays(today(), 40), startTime: "23:00", endTime: "07:00" }));
    expect(night.count).toBe(1);
  });

  it("schedules are visible within scope only; you can only clock in to your own shift", async () => {
    const from = new Date(Date.now() - 12 * H), to = new Date(Date.now() + 12 * H);
    const luis = await listShifts(tech, { from, to });
    expect(luis.every((s) => s.propertyName === "Harbour Centre")).toBe(true);
    const frt = await listShifts(concierge, { from, to });
    const others = frt.find((s) => s.name !== "Aisha Rahman")!;
    await expect(clockIn(concierge, others.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listShifts(emma, { from, to })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("emergencies with nobody assigned go to whoever is on call at the property", async () => {
    // make the on-call roster at Fraser Towers deterministic for this test
    await ownerPool.query("update shifts set status = 'cancelled' where property_id = $1 and starts_at <= now() + interval '2 hours' and ends_at > now() - interval '2 hours'", [ids.FRT]);
    const daniel = (await schedulableStaff(pm)).find((s) => s.name === "Daniel Okafor")!;
    const start = zonedParts(new Date(Date.now() - H), TZ);
    const end = zonedParts(new Date(Date.now() + 5 * H), TZ);
    await createShifts(pm, shiftSchema.parse({ membershipId: daniel.membershipId, propertyId: ids.FRT, position: "maintenance", startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time, onCall: "on" }));
    const r = await createWorkOrder(emma, createWoSchema.parse({ title: "Strange humming from the wall panel", category: "general", isEmergency: "on", unitId: [...emma.principal.unitIds][0] }));
    expect(r.workOrder.assignedMembershipId).toBe(daniel.membershipId);
    expect(r.workOrder.status).toBe("assigned");
    const d = await getWorkOrder(pm, r.workOrder.id);
    expect(d.timeline.some((t) => t.e.body?.includes("on call"))).toBe(true);
    // a property with nobody on call leaves it for the managers to assign
    const quiet = await createWorkOrder(admin, createWoSchema.parse({ title: "Strange humming in the clubhouse", category: "general", isEmergency: "on", buildingId: ids["PCH-N"] }));
    expect(quiet.workOrder.assignedMembershipId).toBeNull();
  });

  it("handoffs attach a factual snapshot limited to the author's access and are acknowledged by someone else", async () => {
    const h = await createHandoff(concierge, { propertyId: ids.FRT, buildingId: null, notes: "Courier for 1204 coming back at 9." });
    const snap = h.snapshot as Record<string, unknown>;
    expect(snap.packages).toBeTruthy();
    expect(snap.visitors).toBeTruthy();
    expect(snap.emergencies).toBeUndefined(); // the concierge can't read work orders
    await expect(acknowledgeHandoff(concierge, h.id)).rejects.toThrow(/next shift/);
    await acknowledgeHandoff(pm, h.id);
    await expect(acknowledgeHandoff(pm, h.id)).rejects.toThrow(/Already/);
    const list = await listHandoffs(pm, { propertyId: ids.FRT });
    expect(list[0]).toMatchObject({ id: h.id, acknowledgedByName: "Marcus Chen" });
    await expect(createHandoff(concierge, { propertyId: ids.HBC, buildingId: null, notes: "Not my building" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/* ───────────── assets, preventive maintenance, downtime ───────────── */

describe("assets and preventive maintenance", () => {
  const asset = (over: Record<string, string> = {}) => assetSchema.parse({ name: `Test pump ${Math.random().toString(36).slice(2, 6)}`, category: "plumbing", propertyId: ids.FRT, criticality: "high", ...over });

  it("facility managers manage assets in their portfolio only; tags are unique", async () => {
    const a = await createAsset(facility, asset({ tag: `T-${Date.now()}` }));
    await expect(createAsset(facility, asset({ propertyId: ids.HBC }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAsset(facility, asset({ tag: a.tag! }))).rejects.toThrow(/already in use/);
    await expect(createAsset(concierge, asset())).rejects.toBeInstanceOf(ForbiddenError);
    // maintenance staff read their building's assets but nothing elsewhere
    const luis = await listAssets(tech, {});
    expect(luis.rows.length).toBeGreaterThan(0);
    expect(luis.rows.every((r) => r.propertyName === "Harbour Centre")).toBe(true);
    await expect(getAsset(tech, a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAssets(emma, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a schedule opens one work order when its lead window starts, then moves on (idempotent)", async () => {
    const a = await createAsset(facility, asset());
    const s = await createPmSchedule(facility, a.id, pmSchema.parse({ title: "Monthly pump check", intervalUnit: "month", intervalCount: "1", nextDueOn: addDays(today(), 3), leadDays: "7", assignVendorId: (await ownerPool.query("select id from vendors where name like 'Blake%'")).rows[0].id }));
    await generatePreventiveMaintenance();
    await generatePreventiveMaintenance();
    const wos = (await ownerPool.query("select * from work_orders where source_id = $1", [s.id])).rows;
    expect(wos).toHaveLength(1);
    expect(wos[0]).toMatchObject({ source: "system", source_type: "pm_schedule", asset_id: a.id, status: "assigned", category: "plumbing" });
    const next = (await ownerPool.query("select next_due_on::text d, last_work_order_id from pm_schedules where id = $1", [s.id])).rows[0];
    expect(next.d > addDays(today(), 25)).toBe(true);
    expect(next.last_work_order_id).toBe(wos[0].id);
    await drainOutbox();
    expect((await notifs("facility@demo.test", wos[0].id)).length).toBeGreaterThan(0);
  });

  it("missed occurrences are skipped: one work order for the latest, the next due date is in the future", async () => {
    const a = await createAsset(facility, asset());
    const s = await createPmSchedule(facility, a.id, pmSchema.parse({ title: "Weekly check", intervalUnit: "week", intervalCount: "1", nextDueOn: addDays(today(), -60), leadDays: "0" }));
    await generatePreventiveMaintenance();
    expect((await ownerPool.query("select count(*)::int n from work_orders where source_id = $1", [s.id])).rows[0].n).toBe(1);
    const next = (await ownerPool.query("select next_due_on::text d from pm_schedules where id = $1", [s.id])).rows[0].d;
    expect(next > today()).toBe(true);
  });

  it("a breakdown work order takes the asset out of service until the job is done", async () => {
    const a = await createAsset(facility, asset({ buildingId: ids["FRT-B"] }));
    const r = await createWorkOrder(facility, createWoSchema.parse({ title: "Pump seized", category: "plumbing", assetId: a.id, assetDown: "on" }));
    expect(r.workOrder.buildingId).toBe(ids["FRT-B"]); // located at the asset
    let d = await getAsset(facility, a.id);
    expect(d.asset.status).toBe("down");
    expect(d.openDowntime?.workOrderId).toBe(r.workOrder.id);
    await drainOutbox();
    expect((await getWorkOrder(facility, r.workOrder.id)).asset?.id).toBe(a.id);
    await transitionWorkOrder(facility, r.workOrder.id, { to: "in_progress", note: null, cost: null, resolutionNotes: null });
    await transitionWorkOrder(facility, r.workOrder.id, { to: "completed", note: null, cost: "240.00", resolutionNotes: "Replaced the seal." });
    d = await getAsset(facility, a.id);
    expect(d.asset.status).toBe("operational");
    expect(d.openDowntime).toBeNull();
    expect(d.downtime[0].endedAt).not.toBeNull();
    // residents never see equipment details on their requests, and can't pick an asset
    const mine = await createWorkOrder(emma, createWoSchema.parse({ title: "Tap dripping", category: "plumbing", unitId: [...emma.principal.unitIds][0], assetId: a.id }));
    expect(mine.workOrder.assetId).toBeNull();
    await expect(createWorkOrder(pm, createWoSchema.parse({ title: "Wrong place", category: "plumbing", assetId: a.id, buildingId: ids["HBC-MAIN"] }))).rejects.toThrow(/different property/);
  });

  it("marking an asset out of service needs a reason and alerts asset managers", async () => {
    const a = await createAsset(pm, asset());
    expect(() => statusSchema.parse({ status: "down", note: "" })).toThrow(/Say what's wrong/);
    await setAssetStatus(pm, a.id, statusSchema.parse({ status: "down", note: "Bearing noise, shut off" }));
    await drainOutbox();
    expect((await notifs("facility@demo.test", a.id))[0]).toMatchObject({ kind: "asset.down", title: `${a.name} is out of service` });
    await setAssetStatus(pm, a.id, statusSchema.parse({ status: "operational" }));
    expect((await getAsset(pm, a.id)).downtime[0].endedAt).not.toBeNull();
  });

  it("the recurring-failure record for RTU-4 comes from real rows", async () => {
    const id = (await ownerPool.query("select id from assets where name = 'Rooftop unit RTU-4'")).rows[0].id;
    const d = await getAsset(pm, id);
    expect(d.stats.reactive90d).toBeGreaterThanOrEqual(6);
    expect(d.stats.downtime90d).toBeGreaterThan(0);
    expect(d.history.filter((w) => w.sourceType !== "pm_schedule").length).toBeGreaterThanOrEqual(6);
  });
});

/* ───────────── calendar ───────────── */

describe("unified calendar", () => {
  const range = { from: new Date(Date.now() - 2 * 86_400_000), to: new Date(Date.now() + 14 * 86_400_000) };
  it("residents see their own bookings and guests only", async () => {
    const ev = await calendarEvents(emma, range);
    expect(ev.some((e) => e.source === "shifts" || e.source === "pm" || e.source === "inspections")).toBe(false);
    // scheduled visits for their own requests are fine; nobody else's
    const own = new Set((await ownerPool.query("select id from work_orders where submitted_by_user_id = (select id from users where email = 'resident@demo.test') or resident_id = $1", [emma.principal.residentId])).rows.map((r) => r.id));
    expect(ev.filter((e) => e.source === "work").every((e) => own.has(e.id))).toBe(true);
    const guestIds = new Set((await listVisitors(emma, { view: "all", pageSize: 100 })).rows.map((v) => v.id));
    expect(ev.filter((e) => e.source === "visitors").every((e) => guestIds.has(e.id))).toBe(true);
  });
  it("the desk sees its building's visitors and shifts; managers see scheduled work and PM", async () => {
    const desk = await calendarEvents(concierge, range);
    expect(desk.some((e) => e.source === "shifts")).toBe(true);
    expect(desk.some((e) => e.source === "pm")).toBe(false);
    const hbcVisitors = new Set((await ownerPool.query("select id from visitors where property_id = $1", [ids.HBC])).rows.map((r) => r.id));
    expect(desk.filter((e) => e.source === "visitors").length).toBeGreaterThan(0);
    expect(desk.some((e) => e.source === "visitors" && hbcVisitors.has(e.id))).toBe(false);
    const mgr = await calendarEvents(facility, { ...range, sources: ["pm"] });
    expect(mgr.length).toBeGreaterThan(0);
    expect(mgr.every((e) => e.source === "pm" && e.allDay)).toBe(true);
  });
});
