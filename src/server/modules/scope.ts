import "server-only";
import { inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { scopeFilter, type Principal } from "../authz/authorize";

// SQL condition restricting rows to the principal's property tree; undefined = no restriction
export function scopeCondition(
  p: Principal,
  cols: { property: SQLWrapper; building?: SQLWrapper; unit?: SQLWrapper },
): SQL | undefined {
  const f = scopeFilter(p);
  const none = sql`false`;
  switch (f.kind) {
    case "all":
      return undefined;
    case "none":
      return none;
    case "some":
      return or(
        f.propertyIds.length ? inArray(cols.property, f.propertyIds) : undefined,
        f.buildingIds.length && cols.building ? inArray(cols.building, f.buildingIds) : undefined,
      ) ?? none;
    case "units":
      // occupants: unit-level rows only for their own units; property-level rows for their properties
      if (cols.unit) return f.unitIds.length ? inArray(cols.unit, f.unitIds) : none;
      if (cols.building) return f.buildingIds.length ? inArray(cols.building, f.buildingIds) : none;
      return f.propertyIds.length ? inArray(cols.property, f.propertyIds) : none;
  }
}

// property ids a principal may *see* (full or partial); null = all
export function visiblePropertyIds(p: Principal): string[] | null {
  const f = scopeFilter(p);
  if (f.kind === "all") return null;
  if (f.kind === "none") return [];
  if (f.kind === "some") return [...new Set([...f.propertyIds, ...p.partialPropertyIds])];
  return f.propertyIds;
}

// turns free text into a safe prefix tsquery ("fra tow" → 'fra':* & 'tow':*); null when nothing searchable
export function toPrefixQuery(q: string | null | undefined): string | null {
  if (!q) return null;
  const terms = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9@._-]+/)
    // emails stay whole (Postgres indexes them as one token); everything else becomes alphanumerics
    .map((t) => (t.includes("@") ? t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") : t.replace(/[^a-z0-9]/g, "")))
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

// matches a generated tsvector column named "search" on the given table alias
export function matches(table: string, tsquery: string): SQL {
  return sql`${sql.identifier(table)}.search @@ to_tsquery('simple', ${tsquery})`;
}

export type Page<T> = { rows: T[]; total: number; page: number; pageSize: number; pageCount: number };

export function pageArgs(page: number | undefined, pageSize = 25) {
  const p = Math.max(1, Math.floor(page ?? 1) || 1);
  const size = Math.min(100, Math.max(1, pageSize));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

export const toPage = <T,>(rows: T[], total: number, page: number, pageSize: number): Page<T> => ({
  rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)),
});
