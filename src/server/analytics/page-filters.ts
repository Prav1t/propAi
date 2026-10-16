import "server-only";
import { and, eq } from "drizzle-orm";
import { buildings } from "../db/schema";
import { tenantTx, type TenantCtx } from "../modules/context";
import { listPropertyOptions } from "../modules/portfolio/service";
import { PERIOD_PRESETS, PRESET_LABEL, previousPeriod, resolvePeriod, type Period, type PeriodPreset } from "./period";
import type { SearchParams } from "../org-context";

const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

// ?period=&property=&building= → a validated period and filters limited to what the reader can see
export async function analyticsFilters(ctx: TenantCtx, q: SearchParams, fallback: PeriodPreset = "30d") {
  const tz = ctx.principal.orgTimezone ?? "UTC";
  const preset = (PERIOD_PRESETS as readonly string[]).includes(one(q.period) ?? "") ? (one(q.period) as PeriodPreset) : fallback;
  const period: Period = resolvePeriod(preset, tz);
  const previous = previousPeriod(period, tz);
  const props = await listPropertyOptions(ctx);
  const propertyId = props.some((p) => p.id === one(q.property)) ? one(q.property)! : null;
  const blds = propertyId ? await tenantTx(ctx, (tx) => tx.select({ id: buildings.id, name: buildings.name }).from(buildings)
    .where(and(eq(buildings.orgId, ctx.principal.orgId), eq(buildings.propertyId, propertyId)))) : [];
  const buildingId = blds.some((b) => b.id === one(q.building)) ? one(q.building)! : null;
  return {
    preset, period, previous, propertyId, buildingId, properties: props, buildings: blds,
    periodOptions: PERIOD_PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p] })),
    query: (extra: Record<string, string | null> = {}) => {
      const s = new URLSearchParams();
      if (preset !== fallback) s.set("period", preset);
      if (propertyId) s.set("property", propertyId);
      if (buildingId) s.set("building", buildingId);
      for (const [k, v] of Object.entries(extra)) if (v) s.set(k, v); else s.delete(k);
      return s.size ? `?${s}` : "";
    },
  };
}
