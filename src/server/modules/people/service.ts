import "server-only";
import { and, asc, count, desc, eq, exists, gt, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildings, invitations, membershipScopes, memberships, organizations, portfolios, properties, residents, roles, staffProfiles,
  unitOccupancies, units, users,
} from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, scopeFilter } from "../../authz/authorize";
import { auditAs, blankToNull, tenantTx, ValidationError, ConflictError, type TenantCtx } from "../context";
import { matches, pageArgs, scopeCondition, toPage, toPrefixQuery, type Page } from "../scope";
import { generateToken, hashToken } from "../../auth/crypto";
import { sendEmail } from "../../mail/mailer";
import { invitationTemplate } from "../../mail/templates";
import { env } from "../../env";
import type { Tx } from "../../db/client";

export const RELATIONSHIPS = ["resident", "tenant", "owner", "occupant"] as const;
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

const optText = (max = 200) => z.string().trim().max(max).optional().transform(blankToNull);
const optEmail = z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email.").max(254)]).optional().transform((v) => (v ? v : null));
const optDate = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")]).optional().transform((v) => (v ? v : null));

const isActive = or(isNull(unitOccupancies.endsOn), gte(unitOccupancies.endsOn, sql`current_date`));

/* ───────────── residents ───────────── */

export const residentSchema = z.object({
  firstName: z.string().trim().min(1, "Enter a first name.").max(80),
  lastName: z.string().trim().min(1, "Enter a last name.").max(80),
  email: optEmail,
  phone: optText(40),
  notes: optText(2000),
});

export const occupancySchema = z.object({
  buildingId: z.string().uuid("Choose a building."),
  unitNumber: z.string().trim().min(1, "Enter the unit number.").max(20),
  relationship: z.enum(RELATIONSHIPS),
  isPrimary: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
  startsOn: optDate,
});

// rows visible to the principal: residents with an active occupancy in scope (org-wide roles see all)
function residentScope(ctx: TenantCtx) {
  const p = ctx.principal;
  if (p.role.scopeLevel === "org") return undefined;
  return exists(
    sql`(select 1 from ${unitOccupancies} o join ${units} u on u.id = o.unit_id
         where o.resident_id = residents.id and (o.ends_on is null or o.ends_on >= current_date)
         and ${scopeCondition(p, { property: sql.raw("u.property_id"), building: sql.raw("u.building_id") }) ?? sql`true`})`,
  );
}

async function resolveUnit(tx: Tx, orgId: string, buildingId: string, unitNumber: string) {
  const [u] = await tx.select().from(units).where(and(eq(units.orgId, orgId), eq(units.buildingId, buildingId), sql`lower(${units.number}) = lower(${unitNumber})`));
  if (!u) throw new ValidationError(`No unit ${unitNumber} in that building.`, "unitNumber");
  return u;
}

async function loadResident(ctx: TenantCtx, tx: Tx, id: string, perm: "resident.read" | "resident.manage") {
  const p = ctx.principal;
  const [r] = await tx.select().from(residents).where(and(eq(residents.id, id), eq(residents.orgId, p.orgId), residentScope(ctx)));
  if (!r) {
    // exists but out of scope → forbidden only if it's in this org; otherwise not found
    throw new NotFoundError();
  }
  if (!p.permissions.has(perm)) throw new ForbiddenError();
  return r;
}

export type ResidentRow = {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null; hasLogin: boolean;
  units: string | null; relationship: string | null;
};

