import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addBlackout, amenitySchema, bookingSchema, cancelBooking, createAmenity, createBooking, decideBooking, getAmenity, getBooking, listAmenities, listBookings,
  reportDamage, updateBookingPayment,
} from "@/server/modules/amenities/service";
import { localParts, nextDate } from "@/server/modules/amenities/rules";
import { getPackage, listPackages, logPackage, packageReminders, packageSchema, releasePackages } from "@/server/modules/packages/service";
import {
  announcementFeed, announcementSchema, createAnnouncement, getAnnouncement, publishDueAnnouncements, unreadAnnouncementCount,
} from "@/server/modules/announcements/service";
import {
  createMessageTemplate, getThread, listThreads, messageBadgeCount, postMessage, startThread, templateSchema, updateThread,
} from "@/server/modules/messaging/service";
import { addDocumentVersion, createDocument, documentSchema, getDocument, listDocuments, setDocumentArchived } from "@/server/modules/documents/service";
import { drainOutbox } from "@/server/modules/notifications/service";
import { openFile } from "@/server/files/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.9", userAgent: "vitest", requestId: "t" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const TZ = "America/Vancouver";
const day = (offset: number) => nextDate(localParts(new Date(), TZ).date, offset);
const notifs = async (email: string, entityId: string) =>
  (await ownerPool.query("select kind, title, body from notifications where entity_id = $1 and user_id = (select id from users where email = $2)", [entityId, email])).rows as { kind: string; title: string; body: string | null }[];
const PDF = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });

let pm: TenantCtx, admin: TenantCtx, emma: TenantCtx, noah: TenantCtx, concierge: TenantCtx, tech: TenantCtx, council: TenantCtx, vendor: TenantCtx;
const ids: Record<string, string> = {};
let emmaUnit: string;

beforeAll(async () => {
  [pm, admin, emma, noah, concierge, tech, council, vendor] = await Promise.all(
    ["pm", "admin", "resident", "owner", "concierge", "staff", "council", "vendor"].map((u) => ctxFor(`${u}@demo.test`)),
  );
  for (const r of (await ownerPool.query("select code, id from properties")).rows) ids[r.code] = r.id;
  for (const r of (await ownerPool.query("select b.id, p.code, b.code bcode from buildings b join properties p on p.id = b.property_id")).rows) ids[`${r.code}-${r.bcode}`] = r.id;
  emmaUnit = [...emma.principal.unitIds][0];
  await drainOutbox();
});
afterAll(async () => {
  // amenities this file created stay out of other files' way ("the gym" must keep meaning the seeded one)
  await ownerPool.query("update amenities set active = false where name in ('Shared Gym')");
  await closeDb();
  await ownerPool.end();
});

/* ───────────── amenities & bookings ───────────── */

const amenity = (over: Record<string, string> = {}) => amenitySchema.parse({
  name: `Test Room ${Math.random().toString(36).slice(2, 6)}`, kind: "party_room", propertyId: ids.FRT, opensAt: "09:00", closesAt: "23:00",
  slotMinutes: "30", minDurationMinutes: "60", maxDurationMinutes: "240", minNoticeHours: "24", maxAdvanceDays: "60", maxConcurrent: "1",
  capacity: "20", cancellationHours: "48", requiresApproval: "", active: "on", eligibility: "all", fee: "", deposit: "", ...over,
});
const booking = (amenityId: string, date: string, start: string, minutes = 120, over: Record<string, string> = {}) =>
  bookingSchema.parse({ amenityId, date, start, durationMinutes: String(minutes), guests: "4", ...over });

