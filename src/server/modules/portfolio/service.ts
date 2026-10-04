import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, or, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildings, floors, membershipScopes, memberships, portfolios, properties, residents, unitOccupancies, units, users,
  vendorProperties, vendors,
} from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError } from "../../authz/authorize";
import { auditAs, blankToNull, friendlyUnique, tenantTx, ValidationError, type TenantCtx } from "../context";
import { matches, pageArgs, scopeCondition, toPage, toPrefixQuery, visiblePropertyIds, type Page } from "../scope";
import type { Tx } from "../../db/client";

/* ───────────── shared ───────────── */

export const PROPERTY_TYPES = ["residential", "commercial", "mixed_use", "strata", "rental", "industrial"] as const;
export const UNIT_TYPES = ["residential", "commercial", "storage", "amenity", "other"] as const;
export const UNIT_STATUSES = ["occupied", "vacant", "notice", "renovation", "unavailable"] as const;

const optText = (max = 200) => z.string().trim().max(max).optional().transform(blankToNull);
const optInt = (min: number, max: number) =>
  z.union([z.literal(""), z.coerce.number().int().min(min).max(max)]).optional().transform((v) => (v === "" || v === undefined ? null : v));
const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => (v ? v : null));

const activeOccupancy = or(isNull(unitOccupancies.endsOn), gte(unitOccupancies.endsOn, sql`current_date`));

// loads a row by id within the org, or throws NotFound (never reveals other orgs' rows)
async function load<T>(rows: Promise<T[]>): Promise<T> {
  const [r] = await rows;
  if (!r) throw new NotFoundError();
  return r;
}

/* ───────────── portfolios ───────────── */

export const portfolioSchema = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(120),
  description: optText(500),
});

export async function listPortfolios(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("portfolio.read")) throw new ForbiddenError();
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({ id: portfolios.id, name: portfolios.name, description: portfolios.description, propertyCount: sql<number>`count(${properties.id})::int` })
      .from(portfolios)
      .leftJoin(properties, and(eq(properties.portfolioId, portfolios.id), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined))
      .where(eq(portfolios.orgId, p.orgId))
      .groupBy(portfolios.id)
      .orderBy(asc(portfolios.name));
    // scoped roles only see portfolios they're assigned to or that contain their properties
    return p.role.scopeLevel === "org" ? rows : rows.filter((r) => p.portfolioIds.has(r.id) || r.propertyCount > 0);
  });
}

export async function createPortfolio(ctx: TenantCtx, input: z.infer<typeof portfolioSchema>) {
  authorize(ctx.principal, "portfolio.manage");
  if (ctx.principal.role.scopeLevel !== "org") throw new ForbiddenError("Only organization-wide roles can create portfolios.");
  return tenantTx(ctx, async (tx) => {
    const [row] = await tx.insert(portfolios).values({ orgId: ctx.principal.orgId, ...input }).returning();
    await auditAs(tx, ctx, "portfolio.created", "portfolio", row.id, undefined, row);
    return row;
  });
}

export async function updatePortfolio(ctx: TenantCtx, id: string, input: z.infer<typeof portfolioSchema>) {
  authorize(ctx.principal, "portfolio.manage", { orgId: ctx.principal.orgId, portfolioId: id });
  return tenantTx(ctx, async (tx) => {
    const before = await load(tx.select().from(portfolios).where(and(eq(portfolios.id, id), eq(portfolios.orgId, ctx.principal.orgId))));
    const [after] = await tx.update(portfolios).set(input).where(eq(portfolios.id, id)).returning();
    await auditAs(tx, ctx, "portfolio.updated", "portfolio", id, before, after);
    return after;
  });
}

export async function deletePortfolio(ctx: TenantCtx, id: string) {
  authorize(ctx.principal, "portfolio.manage");
  if (ctx.principal.role.scopeLevel !== "org") throw new ForbiddenError("Only organization-wide roles can delete portfolios.");
  await tenantTx(ctx, async (tx) => {
    const before = await load(tx.select().from(portfolios).where(and(eq(portfolios.id, id), eq(portfolios.orgId, ctx.principal.orgId))));
    await tx.delete(portfolios).where(eq(portfolios.id, id)); // properties keep existing, portfolio set null
    await auditAs(tx, ctx, "portfolio.deleted", "portfolio", id, before);
  });
}

/* ───────────── properties ───────────── */