export async function listResidents(
  ctx: TenantCtx,
  opts: { q?: string; propertyId?: string; relationship?: string; status?: "current" | "past" | "all"; page?: number },
): Promise<Page<ResidentRow>> {
  const p = ctx.principal;
  authorize(p, "resident.read");
  const { page, pageSize, offset } = pageArgs(opts.page);
  const tsq = toPrefixQuery(opts.q);
  const status = opts.status ?? "current";
  const occFilter = and(
    opts.propertyId ? sql`u.property_id = ${opts.propertyId}` : undefined,
    opts.relationship && (RELATIONSHIPS as readonly string[]).includes(opts.relationship) ? sql`o.relationship = ${opts.relationship}` : undefined,
  );
  const hasCurrent = sql`exists (select 1 from unit_occupancies o join units u on u.id = o.unit_id where o.resident_id = residents.id
    and (o.ends_on is null or o.ends_on >= current_date) ${occFilter ? sql`and ${occFilter}` : sql``})`;
  const hasAny = sql`exists (select 1 from unit_occupancies o join units u on u.id = o.unit_id where o.resident_id = residents.id ${occFilter ? sql`and ${occFilter}` : sql``})`;
  return tenantTx(ctx, async (tx) => {
    const where = and(
      eq(residents.orgId, p.orgId),
      residentScope(ctx),
      tsq ? matches("residents", tsq) : undefined,
      status === "current" ? hasCurrent : status === "past" ? and(hasAny, sql`not ${hasCurrent}`) : occFilter ? hasAny : undefined,
    );
    const [{ n }] = await tx.select({ n: count() }).from(residents).where(where);
    const rows = await tx
      .select({
        id: residents.id, firstName: residents.firstName, lastName: residents.lastName, email: residents.email, phone: residents.phone,
        hasLogin: sql<boolean>`${residents.userId} is not null`,
        units: sql<string | null>`(select string_agg(pr.code || ' ' || b.code || '-' || u.number, ', ' order by u.number)
          from unit_occupancies o join units u on u.id = o.unit_id join buildings b on b.id = u.building_id join properties pr on pr.id = u.property_id
          where o.resident_id = residents.id and (o.ends_on is null or o.ends_on >= current_date))`,
        relationship: sql<string | null>`(select o.relationship from unit_occupancies o where o.resident_id = residents.id
          and (o.ends_on is null or o.ends_on >= current_date) order by o.is_primary desc limit 1)`,
      })
      .from(residents).where(where)
      .orderBy(asc(residents.lastName), asc(residents.firstName))
      .limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export async function getResident(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const r = await loadResident(ctx, tx, id, "resident.read");
    const occ = await tx
      .select({
        id: unitOccupancies.id, unitId: units.id, unitNumber: units.number, buildingId: buildings.id, buildingName: buildings.name,
        propertyId: properties.id, propertyName: properties.name, relationship: unitOccupancies.relationship, isPrimary: unitOccupancies.isPrimary,
        startsOn: unitOccupancies.startsOn, endsOn: unitOccupancies.endsOn,
        active: sql<boolean>`(${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date)`,
      })
      .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId))
      .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(eq(unitOccupancies.residentId, id), scopeCondition(p, { property: units.propertyId, building: units.buildingId })))
      .orderBy(desc(sql`(${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date)`), desc(unitOccupancies.startsOn));
    const [pendingInvite] = await tx.select({ id: invitations.id, expiresAt: invitations.expiresAt }).from(invitations)
      .where(and(eq(invitations.residentId, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
    const manageable = occ.some((o) => o.active && can(p, "resident.manage", { orgId: p.orgId, propertyId: o.propertyId, buildingId: o.buildingId }))
      || (p.role.scopeLevel === "org" && p.permissions.has("resident.manage"));
    return { resident: r, occupancies: occ, pendingInvite: pendingInvite ?? null, canManage: manageable };
  });
}

// scoped managers can only act on residents living in their properties
async function assertCanManageResident(ctx: TenantCtx, tx: Tx, residentId: string) {
  const p = ctx.principal;
  await loadResident(ctx, tx, residentId, "resident.manage");
  if (p.role.scopeLevel === "org") return;
  const occ = await tx.select({ propertyId: units.propertyId, buildingId: units.buildingId }).from(unitOccupancies)
    .innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(and(eq(unitOccupancies.residentId, residentId), isActive));
  if (!occ.some((o) => can(p, "resident.manage", { orgId: p.orgId, propertyId: o.propertyId, buildingId: o.buildingId }))) throw new ForbiddenError();
}

export async function createResident(
  ctx: TenantCtx, input: z.infer<typeof residentSchema>, occupancy: z.infer<typeof occupancySchema> | null,
) {
  const p = ctx.principal;
  authorize(p, "resident.read");
  if (!occupancy && p.role.scopeLevel !== "org") throw new ValidationError("Choose the unit this resident lives in.", "unitNumber");
  return tenantTx(ctx, async (tx) => {
    let unit: typeof units.$inferSelect | null = null;
    if (occupancy) {
      unit = await resolveUnit(tx, p.orgId, occupancy.buildingId, occupancy.unitNumber);
      authorize(p, "resident.manage", { orgId: p.orgId, propertyId: unit.propertyId, buildingId: unit.buildingId });
    } else authorize(p, "resident.manage");
    const [row] = await tx.insert(residents).values({ orgId: p.orgId, ...input }).returning();
    if (unit && occupancy) {
      await tx.insert(unitOccupancies).values({
        orgId: p.orgId, unitId: unit.id, residentId: row.id, relationship: occupancy.relationship, isPrimary: occupancy.isPrimary,
        startsOn: occupancy.startsOn ?? sql`current_date` as unknown as string,
      });
      if (unit.status === "vacant") await tx.update(units).set({ status: "occupied" }).where(eq(units.id, unit.id));
    }
    await auditAs(tx, ctx, "resident.created", "resident", row.id, undefined, { ...row, unitId: unit?.id ?? null });
    return row;
  });
}

export async function updateResident(ctx: TenantCtx, id: string, input: z.infer<typeof residentSchema>) {
  return tenantTx(ctx, async (tx) => {
    await assertCanManageResident(ctx, tx, id);
    const [before] = await tx.select().from(residents).where(eq(residents.id, id));
    // a linked login's email is owned by the user account
    if (before.userId && input.email !== before.email) throw new ValidationError("This resident signs in with their email; it can't be changed here.", "email");
    const [after] = await tx.update(residents).set(input).where(eq(residents.id, id)).returning();
    await auditAs(tx, ctx, "resident.updated", "resident", id, before, after);
    return after;
  });
}

export async function addOccupancy(ctx: TenantCtx, residentId: string, input: z.infer<typeof occupancySchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await loadResident(ctx, tx, residentId, "resident.manage");
    const unit = await resolveUnit(tx, p.orgId, input.buildingId, input.unitNumber);
    authorize(p, "resident.manage", { orgId: p.orgId, propertyId: unit.propertyId, buildingId: unit.buildingId });
    const [dup] = await tx.select({ id: unitOccupancies.id }).from(unitOccupancies).where(and(eq(unitOccupancies.residentId, residentId), eq(unitOccupancies.unitId, unit.id), isActive));
    if (dup) throw new ConflictError("This resident already lives in that unit.");
    const [row] = await tx.insert(unitOccupancies).values({
      orgId: p.orgId, unitId: unit.id, residentId, relationship: input.relationship, isPrimary: input.isPrimary,
      startsOn: input.startsOn ?? sql`current_date` as unknown as string,
    }).returning();
    if (unit.status === "vacant") await tx.update(units).set({ status: "occupied" }).where(eq(units.id, unit.id));
    await auditAs(tx, ctx, "resident.moved_in", "unit_occupancy", row.id, undefined, row);
    return row;
  });
}

