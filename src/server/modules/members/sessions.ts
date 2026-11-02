import "server-only";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { memberships, sessions, ssoConnections, users } from "@/server/db/schema";
import { withContext } from "@/server/db/client";
import { authorize, ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { auditAs, tenantTx, type TenantCtx } from "../context";

// Who is signed in, for organization admins (Iteration 12). A person's sessions aren't tied to one organization, so
// signing someone out reaches every organization they use. For people who belong only here, an admin can end all of
// their sessions; for people who also belong to other organizations, only sessions started through this
// organization's single sign-on. Deactivating a membership already shuts someone out of this organization at once.

export type MemberSessions = {
  membershipId: string; userId: string; name: string; email: string; elsewhere: boolean;
  sessions: { createdAt: Date; lastSeenAt: Date; userAgent: string | null; ip: string | null; methods: string[]; viaOurSso: boolean }[];
};

async function ourConnections(tx: Parameters<Parameters<typeof tenantTx>[1]>[0], orgId: string) {
  return (await tx.select({ id: ssoConnections.id }).from(ssoConnections).where(eq(ssoConnections.orgId, orgId))).map((c) => c.id);
}

// people who also hold an active membership somewhere else (read across organizations: counts only)
async function alsoElsewhere(orgId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await withContext({ platformAdmin: true }, (tx) => tx.selectDistinct({ userId: memberships.userId }).from(memberships)
    .where(and(inArray(memberships.userId, userIds), ne(memberships.orgId, orgId), eq(memberships.status, "active"))));
  return new Set(rows.map((r) => r.userId));
}

export async function listMemberSessions(ctx: TenantCtx): Promise<MemberSessions[]> {
  authorize(ctx.principal, "security.manage");
  const p = ctx.principal;
  const { rows, ours } = await tenantTx(ctx, async (tx) => ({
    ours: await ourConnections(tx, p.orgId),
    rows: await tx.select({
      membershipId: memberships.id, userId: users.id, name: users.name, email: users.email,
      createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, userAgent: sessions.userAgent, ip: sql<string | null>`host(${sessions.ip})`, amr: sessions.amr, sso: sessions.ssoConnectionId,
    }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(sessions, eq(sessions.userId, memberships.userId))
      .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), gt(sessions.expiresAt, new Date())))
      .orderBy(users.name, sql`${sessions.lastSeenAt} desc`),
  }));
  const elsewhere = await alsoElsewhere(p.orgId, [...new Set(rows.map((r) => r.userId))]);
  const byMember = new Map<string, MemberSessions>();
  for (const r of rows) {
    const m = byMember.get(r.membershipId) ?? { membershipId: r.membershipId, userId: r.userId, name: r.name, email: r.email, elsewhere: elsewhere.has(r.userId), sessions: [] };
    m.sessions.push({ createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, userAgent: r.userAgent, ip: r.ip, methods: r.amr, viaOurSso: !!r.sso && ours.includes(r.sso) });
    byMember.set(r.membershipId, m);
  }
  return [...byMember.values()];
}

export async function signOutMember(ctx: TenantCtx, membershipId: string): Promise<{ ended: number; kept: number }> {
  authorize(ctx.principal, "security.manage");
  const p = ctx.principal;
  const [m] = await tenantTx(ctx, (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, p.orgId))));
  if (!m) throw new NotFoundError();
  if (m.userId === p.userId) throw new ForbiddenError("Sign out of your own devices from your account's security page.");
  const elsewhere = (await alsoElsewhere(p.orgId, [m.userId])).has(m.userId);
  return tenantTx(ctx, async (tx) => {
    const ours = await ourConnections(tx, p.orgId);
    const all = await tx.select({ id: sessions.id, sso: sessions.ssoConnectionId }).from(sessions).where(eq(sessions.userId, m.userId));
    const target = elsewhere ? all.filter((s) => s.sso && ours.includes(s.sso)) : all;
    if (target.length) await tx.delete(sessions).where(inArray(sessions.id, target.map((s) => s.id)));
    await auditAs(tx, ctx, "session.revoked_by_admin", "membership", membershipId, undefined, { ended: target.length, kept: all.length - target.length, scope: elsewhere ? "this organization's SSO sessions" : "all sessions" });
    return { ended: target.length, kept: all.length - target.length };
  });
}