export const propertySchema = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, "Use 2–12 letters, numbers or dashes."),
  type: z.enum(PROPERTY_TYPES),
  portfolioId: optUuid,
  addressLine1: optText(200),
  city: optText(100),
  region: optText(50),
  postalCode: optText(20),
  timezone: z.string().trim().min(1).max(60).default("America/Vancouver"),
  emergencyPhone: optText(40),
  emergencyInfo: optText(1000),
  officeHours: optText(200),
});
export type PropertyInput = z.infer<typeof propertySchema>;

const PROPERTY_UNIQUE = { properties_org_code_uq: ["Another property already uses this code.", "code"] } as Record<string, [string, string]>;

export type PropertyRow = {
  id: string; name: string; code: string; type: string; city: string | null; portfolioName: string | null;
  buildingCount: number; unitCount: number; occupiedCount: number; residentCount: number;
};

export async function listProperties(ctx: TenantCtx, opts: { q?: string; type?: string; portfolioId?: string; page?: number }): Promise<Page<PropertyRow>> {
  const p = ctx.principal;
  if (!p.permissions.has("property.read")) throw new ForbiddenError();
  const visible = visiblePropertyIds(p);
  const { page, pageSize, offset } = pageArgs(opts.page);
  const tsq = toPrefixQuery(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(
      eq(properties.orgId, p.orgId),
      visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined,
      tsq ? matches("properties", tsq) : undefined,
      opts.type && (PROPERTY_TYPES as readonly string[]).includes(opts.type) ? eq(properties.type, opts.type) : undefined,
      opts.portfolioId ? eq(properties.portfolioId, opts.portfolioId) : undefined,
    );
    const [{ n }] = await tx.select({ n: count() }).from(properties).where(where);
    const rows = await tx
      .select({ id: properties.id, name: properties.name, code: properties.code, type: properties.type, city: properties.city, portfolioName: portfolios.name })
      .from(properties)
      .leftJoin(portfolios, eq(portfolios.id, properties.portfolioId))
      .where(where)
      .orderBy(asc(properties.name))
      .limit(pageSize)
      .offset(offset);
    if (!rows.length) return toPage([], n, page, pageSize);
    const ids = rows.map((r) => r.id);
    const unitScope = scopeCondition(p, { property: units.propertyId, building: units.buildingId });
    const bScope = scopeCondition(p, { property: buildings.propertyId, building: buildings.id });
    const bc = await tx.select({ id: buildings.propertyId, n: count() }).from(buildings).where(and(inArray(buildings.propertyId, ids), bScope)).groupBy(buildings.propertyId);
    const uc = await tx
      .select({ id: units.propertyId, n: count(), occ: sql<number>`count(*) filter (where ${units.status} = 'occupied')::int` })
      .from(units).where(and(inArray(units.propertyId, ids), unitScope)).groupBy(units.propertyId);
    const rc = await tx
      .select({ id: units.propertyId, n: sql<number>`count(distinct ${unitOccupancies.residentId})::int` })
      .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId))
      .where(and(inArray(units.propertyId, ids), unitScope, activeOccupancy)).groupBy(units.propertyId);
    const find = (arr: { id: string; n: number }[], id: string) => arr.find((x) => x.id === id)?.n ?? 0;
    return toPage(
      rows.map((r) => ({
        ...r, buildingCount: find(bc, r.id), unitCount: find(uc, r.id),
        occupiedCount: uc.find((x) => x.id === r.id)?.occ ?? 0, residentCount: find(rc, r.id),
      })),
      n, page, pageSize,
    );
  });
}