export const moveOutSchema = z.object({ endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.") });

// records a move-out; the unit becomes vacant when nobody remains
export async function endOccupancy(ctx: TenantCtx, occupancyId: string, endsOn: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [o] = await tx.select({ occ: unitOccupancies, unit: units }).from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId))
      .where(and(eq(unitOccupancies.id, occupancyId), eq(unitOccupancies.orgId, p.orgId)));
    if (!o) throw new NotFoundError();
    authorize(p, "resident.manage", { orgId: p.orgId, propertyId: o.unit.propertyId, buildingId: o.unit.buildingId });
    if (o.occ.startsOn && endsOn < o.occ.startsOn) throw new ValidationError("Move-out can't be before move-in.", "endsOn");
    await tx.update(unitOccupancies).set({ endsOn }).where(eq(unitOccupancies.id, occupancyId));
    const [{ n }] = await tx.select({ n: count() }).from(unitOccupancies)
      .where(and(eq(unitOccupancies.unitId, o.unit.id), or(isNull(unitOccupancies.endsOn), gt(unitOccupancies.endsOn, sql`${endsOn}::date`))));
    if (n === 0 && o.unit.status === "occupied") await tx.update(units).set({ status: "vacant" }).where(eq(units.id, o.unit.id));
    await auditAs(tx, ctx, "resident.moved_out", "unit_occupancy", occupancyId, { endsOn: o.occ.endsOn }, { endsOn });
    return o.occ.residentId;
  });
}

