import "server-only";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { recentViews, savedViews } from "@/server/db/schema";
import { NotFoundError } from "@/server/authz/authorize";
import { tenantTx, ValidationError, type TenantCtx } from "../context";
import type { Tx } from "@/server/db/client";
import { VIEW_PAGES, sanitizeViewQuery, type ViewPage } from "@/lib/views";
import type { Principal } from "@/server/authz/authorize";

/* ───── saved views: a person's named list filters ───── */

const MAX_VIEWS_PER_PAGE = 20;

export async function listSavedViews(ctx: TenantCtx, page: ViewPage) {
  return tenantTx(ctx, (tx) => tx.select({ id: savedViews.id, name: savedViews.name, query: savedViews.query }).from(savedViews)
    .where(and(eq(savedViews.orgId, ctx.principal.orgId), eq(savedViews.userId, ctx.principal.userId), eq(savedViews.page, page)))
    .orderBy(asc(savedViews.name)));
}

// saving under an existing name replaces that view's filters
export async function saveView(ctx: TenantCtx, page: string, name: string, query: string) {
  if (!VIEW_PAGES.includes(page as ViewPage)) throw new ValidationError("Views can't be saved on this page.");
  const label = name.trim().replace(/\s+/g, " ");
  if (!label || label.length > 60) throw new ValidationError("Give the view a name of up to 60 characters.", "name");
  const q = sanitizeViewQuery(query);
  if (!q) throw new ValidationError("Choose a filter or search first, then save it as a view.");
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const mine = and(eq(savedViews.orgId, p.orgId), eq(savedViews.userId, p.userId), eq(savedViews.page, page));
    const existing = await tx.select({ id: savedViews.id, name: savedViews.name }).from(savedViews).where(mine);
    const same = existing.find((v) => v.name.toLowerCase() === label.toLowerCase());
    if (same) {
      await tx.update(savedViews).set({ query: q, name: label }).where(eq(savedViews.id, same.id));
      return { id: same.id, replaced: true };
    }
    if (existing.length >= MAX_VIEWS_PER_PAGE) throw new ValidationError(`You can keep up to ${MAX_VIEWS_PER_PAGE} views here; delete one first.`);
    const [row] = await tx.insert(savedViews).values({ orgId: p.orgId, userId: p.userId, page, name: label, query: q }).returning({ id: savedViews.id });
    return { id: row.id, replaced: false };
  });
}

export async function deleteView(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const gone = await tx.delete(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.orgId, p.orgId), eq(savedViews.userId, p.userId))).returning({ id: savedViews.id });
    if (!gone.length) throw new NotFoundError();
  });
}

/* ───── recently viewed records (command palette) ───── */

// who may still see each kind of record; recents of a kind the person has since lost access to are hidden
export const RECENT_TYPES: Record<string, { label: string; anyOf: string[] }> = {
  work_order: { label: "Work order", anyOf: ["workorder.read", "workorder.read.assigned", "workorder.read.own", "workorder.create"] },
  task: { label: "Task", anyOf: ["task.read", "task.manage"] },
  inspection: { label: "Inspection", anyOf: ["inspection.read", "inspection.manage"] },
  incident: { label: "Incident", anyOf: ["incident.read", "incident.create"] },
  complaint: { label: "Complaint", anyOf: ["complaint.read", "complaint.create", "complaint.manage"] },
  property: { label: "Property", anyOf: ["property.read"] },
  building: { label: "Building", anyOf: ["property.read"] },
  unit: { label: "Unit", anyOf: ["unit.read", "unit.read.own"] },
  resident: { label: "Resident", anyOf: ["resident.read"] },
  vendor: { label: "Vendor", anyOf: ["vendor.read"] },
  asset: { label: "Asset", anyOf: ["asset.read", "asset.manage"] },
  package: { label: "Package", anyOf: ["package.manage", "package.read.own"] },
  visitor: { label: "Visitor", anyOf: ["visitor.manage", "visitor.invite"] },
  document: { label: "Document", anyOf: ["document.read", "document.manage"] },
};
const KEEP_RECENT = 20;

const allowedTypes = (p: Principal) => Object.entries(RECENT_TYPES).filter(([, t]) => t.anyOf.some((x) => p.permissions.has(x))).map(([k]) => k);

// called after a detail page has been shown to someone allowed to see it; never fails the page
export async function recordView(ctx: TenantCtx, item: { type: keyof typeof RECENT_TYPES; id: string; title: string; href: string }) {
  const p = ctx.principal;
  if (!RECENT_TYPES[item.type] || !item.href.startsWith(`/o/`)) return;
  await tenantTx(ctx, async (tx) => {
    await tx.insert(recentViews).values({ orgId: p.orgId, userId: p.userId, entityType: item.type, entityId: item.id, title: item.title.slice(0, 160), href: item.href, viewedAt: new Date() })
      .onConflictDoUpdate({ target: [recentViews.orgId, recentViews.userId, recentViews.entityType, recentViews.entityId], set: { title: item.title.slice(0, 160), href: item.href, viewedAt: new Date() } });
    const keep = await tx.select({ id: recentViews.id }).from(recentViews)
      .where(and(eq(recentViews.orgId, p.orgId), eq(recentViews.userId, p.userId))).orderBy(desc(recentViews.viewedAt)).limit(KEEP_RECENT);
    if (keep.length === KEEP_RECENT) {
      await tx.delete(recentViews).where(and(eq(recentViews.orgId, p.orgId), eq(recentViews.userId, p.userId), notInArray(recentViews.id, keep.map((k) => k.id))));
    }
  });
}

export async function listRecent(ctx: TenantCtx, limit = 8) {
  const p = ctx.principal;
  const types = allowedTypes(p);
  if (!types.length) return [];
  const rows = await tenantTx(ctx, (tx) => tx.select({ type: recentViews.entityType, id: recentViews.entityId, title: recentViews.title, href: recentViews.href })
    .from(recentViews).where(and(eq(recentViews.orgId, p.orgId), eq(recentViews.userId, p.userId), inArray(recentViews.entityType, types)))
    .orderBy(desc(recentViews.viewedAt)).limit(limit));
  return rows.map((r) => ({ ...r, label: RECENT_TYPES[r.type]?.label ?? r.type }));
}

// drops a record from everyone's recents in one organization (it was deleted, or a person was erased). Other people's
// rows are owner-only, so this runs in the system context; callers have already checked their own permission.
export async function forgetRecent(tx: Tx, orgId: string, type: string, entityId: string) {
  await tx.delete(recentViews).where(and(eq(recentViews.orgId, orgId), eq(recentViews.entityType, type), eq(recentViews.entityId, entityId)));
}
