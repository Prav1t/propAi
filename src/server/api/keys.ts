import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withContext } from "../db/client";
import { apiKeys, organizations, properties, users } from "../db/schema";
import { authorize, ForbiddenError, NotFoundError, type Principal } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { hashToken } from "../auth/crypto";
import { loadPrincipal } from "../modules/organizations/principal";
import { assertFeature } from "../billing/entitlements";
import { visiblePropertyIds } from "../modules/scope";
import type { RequestMeta } from "../request-meta";
import { API_SCOPE_PERMS, isApiScope } from "@/lib/api-scopes";

// API keys (Iteration 10). Format: ak_<8-char prefix>_<43-char secret>. Only sha256(key) is stored; the full key is
// shown once. A request with a key acts as the member who created it, narrowed to the key's scopes and properties —
// re-evaluated on every request, so removing the member, or their permissions, removes the key's too.

const KEY_RE = /^ak_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): { token: string; prefix: string } {
  const prefix = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(8, "0").slice(0, 8);
  return { token: `ak_${prefix}_${randomBytes(32).toString("base64url")}`, prefix };
}

export const looksLikeApiKey = (s: string) => KEY_RE.test(s);

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2, "Give the key a name you'll recognise.").max(80),
  scopes: z.array(z.string()).min(1, "Choose at least one permission.").max(API_SCOPE_PERMS.length),
  propertyIds: z.array(z.string().uuid()).max(200).default([]),
  expiresInDays: z.union([z.literal(""), z.coerce.number().int().min(1).max(730)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
});

export type ApiKeyRow = Pick<typeof apiKeys.$inferSelect, "id" | "name" | "prefix" | "permissions" | "propertyIds" | "createdAt" | "lastUsedAt" | "expiresAt" | "revokedAt" | "requestsPerMinute"> & { createdByName: string | null; expired: boolean };

function canManageKeys(p: Principal) {
  authorize(p, "api.manage");
  if (p.role.category !== "staff" || (p.role.scopeLevel !== "org" && p.role.scopeLevel !== "scoped")) throw new ForbiddenError();
}

export async function listApiKeys(ctx: TenantCtx): Promise<ApiKeyRow[]> {
  canManageKeys(ctx.principal);
  const now = Date.now();
  const rows = await tenantTx(ctx, (tx) => tx.select({
    id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, permissions: apiKeys.permissions, propertyIds: apiKeys.propertyIds, createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt, requestsPerMinute: apiKeys.requestsPerMinute, createdByName: users.name,
  }).from(apiKeys).leftJoin(users, eq(users.id, apiKeys.createdByUserId)).where(eq(apiKeys.orgId, ctx.principal.orgId)).orderBy(sql`${apiKeys.revokedAt} is not null`, desc(apiKeys.createdAt)));
  return rows.map((r) => ({ ...r, expired: !!r.expiresAt && r.expiresAt.getTime() < now }));
}

// returns the full key once; it can't be shown again
export async function createApiKey(ctx: TenantCtx, input: z.input<typeof createApiKeySchema>): Promise<{ id: string; token: string; prefix: string }> {
  const p = ctx.principal;
  canManageKeys(p);
  await assertFeature(p.orgId, "api");
  const data = createApiKeySchema.parse(input);
  const scopes = [...new Set(data.scopes)];
  const unknown = scopes.filter((s) => !isApiScope(s));
  if (unknown.length) throw new ValidationError("Unknown permission.", "scopes");
  const missing = scopes.filter((s) => !p.permissions.has(s));
  if (missing.length) throw new ForbiddenError("You can't give a key permissions you don't have yourself.");
  const visible = visiblePropertyIds(p);
  const props = [...new Set(data.propertyIds)];
  if (visible && props.some((id) => !visible.includes(id))) throw new ForbiddenError("You can only limit a key to properties you manage.");
  if (p.role.scopeLevel === "scoped" && !props.length) throw new ValidationError("Choose the properties this key may use.", "propertyIds");
  const { token, prefix } = generateApiKey();
  return tenantTx(ctx, async (tx) => {
    if (props.length) {
      const found = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, p.orgId), inArray(properties.id, props)));
      if (found.length !== props.length) throw new ValidationError("Property not found.", "propertyIds");
    }
    const [k] = await tx.insert(apiKeys).values({
      orgId: p.orgId, name: data.name, prefix, keyHash: hashToken(token), createdByUserId: p.userId, permissions: scopes, propertyIds: props,
      expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86_400_000) : null,
    }).returning();
    await auditAs(tx, ctx, "api_key.created", "api_key", k.id, undefined, { name: k.name, prefix, permissions: scopes, propertyIds: props, expiresAt: k.expiresAt });
    return { id: k.id, token, prefix };
  });
}

