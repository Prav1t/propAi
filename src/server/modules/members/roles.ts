import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { invitations, memberships, roles } from "@/server/db/schema";
import { authorize, ForbiddenError, NotFoundError, type Principal } from "@/server/authz/authorize";
import { PERMISSIONS, type Permission } from "@/server/authz/permissions";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../context";

// Custom staff roles (Iteration 12). The same rules as handing out a role (finding F-03) apply to defining one:
// nobody can create or change a role to hold permissions they don't hold themselves, and someone whose own access
// is limited to some properties can only define roles limited to properties. System roles can't be edited.

// permissions that only make sense for residents and vendors (their "own"/"assigned" views) aren't offered for staff
export const STAFF_PERMISSIONS = (Object.keys(PERMISSIONS) as Permission[]).filter((k) => !/\.(own|assigned)$/.test(k));

export const roleSchema = z.object({
  name: z.string().trim().min(2, "Name the role.").max(60, "Up to 60 characters."),
  description: z.string().trim().max(200, "Up to 200 characters.").default(""),
  scopeLevel: z.enum(["org", "scoped"], { message: "Choose where the role applies." }),
  permissions: z.array(z.string()).min(1, "Choose at least one permission.").max(STAFF_PERMISSIONS.length),
});
export type RoleInput = z.infer<typeof roleSchema>;

function checkGrantable(p: Principal, input: RoleInput) {
  const unknown = input.permissions.filter((x) => !STAFF_PERMISSIONS.includes(x as Permission));
  if (unknown.length) throw new ValidationError("Some of those permissions don't exist.", "permissions");
  const beyond = input.permissions.filter((x) => !p.permissions.has(x));
  if (beyond.length) throw new ForbiddenError("You can't give a role access you don't have yourself.");
  if (p.role.scopeLevel !== "org" && input.scopeLevel !== "scoped") throw new ForbiddenError("You can only define roles limited to properties you manage.");
}

const keyFor = (name: string) => `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "role"}_${randomBytes(3).toString("hex")}`;

async function loadCustom(ctx: TenantCtx, tx: Parameters<Parameters<typeof tenantTx>[1]>[0], id: string) {
  const [r] = await tx.select().from(roles).where(and(eq(roles.id, id), eq(roles.orgId, ctx.principal.orgId)));
  if (!r) throw new NotFoundError();
  if (r.isSystem) throw new ForbiddenError("System roles can't be changed. Create a custom role instead.");
  return r;
}

export async function createRole(ctx: TenantCtx, raw: RoleInput) {
  authorize(ctx.principal, "role.manage");
  const input = roleSchema.parse(raw);
  checkGrantable(ctx.principal, input);
  const perms = [...new Set(input.permissions)].sort();
  return tenantTx(ctx, async (tx) => {
    const clash = await tx.select({ id: roles.id }).from(roles).where(and(or(isNull(roles.orgId), eq(roles.orgId, ctx.principal.orgId)), eq(roles.name, input.name)));
    if (clash.length) throw new ValidationError("A role with that name already exists.", "name");
    const [row] = await tx.insert(roles).values({
      orgId: ctx.principal.orgId, key: keyFor(input.name), name: input.name, description: input.description, category: "staff", scopeLevel: input.scopeLevel, isSystem: false, permissions: perms,
    }).returning();
    await auditAs(tx, ctx, "role.created", "role", row.id, undefined, { name: row.name, scopeLevel: row.scopeLevel, permissions: perms });
    return row;
  });
}

export async function updateRole(ctx: TenantCtx, id: string, raw: RoleInput) {
  authorize(ctx.principal, "role.manage");
  const input = roleSchema.parse(raw);
  checkGrantable(ctx.principal, input);
  const perms = [...new Set(input.permissions)].sort();
  return tenantTx(ctx, async (tx) => {
    const before = await loadCustom(ctx, tx, id);
    // someone limited to some properties can't change (or strip) a role that reaches further than they do
    if (ctx.principal.role.scopeLevel !== "org" && (before.scopeLevel !== "scoped" || !before.permissions.every((x) => ctx.principal.permissions.has(x)))) {
      throw new ForbiddenError("You can only change roles within your own access.");
    }
    const [{ n }] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.roleId, id), eq(memberships.orgId, ctx.principal.orgId)));
    // changing where a role applies would silently widen or remove people's access: make a new role instead
    if (n > 0 && before.scopeLevel !== input.scopeLevel) throw new ValidationError(`${n} ${n === 1 ? "person has" : "people have"} this role. Create a new role to change where it applies.`, "scopeLevel");
    const clash = await tx.select({ id: roles.id }).from(roles).where(and(or(isNull(roles.orgId), eq(roles.orgId, ctx.principal.orgId)), eq(roles.name, input.name)));
    if (clash.some((c) => c.id !== id)) throw new ValidationError("A role with that name already exists.", "name");
    const [after] = await tx.update(roles).set({ name: input.name, description: input.description, scopeLevel: input.scopeLevel, permissions: perms, updatedAt: new Date() })
      .where(eq(roles.id, id)).returning();
    const added = perms.filter((x) => !before.permissions.includes(x));
    const removed = before.permissions.filter((x) => !perms.includes(x));
    await auditAs(tx, ctx, "role.updated", "role", id, { name: before.name, scopeLevel: before.scopeLevel, permissions: before.permissions }, { name: after.name, scopeLevel: after.scopeLevel, added, removed, members: n });
    return { role: after, members: n, added, removed };
  });
}

export async function deleteRole(ctx: TenantCtx, id: string) {
  authorize(ctx.principal, "role.manage");
  return tenantTx(ctx, async (tx) => {
    const before = await loadCustom(ctx, tx, id);
    if (ctx.principal.role.scopeLevel !== "org" && !before.permissions.every((x) => ctx.principal.permissions.has(x))) throw new ForbiddenError("You can only delete roles within your own access.");
    const [{ m }] = await tx.select({ m: count() }).from(memberships).where(and(eq(memberships.roleId, id), eq(memberships.orgId, ctx.principal.orgId)));
    const [{ i }] = await tx.select({ i: count() }).from(invitations).where(and(eq(invitations.roleId, id), eq(invitations.orgId, ctx.principal.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if (m > 0 || i > 0) throw new ValidationError(`Move ${m + i === 1 ? "the person" : `the ${m + i} people`} with this role (or pending invitations) to another role first.`);
    await tx.delete(roles).where(eq(roles.id, id));
    await auditAs(tx, ctx, "role.deleted", "role", id, { name: before.name, permissions: before.permissions }, undefined);
  });
}

export async function getCustomRole(ctx: TenantCtx, id: string) {
  authorize(ctx.principal, "role.read");
  return tenantTx(ctx, async (tx) => {
    const r = await loadCustom(ctx, tx, id);
    const [{ n }] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.roleId, id), eq(memberships.orgId, ctx.principal.orgId)));
    return { ...r, members: n };
  });
}

// members per role, for the roles page
export async function roleMemberCounts(ctx: TenantCtx) {
  authorize(ctx.principal, "role.read");
  return tenantTx(ctx, async (tx) => Object.fromEntries((await tx.select({ roleId: memberships.roleId, n: count() }).from(memberships)
    .where(eq(memberships.orgId, ctx.principal.orgId)).groupBy(memberships.roleId)).map((r) => [r.roleId, r.n])));
}