export async function getProperty(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const prop = await load(tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.orgId, p.orgId))));
    authorize(p, "property.read", { orgId: p.orgId, propertyId: id, portfolioId: prop.portfolioId });
    const portfolio = prop.portfolioId ? (await tx.select().from(portfolios).where(eq(portfolios.id, prop.portfolioId)))[0] ?? null : null;
    const bScope = scopeCondition(p, { property: buildings.propertyId, building: buildings.id });
    const blds = await tx
      .select({
        id: buildings.id, name: buildings.name, code: buildings.code, yearBuilt: buildings.yearBuilt,
        floorCount: sql<number>`(select count(*)::int from floors f where f.building_id = buildings.id)`,
        unitCount: sql<number>`(select count(*)::int from units u where u.building_id = buildings.id)`,
        occupiedCount: sql<number>`(select count(*)::int from units u where u.building_id = buildings.id and u.status = 'occupied')`,
      })
      .from(buildings).where(and(eq(buildings.propertyId, id), bScope)).orderBy(asc(buildings.name));
    const bIds = blds.map((b) => b.id);
    const [{ residents: residentCount }] = bIds.length
      ? await tx.select({ residents: sql<number>`count(distinct ${unitOccupancies.residentId})::int` }).from(unitOccupancies)
          .innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(and(inArray(units.buildingId, bIds), activeOccupancy))
      : [{ residents: 0 }];
    const propVendors = can(p, "vendor.read")
      ? await tx.select({ id: vendors.id, name: vendors.name, categories: vendors.categories, status: vendors.status })
          .from(vendorProperties).innerJoin(vendors, eq(vendors.id, vendorProperties.vendorId))
          .where(eq(vendorProperties.propertyId, id)).orderBy(asc(vendors.name))
      : null;
    const staff = can(p, "member.read")
      ? await tx.selectDistinct({ membershipId: memberships.id, name: users.name, title: memberships.title })
          .from(membershipScopes).innerJoin(memberships, eq(memberships.id, membershipScopes.membershipId)).innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.status, "active"), or(eq(membershipScopes.propertyId, id), prop.portfolioId ? eq(membershipScopes.portfolioId, prop.portfolioId) : undefined, bIds.length ? inArray(membershipScopes.buildingId, bIds) : undefined)))
      : null;
    const canManage = can(p, "property.manage", { orgId: p.orgId, propertyId: id, portfolioId: prop.portfolioId });
    return { property: prop, portfolio, buildings: blds, residentCount, vendors: propVendors, staff, canManage, canDelete: canManage && p.role.scopeLevel === "org" };
  });
}

// org-wide roles may create anywhere; portfolio-scoped roles only inside their portfolios
function authorizeCreateProperty(ctx: TenantCtx, portfolioId: string | null) {
  const p = ctx.principal;
  if (p.role.scopeLevel === "org") return authorize(p, "property.manage");
  if (!portfolioId) throw new ValidationError("Choose one of your portfolios.", "portfolioId");
  authorize(p, "property.manage", { orgId: p.orgId, portfolioId });
}

async function assertPortfolio(tx: Tx, orgId: string, portfolioId: string | null) {
  if (!portfolioId) return;
  const [pf] = await tx.select({ id: portfolios.id }).from(portfolios).where(and(eq(portfolios.id, portfolioId), eq(portfolios.orgId, orgId)));
  if (!pf) throw new ValidationError("Portfolio not found.", "portfolioId");
}

export async function createProperty(ctx: TenantCtx, input: PropertyInput) {
  authorizeCreateProperty(ctx, input.portfolioId);
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    await assertPortfolio(tx, ctx.principal.orgId, input.portfolioId);
    const [row] = await tx.insert(properties).values({ orgId: ctx.principal.orgId, ...input }).returning();
    await auditAs(tx, ctx, "property.created", "property", row.id, undefined, row);
    return row;
  }), PROPERTY_UNIQUE);
}

export async function updateProperty(ctx: TenantCtx, id: string, input: PropertyInput) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const before = await load(tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.orgId, p.orgId))));
    authorize(p, "property.manage", { orgId: p.orgId, propertyId: id, portfolioId: before.portfolioId });
    if (input.portfolioId !== before.portfolioId) {
      // moving between portfolios is an org-level decision (or within a portfolio manager's own portfolios)
      if (p.role.scopeLevel !== "org" && (!input.portfolioId || !p.portfolioIds.has(input.portfolioId))) {
        throw new ForbiddenError("You can't move this property to that portfolio.");
      }
      await assertPortfolio(tx, p.orgId, input.portfolioId);
    }
    const [after] = await tx.update(properties).set(input).where(eq(properties.id, id)).returning();
    await auditAs(tx, ctx, "property.updated", "property", id, before, after);
    return after;
  }), PROPERTY_UNIQUE);
}

// destructive: removes buildings, units and occupancies; org-wide roles only, typed confirmation
export async function deleteProperty(ctx: TenantCtx, id: string, confirmCode: string) {
  const p = ctx.principal;
  if (p.role.scopeLevel !== "org") throw new ForbiddenError("Only organization-wide roles can delete properties.");
  authorize(p, "property.manage");
  await tenantTx(ctx, async (tx) => {
    const before = await load(tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.orgId, p.orgId))));
    if (confirmCode.trim().toUpperCase() !== before.code) throw new ValidationError(`Type ${before.code} to confirm.`, "confirm");
    await tx.delete(properties).where(eq(properties.id, id));
    await auditAs(tx, ctx, "property.deleted", "property", id, before);
  });
}