export async function revokeApiKey(ctx: TenantCtx, id: string): Promise<void> {
  canManageKeys(ctx.principal);
  await tenantTx(ctx, async (tx) => {
    const [k] = await tx.update(apiKeys).set({ revokedAt: new Date(), revokedByUserId: ctx.principal.userId })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, ctx.principal.orgId), isNull(apiKeys.revokedAt))).returning();
    if (!k) throw new NotFoundError();
    await auditAs(tx, ctx, "api_key.revoked", "api_key", k.id, { name: k.name, prefix: k.prefix }, { revokedAt: k.revokedAt });
  });
}

/* ───────────── authenticating a request ───────────── */

export class ApiAuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

export type ApiCaller = { ctx: TenantCtx; key: typeof apiKeys.$inferSelect; orgSlug: string };

// the creator's principal, cut down to what the key allows (never more than either)
export function narrowPrincipal(base: Principal, key: Pick<typeof apiKeys.$inferSelect, "permissions" | "propertyIds">): Principal {
  const permissions = new Set(key.permissions.filter((x) => isApiScope(x) && base.permissions.has(x)));
  if (!key.propertyIds.length) return { ...base, permissions };
  const allowed = key.propertyIds.filter((id) => base.role.scopeLevel === "org" || base.propertyIds.has(id));
  // a property-limited key behaves like a property-scoped role over exactly those properties
  return {
    ...base, permissions, role: { ...base.role, scopeLevel: "scoped" },
    portfolioIds: new Set(), propertyIds: new Set(allowed), buildingIds: new Set(), partialPropertyIds: new Set(),
  };
}

export async function authenticateApiKey(token: string, meta: RequestMeta | null, now = new Date()): Promise<ApiCaller> {
  if (!looksLikeApiKey(token)) throw new ApiAuthError("Invalid API key.");
  const hash = hashToken(token);
  const [key] = await withContext({ apiKeyHash: hash }, (tx) => tx.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)));
  if (!key || key.revokedAt) throw new ApiAuthError("Invalid API key.");
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) throw new ApiAuthError("This API key has expired.");
  const [org] = await withContext({ orgId: key.orgId, system: true }, (tx) => tx.select({ slug: organizations.slug, status: organizations.status }).from(organizations).where(eq(organizations.id, key.orgId)));
  if (!org || org.status !== "active") throw new ApiAuthError("This organization is unavailable.", 403);
  const owner = await loadPrincipal(key.createdByUserId, org.slug);
  if (!owner) throw new ApiAuthError("The person who created this key no longer has access to the organization. Create a new key.", 403);
  // last-used is informational: write it at most once a minute per key
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
    await withContext({ orgId: key.orgId, system: true }, (tx) => tx.update(apiKeys).set({ lastUsedAt: now, lastUsedIp: meta?.ip ?? null }).where(eq(apiKeys.id, key.id))).catch(() => {});
  }
  return { ctx: { principal: narrowPrincipal(owner, key), meta, api: { keyId: key.id } }, key, orgSlug: org.slug };
}
