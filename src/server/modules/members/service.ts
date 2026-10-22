import "server-only";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, setTxOrg, withContext, type Tx } from "../../db/client";
import { buildings, invitations, membershipScopes, memberships, organizations, properties, residents, roles, users } from "../../db/schema";
import { authorize, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { writeAudit } from "../../audit";
import { generateToken, hashToken } from "../../auth/crypto";
import { hashPassword, passwordSchema } from "../../auth/password";
import { createSession, emailSchema, nameSchema } from "../../auth/service";
import { LIMITS, rateLimiter } from "../../auth/rate-limit";
import { sendEmail } from "../../mail/mailer";
import { invitationTemplate } from "../../mail/templates";
import { env } from "../../env";
import type { RequestMeta } from "../../request-meta";
import { ConflictError, tenantTx, ValidationError, type TenantCtx } from "../context";
import { assertNotReadOnly, assertWithinLimit, loadEntitlements } from "../../billing/entitlements";

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

// roles that can be granted via invitation in this iteration (resident/vendor linking arrives with their modules)
async function assignableRoles(tx: Tx, orgId: string) {
  const rows = await tx.select().from(roles).where(or(isNull(roles.orgId), eq(roles.orgId, orgId)));
  return rows.filter((r) => r.category === "staff");
}

export async function listAssignableRoles(ctx: TenantCtx) {
  authorize(ctx.principal, "member.manage");
  return tenantTx(ctx, async (tx) =>
    (await assignableRoles(tx, ctx.principal.orgId))
      .filter((r) => r.permissions.every((p) => ctx.principal.permissions.has(p)))
      .map((r) => ({ id: r.id, key: r.key, name: r.name, scopeLevel: r.scopeLevel, description: r.description })),
  );
}

export async function listRoles(ctx: TenantCtx) {
  authorize(ctx.principal, "role.read");
  return tenantTx(ctx, (tx) =>
    tx.select().from(roles).where(or(isNull(roles.orgId), eq(roles.orgId, ctx.principal.orgId))).orderBy(roles.category, roles.name),
  );
}

export async function listMembers(ctx: TenantCtx) {
  authorize(ctx.principal, "member.read");
  return tenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({
        membershipId: memberships.id, status: memberships.status, createdAt: memberships.createdAt,
        userId: users.id, name: users.name, email: users.email, lastLoginAt: users.lastLoginAt, mfaEnabled: users.mfaEnabled,
        roleKey: roles.key, roleName: roles.name, scopeLevel: roles.scopeLevel,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.orgId, ctx.principal.orgId)) // explicit filter in addition to RLS
      .orderBy(memberships.status, users.name);
    const scopes = rows.length
      ? await tx
          .select({ membershipId: membershipScopes.membershipId, propertyName: properties.name })
          .from(membershipScopes)
          .innerJoin(properties, eq(properties.id, membershipScopes.propertyId))
          .where(inArray(membershipScopes.membershipId, rows.map((r) => r.membershipId)))
      : [];
    return rows.map((r) => ({ ...r, scopes: scopes.filter((s) => s.membershipId === r.membershipId).map((s) => s.propertyName) }));
  });
}