/* ───────────── buildings & floors ───────────── */

export const buildingSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/, "Use 1–12 letters, numbers or dashes."),
  yearBuilt: optInt(1800, 2100),
  floorsAbove: optInt(0, 200),
  hasGround: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
});

const BUILDING_UNIQUE = { buildings_property_code_uq: ["This property already has a building with that code.", "code"] } as Record<string, [string, string]>;

async function loadBuilding(tx: Tx, orgId: string, id: string) {
  return load(tx.select().from(buildings).where(and(eq(buildings.id, id), eq(buildings.orgId, orgId))));
}

export async function createBuilding(ctx: TenantCtx, propertyId: string, input: z.infer<typeof buildingSchema>) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const prop = await load(tx.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.orgId, p.orgId))));
    authorize(p, "property.manage", { orgId: p.orgId, propertyId, portfolioId: prop.portfolioId });
    const [row] = await tx.insert(buildings).values({ orgId: p.orgId, propertyId, name: input.name, code: input.code, yearBuilt: input.yearBuilt }).returning();
    // optional floor scaffolding: Ground + Level 1..N
    const levels = [...(input.hasGround ? [0] : []), ...Array.from({ length: input.floorsAbove ?? 0 }, (_, i) => i + 1)];
    if (levels.length) await tx.insert(floors).values(levels.map((level) => ({ orgId: p.orgId, buildingId: row.id, level, name: level === 0 ? "Ground" : `Level ${level}` })));
    await auditAs(tx, ctx, "building.created", "building", row.id, undefined, { ...row, floors: levels.length });
    return row;
  }), BUILDING_UNIQUE);
}

export async function updateBuilding(ctx: TenantCtx, id: string, input: z.infer<typeof buildingSchema>) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const before = await loadBuilding(tx, p.orgId, id);
    authorize(p, "property.manage", { orgId: p.orgId, propertyId: before.propertyId, buildingId: id });
    const [after] = await tx.update(buildings).set({ name: input.name, code: input.code, yearBuilt: input.yearBuilt }).where(eq(buildings.id, id)).returning();
    await auditAs(tx, ctx, "building.updated", "building", id, before, after);
    return after;
  }), BUILDING_UNIQUE);
}

export async function deleteBuilding(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadBuilding(tx, p.orgId, id);
    authorize(p, "property.manage", { orgId: p.orgId, propertyId: before.propertyId });
    const [{ n }] = await tx.select({ n: count() }).from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(and(eq(units.buildingId, id), activeOccupancy));
    if (n > 0) throw new ValidationError(`This building has ${n} current resident${n === 1 ? "" : "s"}. Move them out before deleting it.`);
    await tx.delete(buildings).where(eq(buildings.id, id));
    await auditAs(tx, ctx, "building.deleted", "building", id, before);
    return before.propertyId;
  });
}

export async function getBuilding(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBuilding(tx, p.orgId, id);
    authorize(p, "property.read", { orgId: p.orgId, propertyId: b.propertyId, buildingId: id });
    const [prop] = await tx.select({ id: properties.id, name: properties.name, code: properties.code, portfolioId: properties.portfolioId }).from(properties).where(eq(properties.id, b.propertyId));
    const floorRows = await tx.select().from(floors).where(eq(floors.buildingId, id)).orderBy(desc(floors.level));
    const unitScope = scopeCondition(p, { property: units.propertyId, building: units.buildingId, unit: p.role.scopeLevel === "occupant" ? units.id : undefined });
    const unitRows = await tx
      .select({
        id: units.id, number: units.number, floorId: units.floorId, type: units.type, status: units.status, bedrooms: units.bedrooms,
        occupants: sql<number>`(select count(*)::int from unit_occupancies o where o.unit_id = units.id and (o.ends_on is null or o.ends_on >= current_date))`,
      })
      .from(units).where(and(eq(units.buildingId, id), unitScope)).orderBy(asc(units.number));
    return {
      building: b, property: prop, floors: floorRows, units: unitRows,
      canManage: can(p, "property.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: id }),
      canManageUnits: can(p, "unit.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: id }),
    };
  });
}

