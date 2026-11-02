// Iteration 12: saved views, recently viewed records, bulk changes, offline-draft idempotency and web push.
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- http_ece ships without types (it comes with web-push)
const ece = require("http_ece") as { decrypt: (buf: Buffer, p: Record<string, unknown>) => Buffer };
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { NotFoundError } from "@/server/authz/authorize";
import { closeDb } from "@/server/db/client";
import { deleteView, forgetRecent, listRecent, listSavedViews, recordView, saveView } from "@/server/modules/views/service";
import { sanitizeViewQuery } from "@/lib/views";
import { bulkAssignOptions, bulkUpdateWorkOrders } from "@/server/modules/maintenance/bulk";
import { createWorkOrder, transitionWorkOrder } from "@/server/modules/maintenance/service";
import { checkEndpoint, myPushDevices, sendPushToUsers, subscribePush, unsubscribePush } from "@/server/push/service";
import { drainOutbox } from "@/server/modules/notifications/service";
import { exportPerson, erasePerson, openExport } from "@/server/privacy/service";
import { withContext } from "@/server/db/client";
import { asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.30", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 vitest", requestId: "ux" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

let pm: TenantCtx, admin: TenantCtx, staff: TenantCtx, resident: TenantCtx, vendor: TenantCtx;
let org: string;
const made: string[] = []; // work orders created here
const tag = `UX-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  [pm, admin, staff, resident, vendor] = await Promise.all(["pm", "admin", "staff", "resident", "vendor"].map((u) => ctxFor(`${u}@demo.test`)));
  org = await orgIdBySlug("pacific-properties");
});
afterAll(async () => {
  if (made.length) await ownerPool.query("delete from work_orders where id = any($1)", [made]);
  await ownerPool.query("delete from saved_views where name like $1", [`${tag}%`]);
  await ownerPool.query("delete from push_subscriptions where endpoint like 'http://127.0.0.1:%'");
  await closeDb();
  await ownerPool.end();
});

const building = async (code: string) => (await ownerPool.query("select b.id from buildings b join properties p on p.id = b.property_id where p.code = $1 limit 1", [code])).rows[0].id as string;
async function newWo(ctx: TenantCtx, title: string, propertyCode = "FRT", extra: { clientRef?: string } = {}) {
  const r = await createWorkOrder(ctx, { title: `${title} ${tag}`, description: "", category: "cleaning", priority: "low", isEmergency: false, unitId: null, buildingId: await building(propertyCode), unitNumber: null, propertyId: null, area: "Hall", permissionToEnter: false, entryNotes: null }, extra);
  if (!r.duplicate) made.push(r.workOrder.id);
  return r;
}

describe("saved views", () => {
  it("keeps only list filters: no paging, no odd keys, stable order", () => {
    expect(sanitizeViewQuery("?view=overdue&page=3&property=abc&Bad=1&q=%20leak%20&q=second")).toBe("property=abc&q=leak&view=overdue");
    expect(sanitizeViewQuery("x=" + "a".repeat(300))).toBe("");
    expect(sanitizeViewQuery("")).toBe("");
  });

  it("saves, lists, replaces by name and deletes a person's own views", async () => {
    const a = await saveView(pm, "maintenance", `${tag} overdue`, "view=overdue&category=plumbing&page=2");
    expect(a.replaced).toBe(false);
    let views = await listSavedViews(pm, "maintenance");
    expect(views.find((v) => v.id === a.id)?.query).toBe("category=plumbing&view=overdue");
    const again = await saveView(pm, "maintenance", `${tag} OVERDUE`, "view=overdue&category=electrical");
    expect(again).toEqual({ id: a.id, replaced: true }); // same name, any case: replaced, not duplicated
    views = await listSavedViews(pm, "maintenance");
    expect(views.filter((v) => v.name.toLowerCase() === `${tag} overdue`.toLowerCase())).toHaveLength(1);
    await deleteView(pm, a.id);
    expect((await listSavedViews(pm, "maintenance")).some((v) => v.id === a.id)).toBe(false);
  });

  it("refuses empty filters, unknown pages and long names", async () => {
    await expect(saveView(pm, "maintenance", `${tag} x`, "page=4")).rejects.toBeInstanceOf(ValidationError);
    await expect(saveView(pm, "settings", `${tag} x`, "view=all")).rejects.toBeInstanceOf(ValidationError);
    await expect(saveView(pm, "tasks", "x".repeat(61), "view=all")).rejects.toBeInstanceOf(ValidationError);
  });

  it("are private to their owner, even inside the organization", async () => {
    const v = await saveView(pm, "tasks", `${tag} mine`, "view=mine");
    expect((await listSavedViews(admin, "tasks")).some((x) => x.id === v.id)).toBe(false);
    await expect(deleteView(admin, v.id)).rejects.toBeInstanceOf(NotFoundError);
    // at the database: the admin's context can't read or plant rows for someone else
    const pmId = pm.principal.userId, adminId = admin.principal.userId;
    await asApp({ orgId: org, userId: adminId }, async (q) => expect((await q("select count(*)::int n from saved_views where user_id = $1", [pmId])).rows[0].n).toBe(0));
    await expect(asApp({ orgId: org, userId: adminId }, (q) => q("insert into saved_views (org_id, user_id, page, name, query) values ($1, $2, 'tasks', 'planted', 'view=all')", [org, pmId]))).rejects.toThrow(/row-level security/);
    await deleteView(pm, v.id);
  });
});

describe("recently viewed records", () => {
  it("records, orders, keeps the latest 20 and hides kinds the person can no longer open", async () => {
    const ids = Array.from({ length: 22 }, () => crypto.randomUUID());
    for (const [i, id] of ids.entries()) await recordView(staff, { type: "work_order", id, title: `Job ${i}`, href: `/o/pacific-properties/maintenance/${id}` });
    const r = await listRecent(staff, 30);
    expect(r).toHaveLength(20);
    expect(r[0].title).toBe("Job 21");
    expect(r.at(-1)?.title).toBe("Job 2"); // the two oldest were trimmed
    // seeing one again moves it to the top without duplicating it
    await recordView(staff, { type: "work_order", id: ids[5], title: "Job 5 (renamed)", href: `/o/pacific-properties/maintenance/${ids[5]}` });
    const again = await listRecent(staff, 30);
    expect(again[0]).toMatchObject({ id: ids[5], title: "Job 5 (renamed)" });
    expect(again.filter((x) => x.id === ids[5])).toHaveLength(1);
    // a resident record viewed by someone without resident.read access never shows for them
    await recordView(staff, { type: "resident", id: crypto.randomUUID(), title: "Someone", href: "/o/pacific-properties/residents/x" });
    expect((await listRecent(staff, 30)).some((x) => x.type === "resident")).toBe(staff.principal.permissions.has("resident.read"));
    await ownerPool.query("delete from recent_views where user_id = $1", [staff.principal.userId]);
  });

  it("an erased or deleted record leaves everyone's recents", async () => {
    const rid = crypto.randomUUID();
    await recordView(pm, { type: "resident", id: rid, title: "Former neighbour", href: `/o/pacific-properties/residents/${rid}` });
    await recordView(admin, { type: "resident", id: rid, title: "Former neighbour", href: `/o/pacific-properties/residents/${rid}` });
    await withContext({ orgId: org, system: true }, (tx) => forgetRecent(tx, org, "resident", rid));
    const { rows } = await ownerPool.query("select count(*)::int n from recent_views where entity_id = $1", [rid]);
    expect(rows[0].n).toBe(0);
  });

  it("ignores unknown kinds and links outside an organization", async () => {
    await recordView(pm, { type: "nonsense" as "task", id: crypto.randomUUID(), title: "x", href: "/o/x" });
    await recordView(pm, { type: "task", id: crypto.randomUUID(), title: "phish", href: "https://evil.example/" });
    const { rows } = await ownerPool.query("select count(*)::int n from recent_views where user_id = $1 and (entity_type = 'nonsense' or href not like '/o/%')", [pm.principal.userId]);
    expect(rows[0].n).toBe(0);
  });
});

describe("bulk changes to work orders", () => {
  it("applies one change to many, each checked and audited on its own, and reports what couldn't change", async () => {
    const [a, b, c] = [await newWo(pm, "Bulk A"), await newWo(pm, "Bulk B"), await newWo(pm, "Bulk C")];
    const harbour = await newWo(admin, "Bulk elsewhere", "HBC"); // the PM manages Harbour Centre too
    await transitionWorkOrder(pm, c.workOrder.id, { to: "cancelled", note: "dup", resolutionNotes: null, cost: null });
    const audits = async () => (await ownerPool.query("select count(*)::int n from audit_logs where entity_id = any($1) and action = 'work_order.updated'", [[a, b, c, harbour].map((x) => x.workOrder.id)])).rows[0].n as number;
    const before = await audits();
    const r = await bulkUpdateWorkOrders(pm, [a, b, c, harbour].map((x) => x.workOrder.id).concat(crypto.randomUUID()), { op: "priority", priority: "high" });
    expect(r.changed).toBe(3);
    expect(r.failed.map((f) => f.reason)).toEqual(["This request is no longer open.", "Not found."]);
    expect(r.failed[0].number).toBe(c.workOrder.number);
    expect(await audits()).toBe(before + 3);
    const again = await bulkUpdateWorkOrders(pm, [a.workOrder.id], { op: "priority", priority: "high" });
    expect(again).toMatchObject({ changed: 0, unchanged: 1 });
  });

  it("assigns across properties only where that person or vendor may work", async () => {
    const opts = await bulkAssignOptions(pm);
    const blake = opts.vendors.find((v) => v.name === "Blake Plumbing & Heating")!; // approved at Fraser Towers and Harbour Centre
    expect(blake).toBeDefined();
    const frt = await newWo(pm, "Bulk assign FRT");
    const hbc = await newWo(pm, "Bulk assign HBC", "HBC");
    const r = await bulkUpdateWorkOrders(pm, [frt.workOrder.id, hbc.workOrder.id], { op: "assign", target: `vendor:${blake.id}` });
    expect(r).toMatchObject({ changed: 2, failed: [] });
    const { rows } = await ownerPool.query("select vendor_id, status from work_orders where id = any($1)", [[frt.workOrder.id, hbc.workOrder.id]]);
    expect(rows).toEqual([{ vendor_id: blake.id, status: "assigned" }, { vendor_id: blake.id, status: "assigned" }]);
    // a vendor approved at only one of two properties (Evergreen: Kingsway, not Fraser Towers): one changes, the
    // other is refused with the reason
    const evergreen = (await bulkAssignOptions(admin)).vendors.find((v) => v.name === "Evergreen Landscaping")!;
    const kwr = await newWo(admin, "Bulk assign KWR", "KWR");
    const mixed = await bulkUpdateWorkOrders(admin, [kwr.workOrder.id, frt.workOrder.id], { op: "assign", target: `vendor:${evergreen.id}` });
    expect(mixed.changed).toBe(1);
    expect(mixed.failed).toEqual([{ id: frt.workOrder.id, number: frt.workOrder.number, reason: "That vendor isn't active and approved for this property." }]);
  });

  it("acknowledges only new requests and closes only completed ones", async () => {
    const n = await newWo(pm, "Bulk ack");
    const r = await bulkUpdateWorkOrders(pm, [n.workOrder.id], { op: "acknowledge" });
    expect(r.changed).toBe(1);
    expect((await bulkUpdateWorkOrders(pm, [n.workOrder.id], { op: "acknowledge" })).unchanged).toBe(1);
    const close = await bulkUpdateWorkOrders(pm, [n.workOrder.id], { op: "close" });
    expect(close.failed[0].reason).toBe("Only completed requests can be closed.");
  });

  it("refuses people who can't manage work orders, oversized selections and junk ids", async () => {
    const w = await newWo(pm, "Bulk perms");
    const asVendor = await bulkUpdateWorkOrders(vendor, [w.workOrder.id], { op: "priority", priority: "urgent" });
    expect(asVendor.changed).toBe(0);
    expect(asVendor.failed).toHaveLength(1);
    await expect(bulkUpdateWorkOrders(pm, Array.from({ length: 101 }, () => crypto.randomUUID()), { op: "acknowledge" })).rejects.toBeInstanceOf(ValidationError);
    await expect(bulkUpdateWorkOrders(pm, ["1; drop table work_orders"], { op: "acknowledge" })).rejects.toBeInstanceOf(ValidationError);
    await expect(bulkUpdateWorkOrders(pm, [], { op: "acknowledge" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("offline drafts", () => {
  it("sending the same draft twice creates one request", async () => {
    const ref = `draft-${crypto.randomUUID()}`;
    const first = await newWo(staff, "Offline draft", "HBC", { clientRef: ref });
    const second = await newWo(staff, "Offline draft", "HBC", { clientRef: ref });
    expect(second.duplicate).toBe(true);
    expect(second.workOrder.id).toBe(first.workOrder.id);
    const { rows } = await ownerPool.query("select count(*)::int n from work_orders where client_ref = $1", [ref]);
    expect(rows[0].n).toBe(1);
  });

  it("two sends at the same moment still make one request", async () => {
    const ref = `race-${crypto.randomUUID()}`;
    const [x, y] = await Promise.all([newWo(staff, "Racing draft", "HBC", { clientRef: ref }), newWo(staff, "Racing draft", "HBC", { clientRef: ref })]);
    expect(x.workOrder.id).toBe(y.workOrder.id);
  });

  it("a reference is per person: someone else's reference doesn't return their request", async () => {
    const ref = `shared-${crypto.randomUUID()}`;
    const mine = await newWo(staff, "Mine", "HBC", { clientRef: ref });
    const theirs = await newWo(pm, "Theirs", "HBC", { clientRef: ref });
    expect(theirs.workOrder.id).not.toBe(mine.workOrder.id);
    await expect(newWo(staff, "Bad ref", "HBC", { clientRef: "x" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("web push", () => {
  // a stand-in for a browser vendor's push service: records what arrives and answers with a chosen status
  let server: Server;
  let port = 0;
  let status = 201;
  const received: { path: string; headers: IncomingMessage["headers"]; body: Buffer }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(status); res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // what a browser creates when it subscribes: an ECDH key pair and an auth secret
  const browser = () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const endpoint = `http://127.0.0.1:${port}/push/${crypto.randomUUID()}`;
    return { ecdh, auth, sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
  };

  it("only accepts endpoints at known browser push services", () => {
    expect(checkEndpoint("https://fcm.googleapis.com/fcm/send/abc").host).toBe("fcm.googleapis.com");
    expect(checkEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x").host).toBe("updates.push.services.mozilla.com");
    expect(checkEndpoint("https://web.push.apple.com/QAB").host).toBe("web.push.apple.com");
    for (const bad of ["https://evil.example/push", "https://fcm.googleapis.com.evil.example/x", "http://fcm.googleapis.com/x", "https://user:pw@fcm.googleapis.com/x", "http://10.0.0.5/x", "file:///etc/passwd", "nonsense"]) {
      expect(() => checkEndpoint(bad), bad).toThrow(ValidationError);
    }
  });

  it("delivers an encrypted, VAPID-signed payload that only the subscribed browser can read", async () => {
    const b = browser();
    await subscribePush(resident, b.sub, meta.userAgent);
    received.length = 0;
    const out = await sendPushToUsers(org, [resident.principal.userId], { title: "Package for you", body: "At the front desk", href: "/o/pacific-properties/packages", tag: "package:1" });
    expect(out.sent).toBe(1);
    const msg = received.find((m) => b.sub.endpoint.endsWith(m.path))!;
    expect(msg.headers["content-encoding"]).toBe("aes128gcm");
    expect(String(msg.headers.authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(msg.body.toString("utf8")).not.toContain("Package"); // not readable in transit
    const plain = JSON.parse(ece.decrypt(msg.body, { version: "aes128gcm", privateKey: b.ecdh, authSecret: b.auth.toString("base64url") }).toString("utf8"));
    expect(plain).toEqual({ title: "Package for you", body: "At the front desk", href: "/o/pacific-properties/packages", tag: "package:1" });
    const [dev] = (await myPushDevices(resident)).filter((d) => d.endpoint === b.sub.endpoint);
    expect(dev.lastSuccessAt).not.toBeNull();
  });

  it("notification delivery pushes to subscribed devices, honouring per-kind choices", async () => {
    const b = browser();
    await subscribePush(staff, b.sub, meta.userAgent);
    await drainOutbox(); // whatever earlier tests queued
    received.length = 0;
    const w = await newWo(pm, "Push me", "HBC");
    const { assignWorkOrder } = await import("@/server/modules/maintenance/service");
    await assignWorkOrder(pm, w.workOrder.id, { membershipId: staff.principal.membershipId!, vendorId: null });
    await drainOutbox();
    const mine = received.filter((m) => b.sub.endpoint.endsWith(m.path));
    expect(mine.length).toBeGreaterThan(0);
    const titles = mine.map((m) => JSON.parse(ece.decrypt(m.body, { version: "aes128gcm", privateKey: b.ecdh, authSecret: b.auth.toString("base64url") }).toString("utf8")).title as string);
    expect(titles.some((t) => t.includes(`#${w.workOrder.number}`))).toBe(true);
    // turning push off for that kind stops it (in-app still arrives)
    const { savePreferences } = await import("@/server/modules/notifications/service");
    await savePreferences(staff, [{ kind: "workorder.assigned", email: false, inApp: true, push: false }]);
    received.length = 0;
    const w2 = await newWo(pm, "Push me not", "HBC");
    await assignWorkOrder(pm, w2.workOrder.id, { membershipId: staff.principal.membershipId!, vendorId: null });
    await drainOutbox();
    expect(received.filter((m) => b.sub.endpoint.endsWith(m.path))).toHaveLength(0);
    await savePreferences(staff, [{ kind: "workorder.assigned", email: false, inApp: true, push: true }]);
  });

  it("drops subscriptions the push service says are gone, and records consent both ways", async () => {
    const b = browser();
    await subscribePush(resident, b.sub, meta.userAgent);
    status = 410;
    const out = await sendPushToUsers(org, [resident.principal.userId], { title: "x", href: "/o/pacific-properties/dashboard" });
    status = 201;
    expect(out.gone).toBeGreaterThanOrEqual(1);
    expect((await myPushDevices(resident)).some((d) => d.endpoint === b.sub.endpoint)).toBe(false);
    const c = browser();
    await subscribePush(resident, c.sub, meta.userAgent);
    for (const d of await myPushDevices(resident)) await unsubscribePush(resident, d.endpoint);
    const { rows } = await ownerPool.query("select granted from consents where org_id = $1 and user_id = $2 and channel = 'push' order by created_at desc limit 2", [org, resident.principal.userId]);
    expect(rows.map((r) => r.granted)).toEqual([false, true]);
  });

  it("a device moves to whoever subscribes on it last; nobody can read another person's devices", async () => {
    const b = browser();
    await subscribePush(pm, b.sub, meta.userAgent);
    await subscribePush(admin, b.sub, meta.userAgent); // same browser, someone else signed in
    expect((await myPushDevices(pm)).some((d) => d.endpoint === b.sub.endpoint)).toBe(false);
    expect((await myPushDevices(admin)).some((d) => d.endpoint === b.sub.endpoint)).toBe(true);
    await asApp({ orgId: org, userId: pm.principal.userId }, async (q) => expect((await q("select count(*)::int n from push_subscriptions where user_id <> $1", [pm.principal.userId])).rows[0].n).toBe(0));
    await unsubscribePush(admin, b.sub.endpoint);
  });

  it("refuses subscriptions with malformed keys", async () => {
    const b = browser();
    await expect(subscribePush(pm, { ...b.sub, keys: { p256dh: "short", auth: b.sub.keys.auth } }, null)).rejects.toBeInstanceOf(ValidationError);
    await expect(subscribePush(pm, { ...b.sub, endpoint: "https://evil.example/x" }, null)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("privacy covers the new personal data", () => {
  it("export lists a person's saved views, recent records and push devices; erasure removes them", async () => {
    // a throwaway resident with an account, so the demo resident stays intact
    const email = `ux-${tag.toLowerCase()}@example.test`;
    const { rows: [u] } = await ownerPool.query("insert into users (email, name, password_hash, email_verified_at) values ($1, 'UX Person', 'x', now()) returning id", [email]);
    const { rows: [role] } = await ownerPool.query("select id from roles where key = 'resident' and org_id is null");
    await ownerPool.query("insert into memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'active')", [org, u.id, role.id]);
    const { rows: [r] } = await ownerPool.query("insert into residents (org_id, first_name, last_name, email, user_id) values ($1, 'UX', 'Person', $2, $3) returning id", [org, email, u.id]);
    const person = await ctxFor(email);
    await saveView(person, "maintenance", `${tag} person`, "view=open");
    await recordView(person, { type: "work_order", id: crypto.randomUUID(), title: "Their job", href: "/o/pacific-properties/maintenance/x" });
    await recordView(pm, { type: "resident", id: r.id, title: "UX Person", href: `/o/pacific-properties/residents/${r.id}` });
    const { requestId } = await exportPerson(admin, r.id);
    const doc = JSON.parse(new TextDecoder().decode((await openExport(admin, requestId)).bytes));
    expect(doc.savedViews).toEqual([expect.objectContaining({ page: "maintenance", name: `${tag} person`, filters: "view=open" })]);
    expect(doc.recentlyViewed).toEqual([expect.objectContaining({ type: "work_order", title: "Their job" })]);
    expect(doc.pushDevices).toEqual([]);
    const result = await erasePerson(admin, r.id, { reason: "ux test" });
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({ savedViews: 1, recentlyViewed: 1 });
    const { rows: left } = await ownerPool.query("select count(*)::int n from recent_views where entity_id = $1", [r.id]);
    expect(left[0].n).toBe(0); // gone from the manager's recents too
    await ownerPool.query("delete from residents where id = $1", [r.id]);
    await ownerPool.query("delete from users where id = $1", [u.id]);
  });
});
