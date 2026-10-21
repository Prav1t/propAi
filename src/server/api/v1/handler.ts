import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withContext } from "../../db/client";
import { apiIdempotency } from "../../db/schema";
import { rateLimiter } from "../../auth/rate-limit";
import type { RequestMeta } from "../../request-meta";
import { assertFeatureOf, assertNotReadOnly, getEntitlements } from "../../billing/entitlements";
import { incrementUsage } from "../../billing/service";
import { authenticateApiKey, type ApiCaller } from "../keys";
import { ApiError, toApiError } from "./errors";
import { matchRoute, type Route } from "./routes";
import { buildOpenApi } from "./openapi";
import { log } from "../../log";

// The request pipeline for /api/v1 (Iteration 10):
// route → API key → per-key rate limit → plan/flag → read-only check for writes → key permission → validation →
// idempotency (writes) → the app's own service → JSON. Every response has X-Request-Id; errors share one shape.

const MAX_BODY_BYTES = 64 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const AUTH_FAILS = { limit: 30, windowMs: 15 * 60_000 };

export type ApiResult = { status: number; body: unknown; headers: Record<string, string>; write: boolean };

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export function errorResponse(e: ApiError, requestId: string, headers: Record<string, string> = {}) {
  return json(e.status, { error: { type: e.type, message: e.message, ...(e.details?.length ? { details: e.details } : {}), request_id: requestId } }, { "x-request-id": requestId, ...headers });
}

async function readBody(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new ApiError(400, "invalid_request", "Send a JSON body with Content-Type: application/json.");
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new ApiError(400, "invalid_request", `The body is larger than ${MAX_BODY_BYTES / 1024} KB.`);
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ApiError(400, "invalid_request", `The body is larger than ${MAX_BODY_BYTES / 1024} KB.`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "invalid_request", "The body isn't valid JSON.");
  }
}

function parseQuery(route: Route, url: URL): Record<string, unknown> {
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) raw[k] = v;
  if (!route.query) {
    if (Object.keys(raw).length) throw new ApiError(400, "invalid_request", "This endpoint takes no query parameters.", Object.keys(raw).map((k) => ({ field: k, message: "Unknown parameter." })));
    return {};
  }
  const r = route.query.safeParse(raw);
  if (!r.success) throw new ApiError(400, "invalid_request", "Some query parameters are invalid.", r.error.issues.map((i) => ({ field: String(i.path[0] ?? (i as { keys?: string[] }).keys?.[0] ?? "query"), message: i.message })));
  return r.data as Record<string, unknown>;
}

/* ───────────── idempotency ───────────── */