export const floorSchema = z.object({
  level: z.coerce.number().int().min(-10, "Lowest level is -10.").max(200),
  name: optText(60),
});

export async function addFloor(ctx: TenantCtx, buildingId: string, input: z.infer<typeof floorSchema>) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const b = await loadBuilding(tx, p.orgId, buildingId);
    authorize(p, "property.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId });
    const name = input.name ?? (input.level === 0 ? "Ground" : input.level < 0 ? `Parking P${-input.level}` : `Level ${input.level}`);
    const [row] = await tx.insert(floors).values({ orgId: p.orgId, buildingId, level: input.level, name }).returning();
    await auditAs(tx, ctx, "floor.created", "floor", row.id, undefined, row);
    return row;
  }), { floors_building_level_uq: ["That level already exists.", "level"] });
}

export async function deleteFloor(ctx: TenantCtx, floorId: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const f = await load(tx.select().from(floors).where(and(eq(floors.id, floorId), eq(floors.orgId, p.orgId))));
    const b = await loadBuilding(tx, p.orgId, f.buildingId);
    authorize(p, "property.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id });
    const [{ n }] = await tx.select({ n: count() }).from(units).where(eq(units.floorId, floorId));
    if (n > 0) throw new ValidationError("Remove or move this floor's units first.");
    await tx.delete(floors).where(eq(floors.id, floorId));
    await auditAs(tx, ctx, "floor.deleted", "floor", floorId, f);
    return b.id;
  });
}

/* ───────────── units ───────────── */

export const unitSchema = z.object({
  number: z.string().trim().min(1, "Enter a unit number.").max(20).regex(/^[A-Za-z0-9-]+$/, "Letters, numbers and dashes only."),
  floorId: optUuid,
  type: z.enum(UNIT_TYPES),
  status: z.enum(UNIT_STATUSES),
  bedrooms: optInt(0, 20),
  bathrooms: z.union([z.literal(""), z.coerce.number().min(0).max(20).multipleOf(0.5)]).optional().transform((v) => (v === "" || v === undefined ? null : String(v))),
  areaSqft: optInt(0, 1_000_000),
});
export type UnitInput = z.infer<typeof unitSchema>;

const UNIT_UNIQUE = { units_building_number_uq: ["This building already has a unit with that number.", "number"] } as Record<string, [string, string]>;

async function assertFloor(tx: Tx, buildingId: string, floorId: string | null) {
  if (!floorId) return;
  const [f] = await tx.select({ id: floors.id }).from(floors).where(and(eq(floors.id, floorId), eq(floors.buildingId, buildingId)));
  if (!f) throw new ValidationError("That floor isn't in this building.", "floorId");
}

export async function createUnit(ctx: TenantCtx, buildingId: string, input: UnitInput) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const b = await loadBuilding(tx, p.orgId, buildingId);
    authorize(p, "unit.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId });
    await assertFloor(tx, buildingId, input.floorId);
    const [row] = await tx.insert(units).values({ orgId: p.orgId, propertyId: b.propertyId, buildingId, ...input }).returning();
    await auditAs(tx, ctx, "unit.created", "unit", row.id, undefined, row);
    return row;
  }), UNIT_UNIQUE);
}

export const generateUnitsSchema = z.object({
  fromLevel: z.coerce.number().int().min(-10).max(200),
  toLevel: z.coerce.number().int().min(-10).max(200),
  perFloor: z.coerce.number().int().min(1, "At least 1 per floor.").max(60),
  type: z.enum(UNIT_TYPES).default("residential"),
}).refine((v) => v.toLevel >= v.fromLevel, { message: "“To” must be at or above “From”.", path: ["toLevel"] })
  .refine((v) => (v.toLevel - v.fromLevel + 1) * v.perFloor <= 2000, { message: "Generate at most 2,000 units at a time.", path: ["perFloor"] });