describe("amenity bookings", () => {
  let room: string;
  beforeAll(async () => {
    room = (await createAmenity(pm, amenity({ name: "Instant Lounge" }))).id;
  });

  it("residents book instant amenities in their property; the booking is confirmed", async () => {
    const b = await createBooking(emma, booking(room, day(3), "18:00"));
    expect(b.status).toBe("approved");
    expect(b.unitId).toBe(emmaUnit);
    const local = localParts(b.startsAt, TZ);
    expect(local).toEqual({ date: day(3), minute: 18 * 60 });
  });

  it("an exclusive amenity can't be double-booked, but back-to-back is fine", async () => {
    await expect(createBooking(noah, booking(room, day(3), "19:00"))).rejects.toThrow(/already booked/);
    expect((await createBooking(noah, booking(room, day(3), "20:00"))).status).toBe("approved");
  });

  it("the database refuses overlapping live bookings even if the application check is bypassed", async () => {
    const { rows } = await ownerPool.query("select org_id, property_id, starts_at, ends_at from bookings where amenity_id = $1 and status = 'approved' limit 1", [room]);
    await expect(ownerPool.query(
      "insert into bookings (org_id, number, amenity_id, property_id, starts_at, ends_at, status, exclusive) values ($1, 999999, $2, $3, $4, $5, 'approved', true)",
      [rows[0].org_id, room, rows[0].property_id, rows[0].starts_at, rows[0].ends_at],
    )).rejects.toThrow(/bookings_no_overlap/);
  });

  it("concurrent requests for the same slot: exactly one wins", async () => {
    const results = await Promise.allSettled([
      createBooking(emma, booking(room, day(4), "12:00")),
      createBooking(noah, booking(room, day(4), "12:00")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
  });

  it("enforces notice, booking window, opening hours, slot steps and capacity for residents", async () => {
    await expect(createBooking(emma, booking(room, day(0), "22:00", 60))).rejects.toThrow(/hour|passed/);
    await expect(createBooking(emma, booking(room, day(70), "18:00"))).rejects.toThrow(/60 days ahead/);
    await expect(createBooking(emma, booking(room, day(5), "22:00", 120))).rejects.toThrow(/Open 09:00–23:00/);
    await expect(createBooking(emma, booking(room, day(5), "18:15"))).rejects.toThrow(/30-minute steps/);
    await expect(createBooking(emma, booking(room, day(5), "10:00", 120, { guests: "21" }))).rejects.toThrow(/At most 20 people/);
  });

  it("staff skip notice and limits but not conflicts or closures", async () => {
    const tomorrow = await createBooking(concierge, booking(room, day(1), "10:00", 60, { unitNumber: "1204", buildingId: ids["FRT-B"] }));
    expect(tomorrow.status).toBe("approved");
    expect(tomorrow.unitId).toBe(emmaUnit);
    // two towers have a unit 1204: staff must say which
    await expect(createBooking(concierge, booking(room, day(1), "12:00", 60, { unitNumber: "1204" }))).rejects.toThrow(/Tower A and Tower B/);
    await addBlackout(pm, room, { from: `${day(6)}T09:00`, to: `${day(6)}T23:00`, reason: "Floor refinishing" });
    await expect(createBooking(concierge, booking(room, day(6), "12:00"))).rejects.toThrow(/Floor refinishing/);
  });

  it("per-unit limits count bookings near the requested date", async () => {
    const limited = (await createAmenity(pm, amenity({ name: "Limited Room", limitCount: "1", limitPeriodDays: "14" }))).id;
    await createBooking(emma, booking(limited, day(8), "12:00"));
    await expect(createBooking(emma, booking(limited, day(10), "12:00"))).rejects.toThrow(/1 booking within 14 days/);
    expect((await createBooking(emma, booking(limited, day(30), "12:00"))).status).toBe("approved");
  });

  it("owner-only amenities: tenants/residents are refused, owners can book", async () => {
    const theatre = (await createAmenity(pm, amenity({ name: "Owners Theatre", eligibility: "owners" }))).id;
    await expect(createBooking(emma, booking(theatre, day(5), "19:00"))).rejects.toThrow(/Only owners/);
    expect((await createBooking(noah, booking(theatre, day(5), "19:00"))).status).toBe("approved");
  });

  it("shared amenities allow up to their concurrency", async () => {
    const gym = (await createAmenity(pm, amenity({ name: "Shared Gym", kind: "gym", maxConcurrent: "2", minNoticeHours: "0", minDurationMinutes: "30", opensAt: "06:00" }))).id;
    await createBooking(emma, booking(gym, day(2), "07:00", 60));
    await createBooking(noah, booking(gym, day(2), "07:00", 60));
    await expect(createBooking(concierge, booking(gym, day(2), "07:30", 30))).rejects.toThrow(/fully booked/);
  });

  describe("approval flow", () => {
    let partyRoom: string, requestId: string;
    beforeAll(async () => {
      partyRoom = (await createAmenity(pm, amenity({ name: "Approval Room", requiresApproval: "on", fee: "50", deposit: "250" }))).id;
    });

    it("requests wait for approval and alert the property's booking managers", async () => {
      const b = await createBooking(emma, booking(partyRoom, day(9), "18:00", 240));
      requestId = b.id;
      expect(b.status).toBe("requested");
      expect(b.feeCents).toBe(5000);
      expect(b.feeStatus).toBe("due");
      expect(b.depositStatus).toBe("due");
      await drainOutbox();
      expect((await notifs("concierge@demo.test", b.id)).map((n) => n.kind)).toContain("booking.request");
      expect((await notifs("pm@demo.test", b.id)).map((n) => n.kind)).toContain("booking.request");
      expect(await notifs("council@demo.test", b.id)).toHaveLength(0); // Pacific Heights only
      expect(await notifs("resident@demo.test", b.id)).toHaveLength(0); // no self-notification
      // the pending request holds the slot
      await expect(createBooking(noah, booking(partyRoom, day(9), "19:00"))).rejects.toThrow(/already booked/);
    });

    it("only booking managers decide; declining needs a reason; the resident is told", async () => {
      await expect(decideBooking(emma, requestId, { decision: "approve", note: null })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideBooking(pm, requestId, { decision: "decline", note: null })).rejects.toBeInstanceOf(ValidationError);
      const ok = await decideBooking(pm, requestId, { decision: "approve", note: "Enjoy!" });
      expect(ok.status).toBe("approved");
      await expect(decideBooking(pm, requestId, { decision: "decline", note: "x" })).rejects.toBeInstanceOf(ValidationError);
      await drainOutbox();
      expect((await notifs("resident@demo.test", requestId)).some((n) => n.kind === "booking.updated" && /approved/.test(n.title))).toBe(true);
    });

    it("payments are recorded manually and validated against the booking", async () => {
      const b = await updateBookingPayment(pm, requestId, { feeStatus: "paid", depositStatus: "held" });
      expect([b.feeStatus, b.depositStatus]).toEqual(["paid", "held"]);
      await expect(updateBookingPayment(emma, requestId, { feeStatus: "waived", depositStatus: "held" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("residents can't cancel inside the cut-off; staff cancel with a reason and the resident is notified", async () => {
      const soon = await createBooking(concierge, booking(partyRoom, day(1), "12:00", 60, { unitNumber: "1204", buildingId: ids["FRT-B"] }));
      await expect(cancelBooking(emma, soon.id, { reason: null })).rejects.toThrow(/48 hours/);
      await expect(cancelBooking(concierge, requestId, { reason: null })).rejects.toBeInstanceOf(ValidationError);
      const c = await cancelBooking(concierge, requestId, { reason: "Fire alarm testing that evening" });
      expect(c.status).toBe("cancelled");
      await drainOutbox();
      expect((await notifs("resident@demo.test", requestId)).some((n) => /cancelled by management/.test(n.title))).toBe(true);
      // the freed slot can be booked again
      expect((await createBooking(noah, booking(partyRoom, day(9), "19:00"))).status).toBe("requested");
    });

    it("damage after an event opens a linked repair work order and can withhold the deposit", async () => {
      const { rows } = await ownerPool.query(
        "insert into bookings (org_id, number, amenity_id, property_id, unit_id, starts_at, ends_at, status, exclusive, deposit_cents, deposit_status) select org_id, 888888, $1, property_id, $2, now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 'approved', true, 25000, 'held' from amenities where id = $1 returning id",
        [partyRoom, emmaUnit]);
      const b = await reportDamage(pm, rows[0].id, { notes: "Cracked glass table top", createWorkOrder: true, withholdDeposit: true });
      expect(b.depositStatus).toBe("withheld");
      const wo = await ownerPool.query("select title, source_type, source_id from work_orders where id = $1", [b.damageWorkOrderId]);
      expect(wo.rows[0]).toMatchObject({ source_type: "booking", source_id: rows[0].id });
    });
  });

  it("visibility: residents see only their unit's bookings; out-of-scope staff see nothing", async () => {
    const mine = await listBookings(emma, { view: "all", pageSize: 200 });
    const { rows } = await ownerPool.query("select count(*)::int n from bookings where id = any($1) and unit_id is distinct from $2 and booked_by_user_id is distinct from $3", [mine.rows.map((r) => r.id), emmaUnit, emma.principal.userId]);
    expect(rows[0].n).toBe(0);
    const noahs = (await listBookings(noah, { view: "all" })).rows[0];
    await expect(getBooking(emma, noahs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBooking(tech, noahs.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getBooking(concierge, noahs.id)).access.manage).toBe(true);
    // residents only see amenities of their own property
    const pchAmenity = (await ownerPool.query("select id from amenities where property_id = $1 limit 1", [ids.PCH])).rows[0].id;
    await expect(getAmenity(emma, pchAmenity)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAmenities(emma)).every(({ a }) => a.propertyId === ids.FRT)).toBe(true);
  });

  it("only amenity managers configure amenities, within their properties", async () => {
    await expect(createAmenity(emma, amenity())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAmenity(concierge, amenity())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAmenity(pm, amenity({ propertyId: ids.PCH }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/* ───────────── packages ───────────── */

describe("packages", () => {
  let pkgId: string, code: string;

  it("the front desk logs a package; the occupant is matched, the carrier detected and the resident notified with the code", async () => {
    const r = await logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-B"], unitNumber: "1204", trackingNumber: "1z999aa10123456784", size: "medium", shelfLocation: "C1" }),
      [file(PNG, "box.png", "image/png")]);
    pkgId = r.package.id;
    expect(r.package.residentId).toBe(emma.principal.residentId);
    expect(r.package.carrier).toBe("UPS");
    expect(r.package.trackingNumber).toBe("1Z999AA10123456784");
    expect(r.package.pickupCode).toMatch(/^\d{6}$/);
    code = r.package.pickupCode;
    await drainOutbox();
    const n = await notifs("resident@demo.test", pkgId);
    expect(n[0].kind).toBe("package.arrived");
    expect(n[0].body).toContain(code);
    expect(await notifs("owner@demo.test", pkgId)).toHaveLength(0);
  });

  it("scope: the Fraser Towers desk can't log Harbour Centre packages; residents can't log at all", async () => {
    await expect(logPackage(concierge, packageSchema.parse({ buildingId: ids["HBC-MAIN"], unitNumber: "305" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(logPackage(emma, packageSchema.parse({ buildingId: ids["FRT-B"], unitNumber: "1204" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-B"], unitNumber: "9999" }))).rejects.toThrow(/No unit 9999/);
  });

  it("residents see their own unit's packages with codes; staff lists hide codes", async () => {
    const mine = await listPackages(emma, { view: "waiting" });
    expect(mine.rows.find((k) => k.id === pkgId)?.pickupCode).toBe(code);
    const { rows } = await ownerPool.query("select count(*)::int n from packages where id = any($1) and unit_id <> $2", [mine.rows.map((r) => r.id), emmaUnit]);
    expect(rows[0].n).toBe(0);
    const desk = await listPackages(concierge, { view: "waiting", q: "1204" });
    expect(desk.rows.find((k) => k.id === pkgId)?.pickupCode).toBeNull();
    expect((await listPackages(concierge, { view: "waiting", q: code })).rows.map((r) => r.id)).toContain(pkgId); // find by code
    await expect(getPackage(noah, pkgId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("release checks the pickup code, stores the signature privately and tells the resident", async () => {
    const sig = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    await expect(releasePackages(concierge, [pkgId], { pickedUpByName: "Emma Tremblay", pickupCode: "000000" === code ? "111111" : "000000", signature: null })).rejects.toThrow(/doesn't match/);
    await expect(releasePackages(emma, [pkgId], { pickedUpByName: "Emma", pickupCode: code, signature: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await releasePackages(concierge, [pkgId], { pickedUpByName: "Emma Tremblay", pickupCode: code, signature: sig })).toBe(1);
    await expect(releasePackages(concierge, [pkgId], { pickedUpByName: "Emma Tremblay", pickupCode: null, signature: null })).rejects.toThrow(/already released/);
    const d = await getPackage(concierge, pkgId);
    expect(d.package.status).toBe("picked_up");
    expect(d.attachments.map((a) => a.visibility).sort()).toEqual(["internal", "public"]);
    const asResident = await getPackage(emma, pkgId);
    expect(asResident.attachments.map((a) => a.filename)).toEqual(["box.png"]);
    const signatureFile = d.attachments.find((a) => a.visibility === "internal")!;
    await expect(openFile(emma, signatureFile.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await openFile(emma, asResident.attachments[0].id)).kind).toBe("bytes");
    await drainOutbox();
    expect((await notifs("resident@demo.test", pkgId)).some((n) => /picked up/.test(n.title))).toBe(true);
  });

  it("bulk release and disguised photos", async () => {
    const a = await logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-A"], unitNumber: "805" }));
    const b = await logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-A"], unitNumber: "805", perishable: "on" }));
    expect(await releasePackages(concierge, [a.package.id, b.package.id], { pickedUpByName: "Noah Williams", pickupCode: null, signature: null })).toBe(2);
    await expect(logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-A"], unitNumber: "805" }), [file(new TextEncoder().encode("<svg onload=alert(1)>"), "x.png", "image/png")])).rejects.toBeInstanceOf(ValidationError);
  });

  it("waiting packages get one reminder (perishables after a day)", async () => {
    const k = await logPackage(concierge, packageSchema.parse({ buildingId: ids["FRT-B"], unitNumber: "1204", perishable: "on" }));
    await ownerPool.query("update packages set received_at = now() - interval '30 hours' where id = $1", [k.package.id]);
    await packageReminders();
    await packageReminders();
    const ev = await ownerPool.query("select count(*)::int n from outbox_events where type = 'package.reminder' and payload->>'packageId' = $1", [k.package.id]);
    expect(ev.rows[0].n).toBe(1);
  });
});

/* ───────────── announcements ───────────── */

const ann = (over: Record<string, string> = {}) => announcementSchema.parse({ title: "Test notice", body: "Hello {{property}}", category: "general", propertyId: ids.FRT, audience: "everyone", notify: "on", mode: "publish", ...over });

describe("announcements", () => {
  it("building-targeted announcements reach only that building; variables are filled in", async () => {
    const a = await createAnnouncement(pm, ann({ title: "Tower B water test" }), [ids["FRT-B"]]);
    expect(a.body).toBe("Hello Fraser Towers");
    expect((await announcementFeed(emma)).map((x) => x.id)).toContain(a.id);
    expect((await announcementFeed(noah)).map((x) => x.id)).not.toContain(a.id); // Tower A
    await expect(getAnnouncement(noah, a.id)).rejects.toBeInstanceOf(NotFoundError);
    await drainOutbox();
    expect((await notifs("resident@demo.test", a.id)).map((n) => n.kind)).toEqual(["announcement.posted"]);
    expect(await notifs("owner@demo.test", a.id)).toHaveLength(0);
    expect(await notifs("pm@demo.test", a.id)).toHaveLength(0); // author
  });

  it("read tracking feeds the unread count and the manager's stats", async () => {
    const a = await createAnnouncement(pm, ann({ title: "Read me" }), []);
    const before = await unreadAnnouncementCount(emma);
    await getAnnouncement(emma, a.id);
    expect(await unreadAnnouncementCount(emma)).toBe(before - 1);
    const stats = (await getAnnouncement(pm, a.id)).stats!;
    expect(stats.reads).toBe(1);
    expect(stats.audience).toBeGreaterThanOrEqual(2); // Emma and Noah have accounts at Fraser Towers
  });

  it("scheduled announcements publish when due, then notify", async () => {
    const at = `${day(2)}T09:00`;
    const a = await createAnnouncement(pm, ann({ title: "Scheduled notice", mode: "schedule", publishAt: at }), []);
    expect(a.status).toBe("scheduled");
    expect((await announcementFeed(emma)).map((x) => x.id)).not.toContain(a.id);
    await ownerPool.query("update announcements set publish_at = now() - interval '1 minute' where id = $1", [a.id]);
    expect(await publishDueAnnouncements()).toBeGreaterThanOrEqual(1);
    expect((await announcementFeed(emma)).map((x) => x.id)).toContain(a.id);
    await drainOutbox();
    expect(await notifs("resident@demo.test", a.id)).toHaveLength(1);
  });

  it("audiences, scope and template rules are enforced", async () => {
    const staffOnly = await createAnnouncement(pm, ann({ title: "Staff only", audience: "staff" }), []);
    expect((await announcementFeed(emma)).map((x) => x.id)).not.toContain(staffOnly.id);
    expect((await announcementFeed(concierge)).map((x) => x.id)).toContain(staffOnly.id);
    await expect(createAnnouncement(pm, ann({ propertyId: "" }), [])).rejects.toThrow(/one of your properties/);
    await expect(createAnnouncement(pm, ann({ propertyId: ids.PCH }), [])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAnnouncement(pm, ann({ body: "Hi {{resident_name}}" }), [])).rejects.toThrow(/\{\{property\}\}/);
    await expect(createAnnouncement(emma, ann(), [])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAnnouncement(pm, ann(), [ids["HBC-MAIN"]])).rejects.toBeInstanceOf(ValidationError);
    const orgWide = await createAnnouncement(admin, ann({ propertyId: "", title: "Org-wide" }), []);
    expect((await announcementFeed(emma)).map((x) => x.id)).toContain(orgWide.id);
  });

  it("expired announcements disappear from the feed", async () => {
    const a = await createAnnouncement(pm, ann({ title: "Expiring" }), []);
    await ownerPool.query("update announcements set expires_at = now() - interval '1 minute' where id = $1", [a.id]);
    expect((await announcementFeed(emma)).map((x) => x.id)).not.toContain(a.id);
  });
});

/* ───────────── messaging ───────────── */

describe("resident messaging", () => {
  let threadId: string;

  it("a resident writes to management; staff who handle the property are notified", async () => {
    const t = await startThread(emma, { subject: "Bike room access", category: "general", body: "My fob doesn't open the bike room.", unitId: null, residentId: null });
    threadId = t.id;
    expect(t.residentUserId).toBe(emma.principal.userId);
    await drainOutbox();
    expect((await notifs("concierge@demo.test", t.id)).map((n) => n.kind)).toEqual(["message.inbox"]);
    expect(await notifs("council@demo.test", t.id)).toHaveLength(0);
    expect(await notifs("staff@demo.test", t.id)).toHaveLength(0); // no message.manage
  });

  it("staff reply (the resident is notified); internal notes stay internal", async () => {
    await postMessage(concierge, threadId, { body: "INTERNAL: fob list shows it expired", internal: true });
    await postMessage(concierge, threadId, { body: "We've re-enabled your fob for the bike room.", internal: false });
    await expect(postMessage(emma, threadId, { body: "sneaky", internal: true })).rejects.toBeInstanceOf(ForbiddenError);
    const asEmma = await getThread(emma, threadId);
    expect(asEmma.messages.map((m) => m.m.body).join("|")).not.toContain("INTERNAL");
    expect(asEmma.templates).toEqual([]);
    await drainOutbox();
    const n = await notifs("resident@demo.test", threadId);
    expect(n).toHaveLength(1);
    expect(n[0].kind).toBe("message.received");
  });

  it("privacy: other residents, other properties and non-handlers can't read the conversation", async () => {
    await expect(getThread(noah, threadId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getThread(council, threadId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getThread(vendor, threadId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listThreads(tech, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listThreads(noah, { view: "all" })).rows.map((r) => r.id)).not.toContain(threadId);
  });

  it("closing, reopening by the resident, and badge counts", async () => {
    await updateThread(concierge, threadId, { status: "closed" });
    const before = await messageBadgeCount(concierge);
    await postMessage(emma, threadId, { body: "It stopped working again.", internal: false });
    expect((await getThread(concierge, threadId)).thread.status).toBe("open");
    expect(await messageBadgeCount(concierge)).toBe(before + 1);
    await expect(updateThread(emma, threadId, { status: "closed" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("templates render per conversation; unknown variables are rejected", async () => {
    await createMessageTemplate(pm, templateSchema.parse({ name: "Hello", propertyId: ids.FRT, body: "Hi {{resident_first_name}} in {{unit}}, {{staff_name}} here." }));
    expect(() => templateSchema.parse({ name: "Bad", propertyId: "", body: "Your balance is {{balance}}" })).toThrow();
    await expect(createMessageTemplate(pm, templateSchema.parse({ name: "Org", propertyId: "", body: "Hello {{org_name}}" }))).rejects.toBeInstanceOf(ForbiddenError);
    const t = (await getThread(concierge, threadId)).templates.find((x) => x.name === "Hello")!;
    expect(t.text).toBe("Hi Emma in 1204, Aisha Rahman here.");
  });

  it("staff can start conversations only with app users they manage", async () => {
    const noAccount = (await ownerPool.query("select r.id from residents r join unit_occupancies o on o.resident_id = r.id join units u on u.id = o.unit_id where u.property_id = $1 and r.user_id is null and o.ends_on is null limit 1", [ids.FRT])).rows[0].id;
    await expect(startThread(concierge, { subject: "Hello", category: "general", body: "Hi", unitId: null, residentId: noAccount })).rejects.toThrow(/hasn't joined/);
    const t = await startThread(concierge, { subject: "Your parking stall", category: "parking", body: "Please move your car on Tuesday.", unitId: null, residentId: noah.principal.residentId });
    expect(t.residentUserId).toBe(noah.principal.userId);
    expect(t.lastFromStaff).toBe(true);
    const hbcResident = (await ownerPool.query("select r.id from residents r join unit_occupancies o on o.resident_id = r.id join units u on u.id = o.unit_id where u.property_id = $1 and o.ends_on is null limit 1", [ids.HBC])).rows[0].id;
    await ownerPool.query("update residents set user_id = (select id from users where email = 'admin@demo.test') where id = $1 and user_id is null", [hbcResident]);
    await expect(startThread(concierge, { subject: "x", category: "general", body: "x", unitId: null, residentId: hbcResident })).rejects.toBeInstanceOf(ForbiddenError);
    await ownerPool.query("update residents set user_id = null where id = $1", [hbcResident]);
  });
});

/* ───────────── documents ───────────── */

const docInput = (over: Record<string, string> = {}) => documentSchema.parse({ title: "Test doc", category: "rules", audience: "residents", propertyId: ids.FRT, ...over });

describe("documents", () => {
  it("residents see documents for their audience and place only", async () => {
    const titles = async (c: TenantCtx) => (await listDocuments(c, { pageSize: 100 })).rows.map((r) => r.title);
    const e = await titles(emma), n = await titles(noah);
    expect(e).toEqual(expect.arrayContaining(["Fraser Towers house rules", "Tenancy agreement — Unit 1204", "Resident privacy notice"]));
    expect(e).not.toEqual(expect.arrayContaining(["Strata bylaws (consolidated)"]));
    expect(e).not.toContain("Property insurance certificate");
    expect(e).not.toContain("Harbour Centre house rules");
    expect(n).toContain("Strata bylaws (consolidated)"); // owners
    expect(n).not.toContain("Tenancy agreement — Unit 1204");
    expect(await titles(pm)).toContain("Property insurance certificate");
    expect(await titles(vendor).catch((x) => x)).toBeInstanceOf(ForbiddenError);
  });

  it("uploads are checked by content; new versions hide the old file from residents", async () => {
    await expect(createDocument(pm, docInput(), file(new TextEncoder().encode("<html><script>x</script></html>"), "rules.pdf", "application/pdf"))).rejects.toBeInstanceOf(ValidationError);
    const d = await createDocument(pm, docInput({ title: "Pet policy" }), file(PDF("v1"), "pets.pdf", "application/pdf"));
    const v1 = (await getDocument(pm, d.id)).versions[0].file.id;
    expect((await openFile(emma, v1)).kind).toBe("bytes");
    expect(await addDocumentVersion(pm, d.id, file(PDF("v2"), "pets-2.pdf", "application/pdf"), "Dogs over 25 kg need approval")).toBe(2);
    await expect(openFile(emma, v1)).rejects.toBeInstanceOf(NotFoundError);
    const asEmma = await getDocument(emma, d.id);
    expect(asEmma.versions.map((v) => v.v.version)).toEqual([2]);
    expect((await openFile(emma, asEmma.versions[0].file.id)).kind).toBe("bytes");
    expect((await getDocument(pm, d.id)).versions).toHaveLength(2);
    expect((await listDocuments(emma, { q: "pet" })).rows.map((r) => r.id)).toContain(d.id);
    const audit = await ownerPool.query("select count(*)::int n from audit_logs where action = 'document.viewed' and entity_id = $1", [d.id]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("archiving hides a document from residents; managers are scoped", async () => {
    const d = await createDocument(pm, docInput({ title: "Old notice", category: "notice" }), file(PDF("old"), "old.pdf", "application/pdf"));
    await setDocumentArchived(pm, d.id, true);
    await expect(getDocument(emma, d.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setDocumentArchived(emma, d.id, false)).rejects.toThrow();
    await expect(createDocument(pm, docInput({ propertyId: "" }), file(PDF("x"), "x.pdf", "application/pdf"))).rejects.toThrow(/organization-wide role/);
    await expect(createDocument(pm, docInput({ propertyId: ids.PCH }), file(PDF("x"), "x.pdf", "application/pdf"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDocument(emma, docInput(), file(PDF("x"), "x.pdf", "application/pdf"))).rejects.toBeInstanceOf(ForbiddenError);
    const unitDoc = await createDocument(pm, docInput({ title: "Unit 805 notice", buildingId: ids["FRT-A"], unitNumber: "805" }), file(PDF("u"), "u.pdf", "application/pdf"));
    await expect(getDocument(emma, unitDoc.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getDocument(noah, unitDoc.id)).document.id).toBe(unitDoc.id);
  });

  it("other organizations can't reach documents or their files", async () => {
    const ns = await ctxFor("admin@demo.test", "northshore-strata");
    const d = (await listDocuments(pm, { pageSize: 1 })).rows[0];
    await expect(getDocument(ns, d.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openFile(ns, d.fileId!)).rejects.toBeInstanceOf(NotFoundError);
  });
});