export async function listPendingInvitations(ctx: TenantCtx) {
  authorize(ctx.principal, "member.manage");
  return tenantTx(ctx, (tx) =>
    tx
      .select({ id: invitations.id, email: invitations.email, roleName: roles.name, propertyName: properties.name, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .leftJoin(properties, eq(properties.id, invitations.propertyId))
      .where(and(eq(invitations.orgId, ctx.principal.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
      .orderBy(desc(invitations.createdAt)),
  );
}

export const inviteSchema = z.object({
  email: emailSchema,
  roleId: z.string().uuid("Choose a role."),
  propertyId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
});

// validates role grantability and scope; prevents privilege escalation
async function resolveGrant(ctx: TenantCtx, tx: Tx, roleId: string, propertyId: string | undefined) {
  const role = (await assignableRoles(tx, ctx.principal.orgId)).find((r) => r.id === roleId);
  if (!role) throw new ValidationError("That role can't be assigned here.", "roleId");
  if (!role.permissions.every((p) => ctx.principal.permissions.has(p))) throw new ForbiddenError("You can't grant a role with more access than your own.");
  // a manager who isn't organization-wide can't hand out organization-wide access (finding F-03)
  if (ctx.principal.role.scopeLevel !== "org" && role.scopeLevel !== "scoped") throw new ForbiddenError("You can only grant roles limited to properties you manage.");
  if (role.scopeLevel === "scoped") {
    if (!propertyId) throw new ValidationError("Choose the property this person will manage.", "propertyId");
    const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.orgId, ctx.principal.orgId)));
    if (!prop) throw new ValidationError("Property not found.", "propertyId");
    // full access to the property, not the read-only view a building-level scope gives of its parent
    if (ctx.principal.role.scopeLevel !== "org" && !ctx.principal.propertyIds.has(propertyId)) throw new ForbiddenError("You can only grant access to properties you manage.");
  }
  return { role, propertyId: role.scopeLevel === "scoped" ? propertyId! : null };
}

// organization-wide managers manage anyone; others only members whose whole scope sits inside their own (F-03)
async function assertManagesMember(tx: Tx, p: Principal, membershipId: string, scopeLevel: string) {
  if (p.role.scopeLevel === "org") return;
  if (scopeLevel !== "scoped") throw new ForbiddenError("You can only manage members limited to properties you manage.");
  const scopes = await tx.select({ portfolioId: membershipScopes.portfolioId, propertyId: membershipScopes.propertyId, buildingPropertyId: buildings.propertyId })
    .from(membershipScopes).leftJoin(buildings, eq(buildings.id, membershipScopes.buildingId)).where(eq(membershipScopes.membershipId, membershipId));
  const inside = scopes.every((s) => (s.portfolioId ? p.portfolioIds.has(s.portfolioId) : p.propertyIds.has((s.propertyId ?? s.buildingPropertyId)!)));
  if (!scopes.length || !inside) throw new ForbiddenError("You can only manage members limited to properties you manage.");
}

export async function inviteMember(ctx: TenantCtx, input: z.infer<typeof inviteSchema>) {
  authorize(ctx.principal, "member.manage");
  const rl = await rateLimiter().hit(`invite:${ctx.principal.orgId}`, LIMITS.invite.limit, LIMITS.invite.windowMs);
  if (!rl.allowed) throw new ValidationError("Too many invitations sent recently. Try again later.");

  const token = generateToken();
  const { orgName, roleName } = await tenantTx(ctx, async (tx) => {
    const { role, propertyId } = await resolveGrant(ctx, tx, input.roleId, input.propertyId);
    const existing = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.principal.orgId), eq(users.email, input.email)));
    if (existing.length) throw new ConflictError("This person is already a member of the organization.");
    // replace any pending invitation for the same email
    await tx.update(invitations).set({ revokedAt: new Date() })
      .where(and(eq(invitations.orgId, ctx.principal.orgId), eq(invitations.email, input.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    // staff seats are a plan limit; resident and vendor invitations are free
    if (role.category === "staff") await assertWithinLimit(tx, ctx.principal.orgId, "staff_seats");
    else await assertNotReadOnly(await loadEntitlements(tx, ctx.principal.orgId));
    const [inv] = await tx.insert(invitations).values({
      orgId: ctx.principal.orgId, email: input.email, roleId: role.id, propertyId,
      tokenHash: hashToken(token), invitedBy: ctx.principal.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }).returning();
    await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "member.invited", entityType: "invitation", entityId: inv.id, after: { email: input.email, role: role.key, propertyId } }, ctx.meta);
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.principal.orgId));
    return { orgName: org.name, roleName: role.name };
  });
  const inviter = await db().query.users.findFirst({ where: eq(users.id, ctx.principal.userId), columns: { name: true } });
  await sendEmail(input.email, invitationTemplate(orgName, roleName, inviter?.name ?? "A teammate", `${env().APP_URL}/invite/${token}`));
  return { ok: true as const };
}