// creates missing floors and units numbered <level><nn> (e.g. 1204); existing numbers are skipped
export async function generateUnits(ctx: TenantCtx, buildingId: string, input: z.infer<typeof generateUnitsSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBuilding(tx, p.orgId, buildingId);
    authorize(p, "unit.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId });
    const levels = Array.from({ length: input.toLevel - input.fromLevel + 1 }, (_, i) => input.fromLevel + i);
    await tx.insert(floors)
      .values(levels.map((level) => ({ orgId: p.orgId, buildingId, level, name: level === 0 ? "Ground" : level < 0 ? `Parking P${-level}` : `Level ${level}` })))
      .onConflictDoNothing();
    const floorRows = await tx.select().from(floors).where(and(eq(floors.buildingId, buildingId), inArray(floors.level, levels)));
    const pad = input.perFloor >= 100 ? 3 : 2;
    const values = floorRows.flatMap((f) =>
      Array.from({ length: input.perFloor }, (_, i) => ({
        orgId: p.orgId, propertyId: b.propertyId, buildingId, floorId: f.id, type: input.type, status: "vacant",
        number: `${f.level < 0 ? `P${-f.level}-` : f.level === 0 ? "G" : f.level}${String(i + 1).padStart(pad, "0")}`,
      })),
    );
    const created = values.length ? await tx.insert(units).values(values).onConflictDoNothing().returning({ id: units.id }) : [];
    await auditAs(tx, ctx, "unit.bulk_created", "building", buildingId, undefined, { levels: `${input.fromLevel}..${input.toLevel}`, perFloor: input.perFloor, created: created.length });
    return { created: created.length, skipped: values.length - created.length };
  });
}

export type UnitRow = {
  id: string; number: string; type: string; status: string; bedrooms: number | null; areaSqft: number | null;
  buildingId: string; buildingName: string; propertyId: string; propertyName: string; floorName: string | null;
  occupants: number; primaryResident: string | null;
};

export async function listUnits(
  ctx: TenantCtx,
  opts: { q?: string; propertyId?: string; buildingId?: string; status?: string; type?: string; page?: number },
): Promise<Page<UnitRow>> {
  const p = ctx.principal;
  if (!p.permissions.has("unit.read") && !p.permissions.has("unit.read.own")) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const tsq = toPrefixQuery(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(
      eq(units.orgId, p.orgId),
      p.permissions.has("unit.read")
        ? scopeCondition(p, { property: units.propertyId, building: units.buildingId })
        : p.unitIds.size ? inArray(units.id, [...p.unitIds]) : sql`false`,
      tsq ? matches("units", tsq) : undefined,
      opts.propertyId ? eq(units.propertyId, opts.propertyId) : undefined,
      opts.buildingId ? eq(units.buildingId, opts.buildingId) : undefined,
      opts.status && (UNIT_STATUSES as readonly string[]).includes(opts.status) ? eq(units.status, opts.status) : undefined,
      opts.type && (UNIT_TYPES as readonly string[]).includes(opts.type) ? eq(units.type, opts.type) : undefined,
    );
    const [{ n }] = await tx.select({ n: count() }).from(units).where(where);
    const rows = await tx
      .select({
        id: units.id, number: units.number, type: units.type, status: units.status, bedrooms: units.bedrooms, areaSqft: units.areaSqft,
        buildingId: units.buildingId, buildingName: buildings.name, propertyId: units.propertyId, propertyName: properties.name, floorName: floors.name,
        occupants: sql<number>`(select count(*)::int from unit_occupancies o where o.unit_id = units.id and (o.ends_on is null or o.ends_on >= current_date))`,
        primaryResident: sql<string | null>`(select r.first_name || ' ' || r.last_name from unit_occupancies o join residents r on r.id = o.resident_id
          where o.unit_id = units.id and (o.ends_on is null or o.ends_on >= current_date) order by o.is_primary desc, o.created_at limit 1)`,
      })
      .from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId))
      .innerJoin(properties, eq(properties.id, units.propertyId))
      .leftJoin(floors, eq(floors.id, units.floorId))
      .where(where)
      .orderBy(asc(properties.name), asc(buildings.name), sql`length(${units.number})`, asc(units.number))
      .limit(pageSize)
      .offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

async function loadUnit(tx: Tx, orgId: string, id: string) {
  return load(tx.select().from(units).where(and(eq(units.id, id), eq(units.orgId, orgId))));
}