async function idempotent(caller: ApiCaller, key: string, requestHash: string, run: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const orgId = caller.key.orgId;
  const keyId = caller.key.id;
  const claim = await withContext({ orgId, system: true }, async (tx) => {
    const [existing] = await tx.select().from(apiIdempotency).where(and(eq(apiIdempotency.apiKeyId, keyId), eq(apiIdempotency.key, key))).for("update");
    if (existing && Date.now() - existing.createdAt.getTime() > IDEMPOTENCY_TTL_MS) await tx.delete(apiIdempotency).where(eq(apiIdempotency.id, existing.id));
    else if (existing) return existing;
    await tx.insert(apiIdempotency).values({ orgId, apiKeyId: keyId, key, requestHash });
    return null;
  });
  if (claim) {
    if (claim.requestHash !== requestHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different request.");
    if (claim.statusCode === null) throw new ApiError(409, "idempotency_conflict", "A request with this Idempotency-Key is still being processed. Retry shortly.");
    return { status: claim.statusCode, body: claim.responseBody, replayed: true };
  }
  const save = (status: number, body: unknown) => withContext({ orgId, system: true }, (tx) =>
    tx.update(apiIdempotency).set({ statusCode: status, responseBody: body as object }).where(and(eq(apiIdempotency.apiKeyId, keyId), eq(apiIdempotency.key, key))));
  try {
    const r = await run();
    await save(r.status, r.body);
    return { ...r, replayed: false };
  } catch (e) {
    const err = toApiError(e);
    // a server error may not have happened at all: let the retry run it again. Client errors are final and replayed.
    if (err.status >= 500) await withContext({ orgId, system: true }, (tx) => tx.delete(apiIdempotency).where(and(eq(apiIdempotency.apiKeyId, keyId), eq(apiIdempotency.key, key))));
    else await save(err.status, { error: { type: err.type, message: err.message, ...(err.details?.length ? { details: err.details } : {}) } });
    throw err;
  }
}

/* ───────────── the pipeline ───────────── */

export async function handleApiRequest(req: Request, segments: string[], meta: RequestMeta, appUrl: string): Promise<{ response: Response; write: boolean; orgId: string | null }> {
  const requestId = meta.requestId ?? randomUUID();
  const url = new URL(req.url);
  const path = `/${segments.join("/")}`;
  const method = req.method.toUpperCase();
  let rlHeaders: Record<string, string> = {};
  let orgId: string | null = null;
  try {
    if (method === "GET" && path === "/openapi.json") {
      return { response: json(200, buildOpenApi(appUrl), { "x-request-id": requestId, "cache-control": "public, max-age=300", "access-control-allow-origin": "*" }), write: false, orgId: null };
    }
    const m = matchRoute(method, path);
    if (!m) throw new ApiError(404, "not_found", "No such endpoint. The API reference is at /developers/api.");
    if ("allowed" in m) {
      return { response: errorResponse(new ApiError(405, "invalid_request", `Use ${m.allowed.join(" or ")} for this endpoint.`), requestId, { allow: m.allowed.join(", ") }), write: false, orgId: null };
    }
    const { route, params } = m;

    // 1. who
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new ApiError(401, "authentication_failed", "Send your API key as: Authorization: Bearer ak_…");
    let caller: ApiCaller;
    try {
      caller = await authenticateApiKey(token, meta);
    } catch (e) {
      // repeated failures from one address are slowed down
      const rl = await rateLimiter().hit(`api-auth-fail:${meta.ip ?? "unknown"}`, AUTH_FAILS.limit, AUTH_FAILS.windowMs);
      if (!rl.allowed) throw new ApiError(429, "rate_limited", "Too many failed attempts. Try again later.");
      throw e;
    }
    orgId = caller.key.orgId;

    // 2. how often
    const rl = await rateLimiter().hit(`api:${caller.key.id}`, caller.key.requestsPerMinute, 60_000);
    rlHeaders = { "x-ratelimit-limit": String(caller.key.requestsPerMinute), "x-ratelimit-remaining": String(rl.remaining), "x-ratelimit-reset": String(Math.ceil(rl.resetAt / 1000)) };
    if (!rl.allowed) {
      const retry = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return { response: errorResponse(new ApiError(429, "rate_limited", `This key allows ${caller.key.requestsPerMinute} requests a minute.`), requestId, { ...rlHeaders, "retry-after": String(retry) }), write: false, orgId };
    }

    // 3. the plan, the rollout flag and (for writes) the subscription state
    const ent = await getEntitlements(caller.key.orgId);
    assertFeatureOf(ent, "api");
    const write = method !== "GET";
    if (write) assertNotReadOnly(ent);

    // 4. the key's permission for this endpoint (services check record-level access again)
    if (route.scope && !caller.ctx.principal.permissions.has(route.scope)) {
      throw new ApiError(403, "permission_denied", `This API key doesn't have the ${route.scope} permission${caller.key.permissions.includes(route.scope) ? " (its creator no longer has it)" : ""}.`);
    }

    // 5. input
    const query = parseQuery(route, url);
    let body: unknown;
    if (route.body) {
      const raw = await readBody(req);
      const parsed = route.body.safeParse(raw);
      if (!parsed.success) throw new ApiError(400, "invalid_request", "Some fields are invalid.", parsed.error.issues.slice(0, 20).map((i) => ({ field: i.path.join(".") || String((i as { keys?: string[] }).keys?.[0] ?? "body"), message: i.message })));
      body = parsed.data;
    }
    const ctx = { ...caller.ctx, meta: { ...meta, requestId } };
    const run = async () => ({ status: route.status ?? 200, body: await route.run(ctx, { params, query, body, caller }) });

    // 6. run (writes may be made idempotent)
    const idemKey = req.headers.get("idempotency-key");
    let result: { status: number; body: unknown; replayed?: boolean };
    if (write && idemKey) {
      if (idemKey.length > 255) throw new ApiError(400, "invalid_request", "Idempotency-Key must be at most 255 characters.");
      const hash = createHash("sha256").update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest("hex");
      result = await idempotent(caller, idemKey, hash, run);
    } else result = await run();

    incrementUsage(caller.key.orgId, "api_requests").catch((err) => log.warn("api.usage_failed", { err }));
    const headers: Record<string, string> = { "x-request-id": requestId, ...rlHeaders, ...(result.replayed ? { "idempotent-replayed": "true" } : {}) };
    if (result.status >= 400) return { response: json(result.status, { ...(result.body as object), error: { ...((result.body as { error: object }).error), request_id: requestId } }, headers), write, orgId };
    return { response: json(result.status, result.body, headers), write: write && !result.replayed, orgId };
  } catch (e) {
    return { response: errorResponse(toApiError(e), requestId, rlHeaders), write: false, orgId };
  }
}
