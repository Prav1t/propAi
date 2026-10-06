import "server-only";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { amenities, buildings, properties, units, vendors } from "../../db/schema";
import { tenantTx, type TenantCtx } from "../../modules/context";
import { scopeCondition, visiblePropertyIds } from "../../modules/scope";
import { amenityVisibleWhere } from "../../modules/amenities/service";
import { err, type ToolErr } from "./registry";

// Free-text references from the model ("Tower B", "the party room", "unit 1204") → ids, searched only within
// what the principal can see. More than one match is returned as AMBIGUOUS so the assistant asks instead of guessing.

export type Place = { propertyId: string | null; buildingId: string | null; label: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ");
const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

function propertyVisible(ctx: TenantCtx): SQL | undefined {
  const ids = visiblePropertyIds(ctx.principal);
  return ids === null ? undefined : ids.length ? inArray(properties.id, ids) : sql`false`;
}

function buildingVisible(ctx: TenantCtx): SQL | undefined {
  return scopeCondition(ctx.principal, { property: buildings.propertyId, building: buildings.id });
}

export async function resolvePlace(ctx: TenantCtx, raw: string | undefined | null): Promise<Place | ToolErr | null> {
  if (!raw || !raw.trim()) return null;
  const q = norm(raw);
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const findProps = (s: string) => tx.select({ id: properties.id, name: properties.name, code: properties.code }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), propertyVisible(ctx), or(sql`lower(${properties.name}) = ${s}`, sql`lower(${properties.code}) = ${s}`, sql`${properties.name} ilike ${like(s)}`)))
      .orderBy(asc(properties.name)).limit(10);
    const findBlds = (s: string, propertyId?: string) => tx.select({ id: buildings.id, name: buildings.name, code: buildings.code, propertyId: buildings.propertyId, propertyName: properties.name })
      .from(buildings).innerJoin(properties, eq(properties.id, buildings.propertyId))
      .where(and(eq(buildings.orgId, p.orgId), buildingVisible(ctx), propertyId ? eq(buildings.propertyId, propertyId) : undefined,
        or(sql`lower(${buildings.name}) = ${s}`, sql`${buildings.name} ilike ${like(s)}`, propertyId ? sql`lower(${buildings.code}) = ${s}` : undefined)))
      .orderBy(asc(properties.name), asc(buildings.name)).limit(10);
    const exact = <T extends { name: string; code?: string }>(rows: T[], s: string) => {
      const e = rows.filter((r) => r.name.toLowerCase() === s || r.code?.toLowerCase() === s);
      return e.length ? e : rows;
    };

    const props = exact(await findProps(q), q);
    // a building whose name equals its property's ("Kingsway Residences") is the property itself
    const blds = exact(await findBlds(q), q).filter((b) => !props.some((pr) => pr.id === b.propertyId && pr.name.toLowerCase() === b.name.toLowerCase()));
    const exactProps = props.filter((r) => r.name.toLowerCase() === q || r.code.toLowerCase() === q);
    const exactBlds = blds.filter((r) => r.name.toLowerCase() === q);
    const pickProps = exactProps.length || exactBlds.length ? exactProps : props;
    const pickBlds = exactProps.length || exactBlds.length ? exactBlds : blds;
    const total = pickProps.length + pickBlds.length;
    if (total === 1) {
      if (pickProps.length) return { propertyId: pickProps[0].id, buildingId: null, label: pickProps[0].name };
      const b = pickBlds[0];
      return { propertyId: b.propertyId, buildingId: b.id, label: `${b.name} · ${b.propertyName}` };
    }
    if (total > 1) {
      return err("AMBIGUOUS", `"${raw.trim()}" matches more than one place you can see.`,
        [...pickProps.map((r) => r.name), ...pickBlds.map((b) => `${b.name} · ${b.propertyName}`)]);
    }
    // "Tower B, Fraser Towers" / "Tower B at Fraser Towers"
    const split = q.split(/\s*(?:,|·|\bat\b|\bin\b|\bof\b)\s*/).filter(Boolean);
    if (split.length === 2) {
      for (const [bq, pq] of [[split[0], split[1]], [split[1], split[0]]]) {
        const ps = exact(await findProps(pq), pq);
        if (ps.length !== 1) continue;
        const bs = exact(await findBlds(bq, ps[0].id), bq);
        if (bs.length === 1) return { propertyId: ps[0].id, buildingId: bs[0].id, label: `${bs[0].name} · ${ps[0].name}` };
      }
    }
    return err("NOT_FOUND", `I couldn't find a property or building called "${raw.trim()}" among the places you can see.`);
  });
}

