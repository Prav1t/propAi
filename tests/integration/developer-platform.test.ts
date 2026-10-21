import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApiRequest } from "@/server/api/v1/handler";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/api/keys";
import {
  attemptDelivery, createEndpoint, deliverDueWebhooks, fanOutWebhookEvents, getEndpoint, listEndpoints, replayDelivery, sendTestEvent, setEndpointActive,
} from "@/server/webhooks/service";
import { verifyWebhook } from "@/server/webhooks/signing";
import { connectIntegration, listIntegrations, sendChatMessage } from "@/server/integrations/service";
import { adminSetFlag } from "@/server/billing/admin";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ownerPool, userIdByEmail } from "../support/db";

process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true"; // the receiver below listens on 127.0.0.1 (refused in production)

const meta = { ip: "203.0.113.80", userAgent: "vitest", requestId: null };
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

// a request through the same pipeline the route handler uses
async function api(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/v1${path}`);
  const req = new Request(url, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const segs = url.pathname.replace(/^\/api\/v1\//, "").split("/").filter(Boolean);
  const { response } = await handleApiRequest(req, segs, { ...meta, requestId: `t-${uniq()}` }, "http://localhost:3000");
  return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
}

// webhook receiver
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let failNext = 0;
let server: http.Server;
let hookUrl = "";

let admin: TenantCtx, pm: TenantCtx, nsAdmin: TenantCtx;
let superId = "";
const ids: Record<string, string> = {};
let fullKey = "";

beforeAll(async () => {
  superId = (await q("select id from users where is_platform_admin limit 1"))[0].id;
  [admin, pm, nsAdmin] = await Promise.all([ctxFor("admin@demo.test"), ctxFor("pm@demo.test"), ctxFor("admin@northshore.test", "northshore-strata")]);
  for (const r of await q("select code, id from properties")) ids[r.code] = r.id;
  ids.nsWo = (await q("select w.id from work_orders w join organizations o on o.id = w.org_id where o.slug = 'northshore-strata' limit 1"))[0].id;
  ids.frtWo = (await q("select id from work_orders where property_id = $1 limit 1", [ids.FRT]))[0].id;
  ids.pchWo = (await q("select id from work_orders where property_id = $1 limit 1", [ids.PCH]))[0].id;
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: b });
      if (failNext > 0) { failNext--; res.writeHead(500); return res.end("boom"); }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks`;
  fullKey = (await createApiKey(admin, { name: "Full", scopes: ["property.read", "unit.read", "workorder.read", "workorder.create", "workorder.manage", "incident.read", "incident.create", "resident.read"] })).token;
});
afterAll(async () => {
  await q("delete from feature_flags");
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeDb();
  await ownerPool.end();
});