export async function getUnit(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const u = await loadUnit(tx, p.orgId, id);
    authorize(p, "unit.read", { orgId: p.orgId, propertyId: u.propertyId, buildingId: u.buildingId, unitId: id });
    const [ctxRow] = await tx
      .select({ buildingName: buildings.name, propertyName: properties.name, floorName: floors.name })
      .from(buildings).innerJoin(properties, eq(properties.id, buildings.propertyId)).leftJoin(floors, eq(floors.id, sql`${u.floorId}`))
      .where(eq(buildings.id, u.buildingId));
    // staff with resident.read see full history; occupants see their current household only
    const seeResidents = can(p, "resident.read", { orgId: p.orgId, propertyId: u.propertyId, buildingId: u.buildingId });
    const occ = await tx
      .select({
        id: unitOccupancies.id, residentId: residents.id, firstName: residents.firstName, lastName: residents.lastName,
        email: residents.email, phone: residents.phone, relationship: unitOccupancies.relationship, isPrimary: unitOccupancies.isPrimary,
        startsOn: unitOccupancies.startsOn, endsOn: unitOccupancies.endsOn, hasLogin: sql<boolean>`${residents.userId} is not null`,
      })
      .from(unitOccupancies).innerJoin(residents, eq(residents.id, unitOccupancies.residentId))
      .where(and(eq(unitOccupancies.unitId, id), seeResidents ? undefined : activeOccupancy))
      .orderBy(desc(sql`${unitOccupancies.endsOn} is null`), desc(unitOccupancies.isPrimary), asc(residents.lastName));
    const floorOptions = can(p, "unit.manage", { orgId: p.orgId, propertyId: u.propertyId, buildingId: u.buildingId })
      ? await tx.select({ id: floors.id, name: floors.name, level: floors.level }).from(floors).where(eq(floors.buildingId, u.buildingId)).orderBy(asc(floors.level))
      : [];
    return {
      unit: u, ...ctxRow,
      occupancies: seeResidents ? occ : occ.map((o) => ({ ...o, email: null, phone: null })),
      seeResidentDetails: seeResidents,
      canManage: can(p, "unit.manage", { orgId: p.orgId, propertyId: u.propertyId, buildingId: u.buildingId }),
      canManageResidents: can(p, "resident.manage", { orgId: p.orgId, propertyId: u.propertyId, buildingId: u.buildingId }),
      floorOptions,
    };
  });
}

export async function updateUnit(ctx: TenantCtx, id: string, input: UnitInput) {
  const p = ctx.principal;
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const before = await loadUnit(tx, p.orgId, id);
    authorize(p, "unit.manage", { orgId: p.orgId, propertyId: before.propertyId, buildingId: before.buildingId });
    await assertFloor(tx, before.buildingId, input.floorId);
    const [after] = await tx.update(units).set(input).where(eq(units.id, id)).returning();
    await auditAs(tx, ctx, "unit.updated", "unit", id, before, after);
    return after;
  }), UNIT_UNIQUE);
}

export async function deleteUnit(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadUnit(tx, p.orgId, id);
    authorize(p, "unit.manage", { orgId: p.orgId, propertyId: before.propertyId, buildingId: before.buildingId });
    const [{ n }] = await tx.select({ n: count() }).from(unitOccupancies).where(and(eq(unitOccupancies.unitId, id), activeOccupancy));
    if (n > 0) throw new ValidationError("This unit has current residents. Move them out first.");
    await tx.delete(units).where(eq(units.id, id));
    await auditAs(tx, ctx, "unit.deleted", "unit", id, before);
    return before.buildingId;
  });
}

/* ───────────── pickers ───────────── */

// buildings the principal may manage units/residents in, for forms
export async function listBuildingOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, (tx) =>
    tx.select({ id: buildings.id, name: buildings.name, propertyId: properties.id, propertyName: properties.name })
      .from(buildings).innerJoin(properties, eq(properties.id, buildings.propertyId))
      .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id })))
      .orderBy(asc(properties.name), asc(buildings.name)),
  );
}

export async function listPropertyOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, (tx) =>
    tx.select({ id: properties.id, name: properties.name, portfolioId: properties.portfolioId }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined))
      .orderBy(asc(properties.name)),
  );
}

// contact and emergency details of the properties a resident lives in
export async function myPropertyInfo(ctx: TenantCtx) {
  const ids = [...ctx.principal.occupantPropertyIds];
  if (!ids.length) return [];
  return tenantTx(ctx, (tx) =>
    tx.select({ id: properties.id, name: properties.name, emergencyPhone: properties.emergencyPhone, emergencyInfo: properties.emergencyInfo, officeHours: properties.officeHours })
      .from(properties).where(and(eq(properties.orgId, ctx.principal.orgId), inArray(properties.id, ids))).orderBy(asc(properties.name)),
  );
}