export type UnitRef = { id: string; number: string; buildingId: string; propertyId: string; label: string };

export async function resolveUnit(ctx: TenantCtx, raw: string | undefined | null, place?: Place | null): Promise<UnitRef | ToolErr | null> {
  if (!raw || !raw.trim()) return null;
  const q = raw.trim().replace(/^(unit|suite|apt\.?|#)\s*/i, "");
  const p = ctx.principal;
  const scope = p.permissions.has("unit.read")
    ? scopeCondition(p, { property: units.propertyId, building: units.buildingId })
    : p.unitIds.size ? inArray(units.id, [...p.unitIds]) : sql`false`;
  const rows = await tenantTx(ctx, (tx) =>
    tx.select({ id: units.id, number: units.number, buildingId: units.buildingId, propertyId: units.propertyId, building: buildings.name, property: properties.name })
      .from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(eq(units.orgId, p.orgId), scope, sql`lower(${units.number}) = lower(${q})`,
        place?.propertyId ? eq(units.propertyId, place.propertyId) : undefined, place?.buildingId ? eq(units.buildingId, place.buildingId) : undefined))
      .orderBy(asc(properties.name), asc(buildings.name)).limit(10),
  );
  if (rows.length === 1) {
    const r = rows[0];
    return { id: r.id, number: r.number, buildingId: r.buildingId, propertyId: r.propertyId, label: `Unit ${r.number} · ${r.building} · ${r.property}` };
  }
  if (rows.length > 1) return err("AMBIGUOUS", `Unit ${q} exists in more than one building.`, rows.map((r) => `Unit ${r.number} · ${r.building} · ${r.property}`));
  return err("NOT_FOUND", `I couldn't find unit ${q} among the units you can see.`);
}

const AMENITY_KIND_WORDS: [RegExp, string][] = [
  [/\b(gym|fitness)/, "gym"], [/\bparty/, "party_room"], [/\bpool|swim/, "pool"], [/\broof/, "rooftop"], [/\bmeeting|board ?room|conference/, "meeting_room"],
  [/\blounge|clubhouse|club house/, "lounge"], [/\bcourt|tennis|pickleball|squash/, "court"], [/\bworkspace|co-?working|study/, "workspace"],
  [/\bguest suite/, "guest_suite"], [/\bbbq|barbecue|grill/, "bbq"], [/\btheat(re|er)|media|cinema/, "theatre"],
];

export type AmenityRef = { id: string; name: string; propertyId: string; label: string };

export async function resolveAmenity(ctx: TenantCtx, raw: string, place?: Place | null): Promise<AmenityRef | ToolErr> {
  const q = norm(raw);
  const kind = AMENITY_KIND_WORDS.find(([re]) => re.test(q))?.[1];
  const p = ctx.principal;
  const rows = await tenantTx(ctx, (tx) =>
    tx.select({ id: amenities.id, name: amenities.name, propertyId: amenities.propertyId, property: properties.name })
      .from(amenities).innerJoin(properties, eq(properties.id, amenities.propertyId))
      .where(and(eq(amenities.orgId, p.orgId), amenityVisibleWhere(p), eq(amenities.active, true),
        or(sql`${amenities.name} ilike ${like(q)}`, kind ? eq(amenities.kind, kind) : undefined),
        place?.propertyId ? eq(amenities.propertyId, place.propertyId) : undefined))
      .orderBy(asc(properties.name), asc(amenities.name)).limit(10),
  );
  // an exact name wins only within one property: "the gym" is ambiguous when two properties each have one
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  const oneProperty = new Set(rows.map((r) => r.propertyId)).size === 1;
  const pick = exact.length === 1 && oneProperty ? exact : rows;
  if (pick.length === 1) return { id: pick[0].id, name: pick[0].name, propertyId: pick[0].propertyId, label: `${pick[0].name} · ${pick[0].property}` };
  if (pick.length > 1) return err("AMBIGUOUS", `More than one amenity matches "${raw.trim()}".`, pick.map((r) => `${r.name} · ${r.property}`));
  return err("NOT_FOUND", `I couldn't find an amenity called "${raw.trim()}" that you can book or see.`);
}

export async function resolveVendor(ctx: TenantCtx, raw: string): Promise<{ id: string; name: string } | ToolErr> {
  const q = norm(raw);
  const rows = await tenantTx(ctx, (tx) =>
    tx.select({ id: vendors.id, name: vendors.name }).from(vendors)
      .where(and(eq(vendors.orgId, ctx.principal.orgId), sql`${vendors.name} ilike ${like(q)}`)).orderBy(asc(vendors.name)).limit(10),
  );
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  const pick = exact.length ? exact : rows;
  if (pick.length === 1) return pick[0];
  if (pick.length > 1) return err("AMBIGUOUS", `More than one vendor matches "${raw.trim()}".`, pick.map((r) => r.name));
  return err("NOT_FOUND", `No vendor called "${raw.trim()}".`);
}

export const isErr = (v: unknown): v is ToolErr => !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;

// a resident's own units with labels (for actions that default to "my unit")
export async function myUnits(ctx: TenantCtx): Promise<UnitRef[]> {
  const p = ctx.principal;
  if (!p.unitIds.size) return [];
  const rows = await tenantTx(ctx, (tx) =>
    tx.select({ id: units.id, number: units.number, buildingId: units.buildingId, propertyId: units.propertyId, building: buildings.name, property: properties.name })
      .from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(eq(units.orgId, p.orgId), inArray(units.id, [...p.unitIds]))).orderBy(asc(units.number)),
  );
  return rows.map((r) => ({ id: r.id, number: r.number, buildingId: r.buildingId, propertyId: r.propertyId, label: `Unit ${r.number} · ${r.building} · ${r.property}` }));
}