export async function revokeInvitation(ctx: TenantCtx, invitationId: string) {
  authorize(ctx.principal, "member.manage");
  await tenantTx(ctx, async (tx) => {
    const [inv] = await tx.update(invitations).set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), eq(invitations.orgId, ctx.principal.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt))).returning();
    if (!inv) throw new NotFoundError();
    await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "member.invitation_revoked", entityType: "invitation", entityId: inv.id, before: { email: inv.email } }, ctx.meta);
  });
}

export type InvitationPreview = { email: string; orgName: string; roleName: string; propertyName: string | null; userExists: boolean };

// looks up an invitation by its secret token; RLS permits exactly this row via app.invite_token_hash
export async function getInvitation(token: string): Promise<InvitationPreview | null> {
  const tokenHash = hashToken(token);
  const row = await withContext({ inviteTokenHash: tokenHash }, async (tx) => {
    const [inv] = await tx.select().from(invitations)
      .where(and(eq(invitations.tokenHash, tokenHash), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
    if (!inv) return null;
    await setTxOrg(tx, inv.orgId);
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.orgId));
    const [role] = await tx.select({ name: roles.name }).from(roles).where(eq(roles.id, inv.roleId));
    const prop = inv.propertyId ? (await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, inv.propertyId)))[0] : null;
    return { email: inv.email, orgName: org.name, roleName: role.name, propertyName: prop?.name ?? null };
  });
  if (!row) return null;
  const u = await db().query.users.findFirst({ where: eq(users.email, row.email), columns: { id: true } });
  return { ...row, userExists: !!u };
}

async function consumeInvitation(token: string, userId: string, userEmail: string, meta: RequestMeta | null): Promise<{ orgSlug: string }> {
  const tokenHash = hashToken(token);
  return withContext({ inviteTokenHash: tokenHash, userId }, async (tx) => {
    const [inv] = await tx.update(invitations).set({ acceptedAt: new Date() })
      .where(and(eq(invitations.tokenHash, tokenHash), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
      .returning();
    if (!inv) throw new ValidationError("This invitation is invalid, expired or already used.");
    if (inv.email !== userEmail) throw new ForbiddenError(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    await setTxOrg(tx, inv.orgId);
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, inv.orgId));
    if (org.status !== "active") throw new ForbiddenError("This organization is not active.");
    const [existing] = await tx.select().from(memberships).where(and(eq(memberships.orgId, inv.orgId), eq(memberships.userId, userId)));
    if (existing) throw new ConflictError("You're already a member of this organization.");
    // resident invites link the login to the resident record (which carries their unit occupancy)
    if (inv.residentId) {
      const linked = await tx.update(residents).set({ userId })
        .where(and(eq(residents.id, inv.residentId), eq(residents.orgId, inv.orgId), isNull(residents.userId))).returning({ id: residents.id });
      if (!linked.length) throw new ConflictError("This resident record is already linked to an account.");
    }
    const [m] = await tx.insert(memberships).values({ orgId: inv.orgId, userId, roleId: inv.roleId, vendorId: inv.vendorId }).returning();
    if (inv.propertyId) await tx.insert(membershipScopes).values({ orgId: inv.orgId, membershipId: m.id, propertyId: inv.propertyId });
    await writeAudit(tx, { orgId: inv.orgId, actorUserId: userId, action: "member.joined", entityType: "membership", entityId: m.id, after: { invitationId: inv.id, roleId: inv.roleId, propertyId: inv.propertyId } }, meta);
    return { orgSlug: org.slug };
  });
}

// signed-in user accepts an invitation addressed to their email
export async function acceptInvitation(token: string, userId: string, meta: RequestMeta | null) {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new ForbiddenError();
  const result = await consumeInvitation(token, userId, user.email, meta);
  // the emailed token proves ownership of the address
  if (!user.emailVerifiedAt) await db().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
  return result;
}

export const acceptNewUserSchema = z.object({ name: nameSchema, password: passwordSchema });

// new user signs up through an invitation: account is created pre-verified
export async function acceptInvitationAsNewUser(token: string, input: z.infer<typeof acceptNewUserSchema>, meta: RequestMeta | null) {
  const preview = await getInvitation(token);
  if (!preview) throw new ValidationError("This invitation is invalid, expired or already used.");
  if (preview.userExists) throw new ConflictError("An account with this email already exists. Sign in to accept.");
  const [user] = await db().insert(users).values({
    email: preview.email, name: input.name, passwordHash: await hashPassword(input.password), emailVerifiedAt: new Date(),
  }).returning();
  try {
    const { orgSlug } = await consumeInvitation(token, user.id, user.email, meta);
    const sessionToken = await createSession(user.id, meta);
    return { orgSlug, sessionToken };
  } catch (e) {
    await db().delete(users).where(eq(users.id, user.id)); // roll back the orphan account
    throw e;
  }
}

async function activeAdminCount(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(roles.key, "org_admin")));
  return r.n;
}