export async function deleteResident(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    await assertCanManageResident(ctx, tx, id);
    const [before] = await tx.select().from(residents).where(eq(residents.id, id));
    if (before.userId) {
      // remove their resident access in this org too
      await tx.update(memberships).set({ status: "deactivated" }).where(and(eq(memberships.orgId, p.orgId), eq(memberships.userId, before.userId)));
    }
    await tx.delete(residents).where(eq(residents.id, id));
    await auditAs(tx, ctx, "resident.deleted", "resident", id, before);
  });
}

// emails the resident an invitation to the resident app, role taken from their primary occupancy
export async function inviteResident(ctx: TenantCtx, residentId: string) {
  const p = ctx.principal;
  const token = generateToken();
  const { email, orgName, roleName } = await tenantTx(ctx, async (tx) => {
    await assertCanManageResident(ctx, tx, residentId);
    const [r] = await tx.select().from(residents).where(eq(residents.id, residentId));
    if (!r.email) throw new ValidationError("Add an email address first.");
    if (r.userId) throw new ConflictError("This resident already has app access.");
    const [occ] = await tx.select({ relationship: unitOccupancies.relationship }).from(unitOccupancies)
      .where(and(eq(unitOccupancies.residentId, residentId), isActive)).orderBy(desc(unitOccupancies.isPrimary)).limit(1);
    if (!occ) throw new ValidationError("Only current residents can be invited.");
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, occ.relationship)));
    const [existing] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, p.orgId), eq(users.email, r.email)));
    if (existing) throw new ConflictError("Someone with this email is already a member of the organization.");
    await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.residentId, residentId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const [inv] = await tx.insert(invitations).values({
      orgId: p.orgId, email: r.email, roleId: role.id, residentId, tokenHash: hashToken(token), invitedBy: p.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }).returning();
    await auditAs(tx, ctx, "resident.invited", "invitation", inv.id, undefined, { residentId, email: r.email, role: role.key });
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.orgId));
    return { email: r.email, orgName: org.name, roleName: role.name };
  });
  const [inviter] = await tenantTx(ctx, (tx) => tx.select({ name: users.name }).from(users).where(eq(users.id, p.userId)));
  await sendEmail(email, invitationTemplate(orgName, roleName, inviter?.name ?? "Your building team", `${env().APP_URL}/invite/${token}`));
}

/* ───────────── staff directory ───────────── */

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "on_call"] as const;

export const staffProfileSchema = z.object({
  title: optText(120),
  phone: optText(40),
  skills: z.string().max(500).optional().transform((v) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20)),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  notes: optText(2000),
});

export type StaffRow = {
  membershipId: string; userId: string; name: string; email: string; title: string | null; roleName: string; roleKey: string;
  status: string; phone: string | null; skills: string[]; employmentType: string | null; scopes: string[];
};

