import "server-only";
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { buildings, properties, units } from "../../db/schema";
import { tenantTx } from "../../modules/context";
import { listVisibleProperties } from "../../modules/organizations/service";
import { listUnits, myPropertyInfo, UNIT_STATUSES } from "../../modules/portfolio/service";
import { listResidents } from "../../modules/people/service";
import { UNIT_STATUS, RELATIONSHIP_LABEL } from "@/lib/labels";
import { anyPerm, defineTool, ok, plural } from "./registry";
import { lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr, resolveUnit } from "./resolve";

export const searchProperties = defineTool({
  name: "search_properties",
  title: "Looking up properties",
  description: "The properties the user can see, with building, unit and occupied-unit counts.",
  input: z.object({ q: z.string().trim().max(120).optional().describe("Part of a property name, code or city.") }),
  available: anyPerm("property.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const all = await listVisibleProperties(ctx);
    const q = a.q?.toLowerCase();
    const rows = q ? all.filter((r) => [r.name, r.code, r.city ?? ""].some((x) => x.toLowerCase().includes(q))) : all;
    const items = rows.map((r) => ({ id: r.id, name: r.name, code: r.code, type: r.type, city: r.city, buildings: r.buildingCount, units: r.unitCount, occupiedUnits: r.occupiedCount, href: env.href(`/properties/${r.id}`) }));
    return {
      result: ok(rows.length ? `You can see ${plural(rows.length, "property", "properties")}.` : "No matching properties.", {
        count: rows.length, items, highlights: items.map((i) => `[${i.name}](${i.href}) — ${plural(i.buildings, "building")}, ${plural(i.units, "unit")} (${i.occupiedUnits} occupied)`),
      }),
      display: { records: items.map((i) => ({ ref: i.code, title: i.name, href: i.href, sub: [i.city, `${plural(i.units, "unit")}`, `${i.occupiedUnits} occupied`].filter(Boolean).join(" · ") })) },
    };
  },
});

export const searchUnits = defineTool({
  name: "search_units",
  title: "Looking up units",
  description: "Find units by number or text, optionally by status (e.g. vacant). Returns the primary resident's name for staff with directory access.",
  input: z.object({
    q: z.string().trim().max(60).optional().describe("Unit number or text, e.g. '1204'."),
    location: locationArg,
    status: z.enum(UNIT_STATUSES).optional(),
    limit: limitArg,
  }),
  available: anyPerm("unit.read", "unit.read.own"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const page = await listUnits(ctx, { q: a.q, propertyId: pf.propertyId, buildingId: pf.buildingId, status: a.status, page: 1 });
    const directory = ctx.principal.permissions.has("resident.read");
    const rows = page.rows.slice(0, lim(a.limit));
    const items = rows.map((r) => ({
      id: r.id, unit: r.number, building: r.buildingName, property: r.propertyName, floor: r.floorName, type: r.type, status: r.status, bedrooms: r.bedrooms,
      occupants: r.occupants, ...(directory ? { primaryResident: r.primaryResident } : {}), href: env.href(`/units/${r.id}`),
    }));
    return {
      result: ok(page.total ? `${plural(page.total, a.status ? `${a.status} unit` : "unit")} match${page.total === 1 ? "es" : ""}${where(pf.place)}.` : `No matching units${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((i) => `[Unit ${i.unit}](${i.href}) — ${i.building} · ${i.property} · ${UNIT_STATUS[i.status]?.label ?? i.status}${"primaryResident" in i && i.primaryResident ? ` · ${i.primaryResident}` : ""}`),
      }),
      display: { records: items.map((i) => ({ ref: `Unit ${i.unit}`, title: `${i.building} · ${i.property}`, href: i.href, sub: [i.floor, `${plural(i.occupants, "occupant")}`].filter(Boolean).join(" · "),
        badges: [{ label: UNIT_STATUS[i.status]?.label ?? i.status, tone: UNIT_STATUS[i.status]?.tone ?? "neutral" }] })) },
    };
  },
});

export const searchResidents = defineTool({
  name: "search_residents",
  title: "Searching the resident directory",
  description: "Staff only: find current residents by name, email or phone, or list who lives in a unit. Personal data — every lookup is audit-logged.",
  input: z.object({
    q: z.string().trim().max(120).optional().describe("Name, email or phone."),
    unit: z.string().trim().max(20).optional().describe("Unit number, e.g. '1204'."),
    location: locationArg,
    limit: limitArg,
  }),
  available: anyPerm("resident.read"),
  riskClass: 1,
  sensitive: true,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    let unitId: string | undefined;
    if (a.unit) {
      const u = await resolveUnit(ctx, a.unit, pf.place);
      if (isErr(u)) return { result: u };
      unitId = u?.id;
    }
    const page = await listResidents(ctx, { q: a.q, propertyId: pf.propertyId, buildingId: pf.buildingId, unitId, status: "current", pageSize: lim(a.limit) });
    const items = page.rows.map((r) => ({
      id: r.id, name: `${r.firstName} ${r.lastName}`, units: r.units, relationship: r.relationship, email: r.email, phone: r.phone, appAccount: r.hasLogin, href: env.href(`/residents/${r.id}`),
    }));
    return {
      result: ok(page.total ? `${plural(page.total, "current resident")} match${page.total === 1 ? "es" : ""}${a.unit ? ` in unit ${a.unit}` : ""}${where(pf.place)}.` : "No matching current residents.", {
        count: page.total, items,
        highlights: items.slice(0, 8).map((i) => `[${i.name}](${i.href}) — ${[i.units, i.relationship ? RELATIONSHIP_LABEL[i.relationship] : null].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((i) => ({ ref: i.relationship ? RELATIONSHIP_LABEL[i.relationship] ?? i.relationship : "Resident", title: i.name, href: i.href, sub: i.units ?? undefined })) },
    };
  },
});

export const myHome = defineTool({
  name: "my_home",
  title: "Looking up your home",
  description: "Residents: their unit(s), building and property, plus the property's office hours and emergency contact information.",
  input: z.object({}),
  available: (p) => p.role.category === "resident" && p.permissions.has("unit.read.own"),
  riskClass: 1,
  async execute(ctx, _a, env) {
    const p = ctx.principal;
    const info = await myPropertyInfo(ctx);
    const mine = p.unitIds.size
      ? await tenantTx(ctx, (tx) => tx.select({ id: units.id, number: units.number, building: buildings.name, property: properties.name })
        .from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
        .where(and(eq(units.orgId, p.orgId), inArray(units.id, [...p.unitIds]))).orderBy(asc(units.number)))
      : [];
    const facts = {
      units: mine.map((u) => ({ unit: u.number, building: u.building, property: u.property, href: env.href(`/units/${u.id}`) })),
      properties: info.map((i) => ({ name: i.name, officeHours: i.officeHours, emergencyPhone: i.emergencyPhone, emergencyInfo: i.emergencyInfo })),
    };
    const highlights = [
      ...mine.map((u) => `Your home: Unit ${u.number}, ${u.building}, ${u.property}`),
      ...info.flatMap((i) => [
        i.officeHours ? `${i.name} office hours: ${i.officeHours}` : null,
        i.emergencyPhone ? `${i.name} emergency line: ${i.emergencyPhone}` : null,
        i.emergencyInfo ? `In an emergency: ${i.emergencyInfo}` : null,
      ].filter((x): x is string => !!x)),
    ];
    return { result: ok(mine.length ? `You live in ${plural(mine.length, "unit")}.` : "No unit is linked to your account.", { facts, highlights }) };
  },
});