export const changeRoleSchema = z.object({
  membershipId: z.string().uuid(),
  roleId: z.string().uuid(),
  propertyId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
});

export async function changeMemberRole(ctx: TenantCtx, input: z.infer<typeof changeRoleSchema>) {
  authorize(ctx.principal, "member.manage");
  if (input.membershipId === ctx.principal.membershipId) throw new ForbiddenError("You can't change your own role.");
  await tenantTx(ctx, async (tx) => {
    const [m] = await tx.select({ m: memberships, roleKey: roles.key }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId)).where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, ctx.principal.orgId)));
    if (!m) throw new NotFoundError();
    const currentRole = (await tx.select().from(roles).where(eq(roles.id, m.m.roleId)))[0];
    if (!currentRole.permissions.every((p) => ctx.principal.permissions.has(p))) throw new ForbiddenError("You can't modify a member with more access than your own.");
    await assertManagesMember(tx, ctx.principal, m.m.id, currentRole.scopeLevel);
    const { role, propertyId } = await resolveGrant(ctx, tx, input.roleId, input.propertyId);
    if (m.roleKey === "org_admin" && role.key !== "org_admin" && (await activeAdminCount(tx, ctx.principal.orgId)) <= 1) {
      throw new ValidationError("An organization needs at least one admin.");
    }
    await tx.update(memberships).set({ roleId: role.id }).where(eq(memberships.id, m.m.id));
    await tx.delete(membershipScopes).where(eq(membershipScopes.membershipId, m.m.id));
    if (propertyId) await tx.insert(membershipScopes).values({ orgId: ctx.principal.orgId, membershipId: m.m.id, propertyId });
    await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "member.role_changed", entityType: "membership", entityId: m.m.id, before: { role: m.roleKey }, after: { role: role.key, propertyId } }, ctx.meta);
  });
}

export async function setMemberStatus(ctx: TenantCtx, membershipId: string, status: "active" | "deactivated") {
  authorize(ctx.principal, "member.manage");
  if (membershipId === ctx.principal.membershipId) throw new ForbiddenError("You can't deactivate yourself.");
  await tenantTx(ctx, async (tx) => {
    const [m] = await tx.select({ m: memberships, role: roles }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId)).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.principal.orgId)));
    if (!m) throw new NotFoundError();
    if (!m.role.permissions.every((p) => ctx.principal.permissions.has(p))) throw new ForbiddenError();
    await assertManagesMember(tx, ctx.principal, m.m.id, m.role.scopeLevel);
    if (status === "deactivated" && m.role.key === "org_admin" && m.m.status === "active" && (await activeAdminCount(tx, ctx.principal.orgId)) <= 1) {
      throw new ValidationError("An organization needs at least one active admin.");
    }
    await tx.update(memberships).set({ status }).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.principal.orgId), ne(memberships.status, status)));
    await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: status === "active" ? "member.reactivated" : "member.deactivated", entityType: "membership", entityId: membershipId, before: { status: m.m.status }, after: { status } }, ctx.meta);
  });
}

export async function listPropertiesForPicker(ctx: TenantCtx) {
  authorize(ctx.principal, "member.manage");
  return tenantTx(ctx, (tx) => tx.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.orgId, ctx.principal.orgId)).orderBy(properties.name));
}