describe("API keys", () => {
  it("only people who manage developer settings can create keys, and never with more than they have", async () => {
    await expect(createApiKey(pm, { name: "Nope", scopes: ["workorder.read"] })).rejects.toBeInstanceOf(ForbiddenError);
    const conc = await ctxFor("concierge@demo.test");
    conc.principal = { ...conc.principal, permissions: new Set([...conc.principal.permissions, "api.manage"]) }; // a custom role with api.manage
    await expect(createApiKey(conc, { name: "Too much", scopes: ["workorder.manage"], propertyIds: [ids.FRT] })).rejects.toThrow(/permissions you don't have/);
  });
  it("store only a hash, list without the secret and audit creation", async () => {
    const r = await createApiKey(admin, { name: `Audit ${uniq()}`, scopes: ["property.read"] });
    const [row] = await q("select key_hash, prefix from api_keys where id = $1", [r.id]);
    expect(row.key_hash).not.toContain(r.token.slice(12));
    expect(r.token.startsWith(`ak_${row.prefix}_`)).toBe(true);
    expect(JSON.stringify(await listApiKeys(admin))).not.toContain(r.token);
    expect((await q("select count(*)::int n from audit_logs where action = 'api_key.created' and entity_id = $1", [r.id]))[0].n).toBe(1);
  });
});

describe("REST API v1", () => {
  it("authenticates, and reports the key's effective permissions", async () => {
    expect((await api(null, "GET", "/me")).json.error.type).toBe("authentication_failed");
    expect((await api(`ak_aaaaaaaa_${"x".repeat(43)}`, "GET", "/me")).status).toBe(401);
    const me = await api(fullKey, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.json.organization.slug).toBe("pacific-properties");
    expect(me.json.permissions).toContain("workorder.create");
    expect(me.headers.get("x-request-id")).toBeTruthy();
    expect(me.headers.get("x-ratelimit-limit")).toBe("120");
  });
  it("pages through work orders with cursors (no gaps, no repeats)", async () => {
    const all = (await q("select count(*)::int n from work_orders w join organizations o on o.id = w.org_id where o.slug = 'pacific-properties' and w.status = 'completed'"))[0].n;
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await api(fullKey, "GET", `/work-orders?status=completed&limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      for (const w of r.json.data) { expect(seen.has(w.id)).toBe(false); seen.add(w.id); expect(w.status).toBe("completed"); }
      cursor = r.json.next_cursor;
      if (!r.json.has_more) break;
    }
    expect(seen.size).toBe(all);
    expect((await api(fullKey, "GET", "/work-orders?cursor=garbage")).json.error).toMatchObject({ type: "invalid_request", details: [{ field: "cursor" }] });
  });
  it("never returns another organization's records", async () => {
    expect((await api(fullKey, "GET", `/work-orders/${ids.nsWo}`)).status).toBe(404);
    const props = (await api(fullKey, "GET", "/properties")).json.data.map((p: { code: string }) => p.code);
    expect(props.sort()).toEqual(["FRT", "HBC", "KWR", "PCH"]);
  });
  it("a property-limited key sees only those properties", async () => {
    const { token } = await createApiKey(admin, { name: "Fraser only", scopes: ["workorder.read", "property.read"], propertyIds: [ids.FRT] });
    expect((await api(token, "GET", `/work-orders/${ids.frtWo}`)).status).toBe(200);
    expect((await api(token, "GET", `/work-orders/${ids.pchWo}`)).status).toBe(404);
    const list = await api(token, "GET", "/work-orders?limit=100");
    expect(list.json.data.every((w: { property_id: string }) => w.property_id === ids.FRT)).toBe(true);
    expect((await api(token, "GET", "/properties")).json.data.map((p: { code: string }) => p.code)).toEqual(["FRT"]);
  });
  it("refuses endpoints outside the key's permissions", async () => {
    const { token } = await createApiKey(admin, { name: "Read only", scopes: ["workorder.read"] });
    const r = await api(token, "POST", "/work-orders", { property_id: ids.FRT, title: "Should fail", category: "general" });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/workorder.create/);
    expect((await api(token, "GET", "/residents")).status).toBe(403);
  });
  it("creates work orders through the same service as the app, idempotently, audited with the key", async () => {
    const body = { property_id: ids.FRT, title: `API leak ${uniq()}`, category: "plumbing", description: "Dripping under the sink" };
    const key = uniq();
    const a = await api(fullKey, "POST", "/work-orders", body, { "idempotency-key": key });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ object: "work_order", source: "api", title: body.title, property_id: ids.FRT });
    const b = await api(fullKey, "POST", "/work-orders", body, { "idempotency-key": key });
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await q("select count(*)::int n from work_orders where title = $1", [body.title]))[0].n).toBe(1);
    expect((await api(fullKey, "POST", "/work-orders", { ...body, title: "other" }, { "idempotency-key": key })).json.error.type).toBe("idempotency_conflict");
    const [audit] = await q("select api_key_id from audit_logs where action = 'work_order.created' and entity_id = $1", [a.json.id]);
    expect(audit.api_key_id).toBeTruthy();
    expect((await q("select count(*)::int n from outbox_events where type = 'workorder.created' and payload->>'workOrderId' = $1", [a.json.id]))[0].n).toBe(1);
    const t = await api(fullKey, "POST", `/work-orders/${a.json.id}/status`, { status: "in_progress", note: "Plumber on site" });
    expect(t.json.status).toBe("in_progress");
    const bad = await api(fullKey, "POST", "/work-orders", { property_id: ids.FRT, title: "x", category: "nope", extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(["title", "category"]));
  });
  it("revoked keys, removed creators, plan flags and read-only mode are all enforced on every request", async () => {
    const r = await createApiKey(admin, { name: `Temp ${uniq()}`, scopes: ["workorder.read", "workorder.create"] });
    expect((await api(r.token, "GET", "/work-orders?limit=1")).status).toBe(200);

    await adminSetFlag(superId, "public_api", admin.principal.orgId, false);
    expect((await api(r.token, "GET", "/work-orders?limit=1")).json.error.type).toBe("feature_unavailable");
    await adminSetFlag(superId, "public_api", admin.principal.orgId, null);

    await q("update subscriptions set status = 'cancelled' where org_id = $1", [admin.principal.orgId]);
    expect((await api(r.token, "GET", "/work-orders?limit=1")).status).toBe(200); // reading still works
    const w = await api(r.token, "POST", "/work-orders", { property_id: ids.FRT, title: "Blocked while read-only", category: "general" });
    expect(w.status).toBe(402);
    expect(w.json.error.type).toBe("subscription_inactive");
    await q("update subscriptions set status = 'active' where org_id = $1", [admin.principal.orgId]);

    await q("update api_keys set expires_at = now() - interval '1 minute' where id = $1", [r.id]);
    expect((await api(r.token, "GET", "/me")).json.error.message).toMatch(/expired/);
    await q("update api_keys set expires_at = null where id = $1", [r.id]);
    await revokeApiKey(admin, r.id);
    expect((await api(r.token, "GET", "/me")).status).toBe(401);
  });
  it("a key stops working when its creator loses access", async () => {
    const [m] = await q("select m.id from memberships m join users u on u.id = m.user_id join organizations o on o.id = m.org_id where u.email = 'admin@northshore.test' and o.slug = 'northshore-strata'");
    await q("update subscriptions set plan_key = 'professional' where org_id = $1", [nsAdmin.principal.orgId]);
    const { token } = await createApiKey(nsAdmin, { name: "NS", scopes: ["workorder.read"] });
    expect((await api(token, "GET", "/me")).status).toBe(200);
    await q("update memberships set status = 'deactivated' where id = $1", [m.id]);
    const r = await api(token, "GET", "/me");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/no longer has access/);
    await q("update memberships set status = 'active' where id = $1", [m.id]);
    await q("update subscriptions set plan_key = 'starter' where org_id = $1", [nsAdmin.principal.orgId]);
  });
  it("rate-limits per key", async () => {
    const r = await createApiKey(admin, { name: `Slow ${uniq()}`, scopes: ["property.read"] });
    await q("update api_keys set requests_per_minute = 2 where id = $1", [r.id]);
    await api(r.token, "GET", "/properties");
    await api(r.token, "GET", "/properties");
    const third = await api(r.token, "GET", "/properties");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("publishes an OpenAPI document generated from the routes", async () => {
    const r = await api(null, "GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe("3.1.0");
    expect(Object.keys(r.json.paths)).toEqual(expect.arrayContaining(["/work-orders", "/work-orders/{id}", "/work-orders/{id}/status", "/incidents"]));
    expect(r.json.paths["/work-orders"].post.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/CreateWorkOrder");
    expect(r.json.components.schemas.WorkOrder.properties.status.enum).toContain("in_progress");
  });
});

describe("webhooks", () => {
  let endpointId = "";
  let secret = "";
  it("only api.manage may add endpoints; the secret is shown once and never listed", async () => {
    await expect(createEndpoint(pm, { url: hookUrl, events: ["work_order.created"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEndpoint(admin, { url: hookUrl, events: ["nonsense"] })).rejects.toThrow();
    const r = await createEndpoint(admin, { url: hookUrl, description: "test receiver", events: ["work_order.created", "work_order.status_changed"] });
    endpointId = r.id;
    secret = r.secret;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await listEndpoints(admin))).not.toContain(secret);
    expect(JSON.stringify(await getEndpoint(admin, endpointId))).not.toContain("secret_enc");
    const [row] = await q("select secret_enc from webhook_endpoints where id = $1", [endpointId]);
    expect(row.secret_enc).not.toContain(secret.slice(6));
  });
  it("delivers a signed event when a work order is created through the API", async () => {
    received.length = 0;
    const title = `Webhook leak ${uniq()}`;
    const created = await api(fullKey, "POST", "/work-orders", { property_id: ids.FRT, title, category: "plumbing" });
    expect(await fanOutWebhookEvents()).toBeGreaterThan(0);
    await deliverDueWebhooks();
    const hit = received.find((r) => r.body.includes(title))!;
    expect(hit).toBeTruthy();
    expect(verifyWebhook(secret, String(hit.headers["webhook-signature"]), hit.body)).toBe(true);
    const payload = JSON.parse(hit.body);
    expect(payload).toMatchObject({ type: "work_order.created", api_version: "v1", data: { object: { object: "work_order", id: created.json.id, title } } });
    expect(hit.headers["webhook-id"]).toBeTruthy();
    const [d] = await q("select * from webhook_deliveries where endpoint_id = $1 and payload->'data'->'object'->>'id' = $2", [endpointId, created.json.id]);
    expect(d).toMatchObject({ status: "succeeded", attempts: 1, last_status_code: 204 });
    // fan-out again: nothing new (each event once per endpoint)
    expect(await fanOutWebhookEvents()).toBe(0);
  });
  it("retries a failed delivery with backoff, logging each attempt", async () => {
    received.length = 0;
    failNext = 1;
    const title = `Retry ${uniq()}`;
    await api(fullKey, "POST", "/work-orders", { property_id: ids.FRT, title, category: "general" });
    await fanOutWebhookEvents();
    await deliverDueWebhooks();
    const [d] = await q("select * from webhook_deliveries where endpoint_id = $1 and payload->'data'->'object'->>'title' = $2", [endpointId, title]);
    expect(d).toMatchObject({ status: "pending", attempts: 1, last_status_code: 500 });
    const wait = new Date(d.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(70_000);
    await deliverDueWebhooks(); // not due yet
    expect((await q("select attempts from webhook_deliveries where id = $1", [d.id]))[0].attempts).toBe(1);
    await q("update webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1", [d.id]);
    await deliverDueWebhooks();
    expect((await q("select status, attempts from webhook_deliveries where id = $1", [d.id]))[0]).toEqual({ status: "succeeded", attempts: 2 });
    expect(await q("select attempt, status_code from webhook_attempts where delivery_id = $1 order by attempt", [d.id])).toEqual([{ attempt: 1, status_code: 500 }, { attempt: 2, status_code: 204 }]);
    expect((await q("select consecutive_failures from webhook_endpoints where id = $1", [endpointId]))[0].consecutive_failures).toBe(0);
  });
  it("switches an endpoint off after repeated failures and tells the admins; replays resend the same event", async () => {
    await q("update webhook_endpoints set consecutive_failures = 19 where id = $1", [endpointId]);
    failNext = 1;
    const ping = await sendTestEvent(admin, endpointId);
    expect(ping.status).toBe("pending");
    const [e] = await q("select status, disabled_reason from webhook_endpoints where id = $1", [endpointId]);
    expect(e.status).toBe("disabled");
    expect((await q("select count(*)::int n from outbox_events where type = 'webhook.endpoint_disabled' and payload->>'endpointId' = $1", [endpointId]))[0].n).toBe(1);
    expect(await attemptDelivery(ping.id, new Date(Date.now() + 3_600_000))).toMatchObject({ status: "pending", attempts: 1 }); // off: not sent
    await setEndpointActive(admin, endpointId, true);
    const replay = await replayDelivery(admin, ping.id);
    expect(replay.status).toBe("succeeded");
    expect((replay.payload as { id: string }).id).toBe((ping.payload as { id: string }).id);
  });
  it("an organization's endpoint never receives another organization's events", async () => {
    received.length = 0;
    const { createWorkOrder } = await import("@/server/modules/maintenance/service");
    const nsProp = (await q("select p.id from properties p join organizations o on o.id = p.org_id where o.slug = 'northshore-strata' limit 1"))[0].id;
    await createWorkOrder(nsAdmin, { title: `Northshore only ${uniq()}`, description: "", category: "general", priority: null, isEmergency: false, unitId: null, buildingId: null, unitNumber: null, propertyId: nsProp, area: null, permissionToEnter: false, entryNotes: null });
    await fanOutWebhookEvents();
    await deliverDueWebhooks();
    expect(received.some((r) => r.body.includes("Northshore only"))).toBe(false);
  });
});

describe("integrations", () => {
  it("validate and encrypt credentials; only a masked hint is ever shown", async () => {
    await expect(connectIntegration(admin, "slack", { webhookUrl: "https://evil.example/x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(connectIntegration(pm, "slack", { webhookUrl: "https://hooks.slack.com/services/T0/B0/abc" })).rejects.toBeInstanceOf(ForbiddenError);
    const url = "https://hooks.slack.com/services/T000/B000/supersecretvalue1234";
    await connectIntegration(admin, "slack", { webhookUrl: url, channel: "#maintenance" });
    const [row] = await q("select config, credentials_enc from integrations where provider = 'slack' and org_id = $1", [admin.principal.orgId]);
    expect(row.config).toEqual({ channel: "#maintenance" });
    expect(row.credentials_enc).not.toContain("supersecret");
    const slack = (await listIntegrations(admin)).find((i) => i.key === "slack")!;
    expect(slack.secretHints.webhookUrl).toBe("••••1234");
    expect(JSON.stringify(await listIntegrations(admin))).not.toContain("supersecret");
    expect((await q("select after from audit_logs where action = 'integration.connected' and org_id = $1 order by created_at desc limit 1", [admin.principal.orgId]))[0].after).not.toHaveProperty("webhookUrl");
  });
  it("reports a clear error when a provider isn't connected", async () => {
    await expect(sendChatMessage(admin.principal.orgId, "teams", "hello")).rejects.toThrow(/Microsoft Teams isn't connected/);
  });
});