// "which property?" when none was named: the only one in scope, or everything for org-wide roles if allowed, else ask
export async function propertyFor(ctx: TenantCtx, place: Place | null, opts: { allowOrgWide?: boolean } = {}): Promise<{ propertyId: string | null; buildingId: string | null; label: string } | ToolErr> {
  if (place?.propertyId) return { propertyId: place.propertyId, buildingId: place.buildingId, label: place.label };
  const ids = visiblePropertyIds(ctx.principal);
  const rows = await tenantTx(ctx, (tx) => tx.select({ id: properties.id, name: properties.name }).from(properties)
    .where(and(eq(properties.orgId, ctx.principal.orgId), ids === null ? undefined : ids.length ? inArray(properties.id, ids) : sql`false`)).orderBy(asc(properties.name)));
  if (rows.length === 1) return { propertyId: rows[0].id, buildingId: null, label: rows[0].name };
  if (opts.allowOrgWide && ctx.principal.role.scopeLevel === "org") return { propertyId: null, buildingId: null, label: "All properties" };
  if (!rows.length) return err("FORBIDDEN", "You don't have access to any property for this.");
  return err("AMBIGUOUS", "Which property is this for?", rows.map((r) => r.name));
}

// one building, given a place that may be a property with several buildings
export async function buildingFor(ctx: TenantCtx, place: Place | null): Promise<{ propertyId: string; buildingId: string; label: string } | ToolErr> {
  const prop = await propertyFor(ctx, place);
  if (isErr(prop)) return prop;
  if (prop.buildingId && prop.propertyId) return { propertyId: prop.propertyId, buildingId: prop.buildingId, label: prop.label };
  const rows = await tenantTx(ctx, (tx) => tx.select({ id: buildings.id, name: buildings.name, property: properties.name }).from(buildings)
    .innerJoin(properties, eq(properties.id, buildings.propertyId))
    .where(and(eq(buildings.orgId, ctx.principal.orgId), eq(buildings.propertyId, prop.propertyId!), buildingVisible(ctx))).orderBy(asc(buildings.name)));
  if (rows.length === 1) return { propertyId: prop.propertyId!, buildingId: rows[0].id, label: `${rows[0].name} · ${rows[0].property}` };
  if (!rows.length) return err("NOT_FOUND", `No building you can see at ${prop.label}.`);
  return err("AMBIGUOUS", `Which building at ${prop.label}?`, rows.map((r) => `${r.name} · ${r.property}`));
}