export async function listStaff(ctx: TenantCtx, opts: { q?: string; roleKey?: string; propertyId?: string } = {}): Promise<StaffRow[]> {
  const p = ctx.principal;
  authorize(p, "member.read");
  return tenantTx(ctx, async (tx) => {
    const q = opts.q?.trim();
    const rows = await tx
      .select({
        membershipId: memberships.id, userId: users.id, name: users.name, email: users.email, title: memberships.title,
        roleName: roles.name, roleKey: roles.key, status: memberships.status,
        phone: staffProfiles.phone, skills: staffProfiles.skills, employmentType: staffProfiles.employmentType,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .leftJoin(staffProfiles, eq(staffProfiles.membershipId, memberships.id))
      .where(and(
        eq(memberships.orgId, p.orgId), eq(roles.category, "staff"),
        q ? or(ilike(users.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`), ilike(users.email, `%${q.replace(/[%_\\]/g, "\\$&")}%`), sql`${q.toLowerCase()} = any(${staffProfiles.skills})`) : undefined,
        opts.roleKey ? eq(roles.key, opts.roleKey) : undefined,
      ))
      .orderBy(asc(memberships.status), asc(users.name))
      .limit(500);
    if (!rows.length) return [];
    const scopes = await tx
      .select({ membershipId: membershipScopes.membershipId, propertyId: membershipScopes.propertyId, label: sql<string>`coalesce(${properties.name}, ${portfolios.name} || ' (portfolio)', ${buildings.name})` })
      .from(membershipScopes)
      .leftJoin(properties, eq(properties.id, membershipScopes.propertyId))
      .leftJoin(portfolios, eq(portfolios.id, membershipScopes.portfolioId))
      .leftJoin(buildings, eq(buildings.id, membershipScopes.buildingId))
      .where(inArray(membershipScopes.membershipId, rows.map((r) => r.membershipId)));
    let out = rows.map((r) => ({ ...r, skills: r.skills ?? [], scopes: scopes.filter((s) => s.membershipId === r.membershipId).map((s) => s.label) }));
    if (opts.propertyId) {
      const pid = opts.propertyId;
      const withProp = new Set(scopes.filter((s) => s.propertyId === pid).map((s) => s.membershipId));
      out = out.filter((r) => withProp.has(r.membershipId) || r.scopes.length === 0);
    }
    return out;
  });
}

export async function getStaff(ctx: TenantCtx, membershipId: string) {
  const p = ctx.principal;
  const all = await listStaff(ctx);
  const row = all.find((r) => r.membershipId === membershipId);
  if (!row) throw new NotFoundError();
  const [profile] = await tenantTx(ctx, (tx) => tx.select().from(staffProfiles).where(eq(staffProfiles.membershipId, membershipId)));
  return { staff: row, notes: profile?.notes ?? null, canEdit: p.permissions.has("member.manage") || membershipId === p.membershipId };
}

// admins edit anyone's profile; staff can edit their own
export async function updateStaffProfile(ctx: TenantCtx, membershipId: string, input: z.infer<typeof staffProfileSchema>) {
  const p = ctx.principal;
  if (membershipId !== p.membershipId) authorize(p, "member.manage");
  return tenantTx(ctx, async (tx) => {
    const [m] = await tx.select({ m: memberships, category: roles.category }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, p.orgId)));
    if (!m || m.category !== "staff") throw new NotFoundError();
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.membershipId, membershipId));
    const values = { phone: input.phone, skills: input.skills, employmentType: input.employmentType, notes: input.notes };
    await tx.insert(staffProfiles).values({ orgId: p.orgId, membershipId, ...values })
      .onConflictDoUpdate({ target: staffProfiles.membershipId, set: values });
    await tx.update(memberships).set({ title: input.title }).where(eq(memberships.id, membershipId));
    await auditAs(tx, ctx, "staff.profile_updated", "membership", membershipId, before ? { ...before, title: m.m.title } : { title: m.m.title }, { ...values, title: input.title });
  });
}

/* ───────────── helpers for other modules ───────────── */

export async function residentCountsByStatus(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("resident.read")) return null;
  const f = scopeFilter(p);
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(distinct ${unitOccupancies.residentId})::int`, withLogin: sql<number>`count(distinct ${residents.id}) filter (where ${residents.userId} is not null)::int` })
      .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId)).innerJoin(residents, eq(residents.id, unitOccupancies.residentId))
      .where(and(isActive, f.kind === "all" ? undefined : scopeCondition(p, { property: units.propertyId, building: units.buildingId })));
    return r;
  });
}

