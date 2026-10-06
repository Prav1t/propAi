import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { announcementReads, announcements, buildings, memberships, organizations, properties, residents, roles, unitOccupancies, units, users, ANNOUNCEMENT_CATEGORIES } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { withContext } from "../../db/client";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, visiblePropertyIds, type Page } from "../scope";
import { emit, emitSystem } from "../ops/core";
import { renderTemplate } from "@/lib/template";
import { zonedToUtc } from "@/lib/time";

type AnnRow = typeof announcements.$inferSelect;

/* ───────────── access ───────────── */

// managers: announcement.manage on the property; org-wide announcements need an org-wide role
export function canManageAnnouncement(p: Principal, a: Pick<AnnRow, "orgId" | "propertyId">) {
  if (a.orgId !== p.orgId) return false;
  return a.propertyId ? can(p, "announcement.manage", { orgId: a.orgId, propertyId: a.propertyId }) : p.role.scopeLevel === "org" && can(p, "announcement.manage");
}

// readers: published, not expired, and the audience/place includes them
function readerWhere(p: Principal): SQL {
  const live = and(eq(announcements.status, "published"), or(isNull(announcements.expiresAt), gt(announcements.expiresAt, sql`now()`)));
  if (p.role.category === "staff") {
    const visible = visiblePropertyIds(p);
    return and(live, ne(announcements.audience, "residents"),
      or(isNull(announcements.propertyId), visible ? (visible.length ? inArray(announcements.propertyId, visible) : sql`false`) : undefined))!;
  }
  if (p.role.category !== "resident") return sql`false`;
  const props = [...p.occupantPropertyIds], blds = [...p.occupantBuildingIds];
  return and(live, ne(announcements.audience, "staff"),
    or(isNull(announcements.propertyId), props.length ? inArray(announcements.propertyId, props) : sql`false`),
    or(sql`cardinality(${announcements.buildingIds}) = 0`, blds.length ? sql`${announcements.buildingIds} && ARRAY[${sql.join(blds.map((b) => sql`${b}`), sql`, `)}]::uuid[]` : sql`false`))!;
}

function canRead(p: Principal, a: AnnRow) {
  if (a.orgId !== p.orgId || !p.permissions.has("announcement.read")) return false;
  if (a.status !== "published" || (a.expiresAt && a.expiresAt <= new Date())) return false;
  if (p.role.category === "staff") {
    if (a.audience === "residents") return false;
    return !a.propertyId || can(p, "announcement.read", { orgId: a.orgId, propertyId: a.propertyId });
  }
  if (p.role.category !== "resident" || a.audience === "staff") return false;
  if (a.propertyId && !p.occupantPropertyIds.has(a.propertyId)) return false;
  return !a.buildingIds.length || a.buildingIds.some((b) => p.occupantBuildingIds.has(b));
}

/* ───────────── reading ───────────── */

export type FeedItem = { id: string; title: string; body: string; category: string; pinned: boolean; publishedAt: Date | null; expiresAt: Date | null; propertyName: string | null; read: boolean; authorName: string | null };

export async function announcementFeed(ctx: TenantCtx, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<FeedItem[]> {
  const p = ctx.principal;
  if (!p.permissions.has("announcement.read")) return [];
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({
      id: announcements.id, title: announcements.title, body: announcements.body, category: announcements.category, pinned: announcements.pinned,
      publishedAt: announcements.publishedAt, expiresAt: announcements.expiresAt, propertyName: properties.name, authorName: users.name,
      read: sql<boolean>`exists (select 1 from announcement_reads r where r.announcement_id = announcements.id and r.user_id = ${p.userId})`,
    }).from(announcements).leftJoin(properties, eq(properties.id, announcements.propertyId)).leftJoin(users, eq(users.id, announcements.createdByUserId))
      .where(and(eq(announcements.orgId, p.orgId), readerWhere(p),
        opts.unreadOnly ? sql`not exists (select 1 from announcement_reads r where r.announcement_id = announcements.id and r.user_id = ${p.userId})` : undefined))
      .orderBy(desc(announcements.pinned), desc(announcements.publishedAt)).limit(Math.min(opts.limit ?? 50, 200));
    return rows;
  });
}

export async function unreadAnnouncementCount(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("announcement.read")) return 0;
  const [r] = await tenantTx(ctx, (tx) => tx.select({ n: count() }).from(announcements)
    .where(and(eq(announcements.orgId, p.orgId), readerWhere(p), sql`not exists (select 1 from announcement_reads r where r.announcement_id = announcements.id and r.user_id = ${p.userId})`)));
  return r.n;
}

export type AnnouncementView = "published" | "scheduled" | "drafts" | "archived";

export async function listManagedAnnouncements(ctx: TenantCtx, opts: { view?: AnnouncementView; page?: number }): Promise<Page<AnnRow & { propertyName: string | null; authorName: string | null; reads: number }>> {
  const p = ctx.principal;
  if (!p.permissions.has("announcement.manage")) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const status = { published: "published", scheduled: "scheduled", drafts: "draft", archived: "archived" }[opts.view ?? "published"];
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(announcements.orgId, p.orgId), eq(announcements.status, status),
      or(isNull(announcements.propertyId), visible ? (visible.length ? inArray(announcements.propertyId, visible) : sql`false`) : undefined));
    const [{ n }] = await tx.select({ n: count() }).from(announcements).where(where);
    const rows = await tx.select({ a: announcements, propertyName: properties.name, authorName: users.name,
      reads: sql<number>`(select count(*)::int from announcement_reads r where r.announcement_id = announcements.id)` })
      .from(announcements).leftJoin(properties, eq(properties.id, announcements.propertyId)).leftJoin(users, eq(users.id, announcements.createdByUserId))
      .where(where).orderBy(desc(announcements.pinned), status === "scheduled" ? asc(announcements.publishAt) : desc(sql`coalesce(${announcements.publishedAt}, ${announcements.createdAt})`))
      .limit(pageSize).offset(offset);
    return toPage(rows.map((r) => ({ ...r.a, propertyName: r.propertyName, authorName: r.authorName, reads: r.reads })), n, page, pageSize);
  });
}

// residents with app accounts + staff covering the place, minus nobody (author filtering happens at delivery)
export async function audienceUserIds(tx: Tx, a: Pick<AnnRow, "orgId" | "propertyId" | "buildingIds" | "audience">): Promise<string[]> {
  const out = new Set<string>();
  if (a.audience !== "staff") {
    const rows = await tx.selectDistinct({ userId: residents.userId }).from(unitOccupancies)
      .innerJoin(residents, eq(residents.id, unitOccupancies.residentId)).innerJoin(units, eq(units.id, unitOccupancies.unitId))
      .innerJoin(memberships, and(eq(memberships.userId, residents.userId), eq(memberships.orgId, a.orgId), eq(memberships.status, "active")))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(unitOccupancies.orgId, a.orgId), sql`(${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date)`,
        sql`${roles.permissions} @> array['announcement.read']`,
        a.propertyId ? eq(units.propertyId, a.propertyId) : undefined,
        a.buildingIds.length ? inArray(units.buildingId, a.buildingIds) : undefined));
    rows.forEach((r) => r.userId && out.add(r.userId));
  }
  if (a.audience !== "residents") {
    const rows = await tx.selectDistinct({ userId: memberships.userId }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, a.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"), sql`${roles.permissions} @> array['announcement.read']`,
        a.propertyId ? or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (s.property_id = ${a.propertyId}
          or s.portfolio_id = (select portfolio_id from properties where id = ${a.propertyId}) or s.building_id in (select id from buildings where property_id = ${a.propertyId})))`) : undefined));
    rows.forEach((r) => out.add(r.userId));
  }
  return [...out];
}

// how many app users an announcement would reach (shown before sending)
export async function audienceSize(ctx: TenantCtx, a: { propertyId: string | null; buildingIds: string[]; audience: string }) {
  return tenantTx(ctx, async (tx) => (await audienceUserIds(tx, { orgId: ctx.principal.orgId, ...a } as Parameters<typeof audienceUserIds>[1])).length);
}

export async function getAnnouncement(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [a] = await tx.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.orgId, p.orgId)));
    if (!a) throw new NotFoundError();
    const manage = canManageAnnouncement(p, a);
    const read = canRead(p, a);
    if (!manage && !read && !(p.role.category === "staff" && p.permissions.has("announcement.manage") && (!a.propertyId || can(p, "announcement.read", { orgId: p.orgId, propertyId: a.propertyId })))) throw new NotFoundError();
    // the author's own views don't count as reads
    if (read && a.createdByUserId !== p.userId) await tx.insert(announcementReads).values({ orgId: p.orgId, announcementId: id, userId: p.userId }).onConflictDoNothing();
    const [labels] = await tx.select({ propertyName: properties.name, authorName: users.name }).from(announcements)
      .leftJoin(properties, eq(properties.id, announcements.propertyId)).leftJoin(users, eq(users.id, announcements.createdByUserId)).where(eq(announcements.id, id));
    const bNames = a.buildingIds.length ? await tx.select({ id: buildings.id, name: buildings.name }).from(buildings).where(inArray(buildings.id, a.buildingIds)) : [];
    let stats: { reads: number; audience: number } | null = null;
    if (manage || p.permissions.has("announcement.manage")) {
      const [r] = await tx.select({ n: count() }).from(announcementReads).where(eq(announcementReads.announcementId, id));
      stats = { reads: r.n, audience: (await audienceUserIds(tx, a)).length };
    }
    return { announcement: a, labels: { propertyName: labels?.propertyName ?? null, authorName: labels?.authorName ?? null, buildings: bNames.map((b) => b.name) }, canManage: manage, stats };
  });
}

/* ───────────── writing ───────────── */

const checkbox = z.union([z.literal("on"), z.literal(""), z.literal("true"), z.literal("false")]).optional().transform((v) => v === "on" || v === "true");

export const announcementSchema = z.object({
  title: z.string().trim().min(3, "Add a title.").max(140),
  body: z.string().trim().min(5, "Write the announcement.").max(10_000),
  category: z.enum(ANNOUNCEMENT_CATEGORIES).default("general"),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  audience: z.enum(["everyone", "residents", "staff"]).default("everyone"),
  pinned: checkbox,
  notify: checkbox,
  mode: z.enum(["publish", "schedule", "draft"]).default("publish"),
  publishAt: z.string().optional(),
  expiresOn: z.string().optional().transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)),
});
export type AnnouncementInput = z.infer<typeof announcementSchema>;

async function validatePlace(tx: Tx, p: Principal, input: AnnouncementInput, buildingIds: string[]) {
  if (input.propertyId) authorize(p, "announcement.manage", { orgId: p.orgId, propertyId: input.propertyId });
  else if (p.role.scopeLevel !== "org") throw new ValidationError("Choose one of your properties.", "propertyId");
  else authorize(p, "announcement.manage");
  if (buildingIds.length) {
    if (!input.propertyId) throw new ValidationError("Pick a property before narrowing to buildings.", "buildingIds");
    const rows = await tx.select({ id: buildings.id }).from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.propertyId, input.propertyId), inArray(buildings.id, buildingIds)));
    if (rows.length !== new Set(buildingIds).size) throw new ValidationError("Those buildings aren't all in the property.", "buildingIds");
  }
}

// {{property}}, {{org_name}} and {{today}} are filled when saved; resident-specific variables don't apply to broadcasts
async function renderBroadcast(tx: Tx, p: Principal, input: AnnouncementInput) {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.orgId));
  const [prop] = input.propertyId ? await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, input.propertyId)) : [];
  const vars = { org_name: org?.name, property: prop?.name ?? org?.name, today: new Date().toLocaleDateString("en-CA", { timeZone: p.orgTimezone ?? "UTC", dateStyle: "long" }) };
  const out = [renderTemplate(input.title, vars), renderTemplate(input.body, vars)];
  const bad = [...new Set(out.flatMap((r) => [...r.unknown, ...r.missing]))];
  if (bad.length) throw new ValidationError(`Announcements can use {{property}}, {{org_name}} and {{today}} only (found ${bad.map((b) => `{{${b}}}`).join(", ")}).`, "body");
  return { title: out[0].text, body: out[1].text };
}

function timing(p: Principal, input: AnnouncementInput) {
  const tz = p.orgTimezone ?? "UTC";
  const expiresAt = input.expiresOn ? zonedToUtc(`${input.expiresOn}T23:59`, tz) : null;
  if (input.mode === "schedule") {
    const at = input.publishAt ? zonedToUtc(input.publishAt, tz) : new Date(NaN);
    if (Number.isNaN(at.getTime()) || at <= new Date()) throw new ValidationError("Choose a future time to publish.", "publishAt");
    if (expiresAt && expiresAt <= at) throw new ValidationError("It would expire before it's published.", "expiresOn");
    return { status: "scheduled" as const, publishAt: at, publishedAt: null, expiresAt };
  }
  if (expiresAt && expiresAt <= new Date()) throw new ValidationError("The expiry date has already passed.", "expiresOn");
  if (input.mode === "draft") return { status: "draft" as const, publishAt: null, publishedAt: null, expiresAt };
  return { status: "published" as const, publishAt: null, publishedAt: new Date(), expiresAt };
}

export async function createAnnouncement(ctx: TenantCtx, input: AnnouncementInput, buildingIds: string[]) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await validatePlace(tx, p, input, buildingIds);
    const text = await renderBroadcast(tx, p, input);
    const t = timing(p, input);
    const [a] = await tx.insert(announcements).values({
      orgId: p.orgId, propertyId: input.propertyId, buildingIds: [...new Set(buildingIds)], audience: input.audience, ...text, category: input.category,
      pinned: input.pinned, notify: input.notify, ...t, createdByUserId: p.userId,
    }).returning();
    await auditAs(tx, ctx, "announcement.created", "announcement", a.id, undefined, { title: a.title, status: a.status, propertyId: a.propertyId, audience: a.audience });
    if (a.status === "published") await emit(tx, ctx, "announcement.published", { announcementId: a.id });
    return a;
  });
}

// drafts and scheduled posts are fully editable; published ones keep their audience and don't notify again
export async function updateAnnouncement(ctx: TenantCtx, id: string, input: AnnouncementInput, buildingIds: string[]) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [before] = await tx.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.orgId, p.orgId)));
    if (!before) throw new NotFoundError();
    if (!canManageAnnouncement(p, before)) throw new ForbiddenError();
    const text = await renderBroadcast(tx, p, { ...input, propertyId: before.status === "published" ? before.propertyId : input.propertyId });
    let patch: Partial<AnnRow>;
    if (before.status === "published" || before.status === "archived") {
      const expiresAt = input.expiresOn ? zonedToUtc(`${input.expiresOn}T23:59`, p.orgTimezone ?? "UTC") : null;
      patch = { ...text, category: input.category, pinned: input.pinned, expiresAt };
    } else {
      await validatePlace(tx, p, input, buildingIds);
      patch = { ...text, category: input.category, pinned: input.pinned, notify: input.notify, propertyId: input.propertyId, buildingIds: [...new Set(buildingIds)], audience: input.audience, ...timing(p, input) };
    }
    const [a] = await tx.update(announcements).set(patch).where(eq(announcements.id, id)).returning();
    await auditAs(tx, ctx, "announcement.updated", "announcement", id, { title: before.title, status: before.status }, { title: a.title, status: a.status });
    if (before.status !== "published" && a.status === "published") await emit(tx, ctx, "announcement.published", { announcementId: a.id });
    return a;
  });
}

export async function archiveAnnouncement(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const [a] = await tx.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.orgId, p.orgId)));
    if (!a) throw new NotFoundError();
    if (!canManageAnnouncement(p, a)) throw new ForbiddenError();
    if (a.status === "draft") await tx.delete(announcements).where(eq(announcements.id, id));
    else await tx.update(announcements).set({ status: "archived", pinned: false }).where(eq(announcements.id, id));
    await auditAs(tx, ctx, a.status === "draft" ? "announcement.deleted" : "announcement.archived", "announcement", id, { title: a.title, status: a.status });
  });
}

// worker: scheduled announcements whose time has come
export async function publishDueAnnouncements(): Promise<number> {
  const due = await withContext({ system: true }, (tx) =>
    tx.select({ id: announcements.id, orgId: announcements.orgId }).from(announcements).where(and(eq(announcements.status, "scheduled"), lte(announcements.publishAt, new Date()))).limit(100));
  for (const a of due) {
    await withContext({ orgId: a.orgId, system: true }, async (tx) => {
      const r = await tx.update(announcements).set({ status: "published", publishedAt: new Date() })
        .where(and(eq(announcements.id, a.id), eq(announcements.status, "scheduled"))).returning({ id: announcements.id });
      if (r.length) await emitSystem(tx, a.orgId, "announcement.published", { announcementId: a.id });
    });
  }
  return due.length;
}

export async function announcementFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined)).orderBy(asc(properties.name));
    const allowed = props.filter((x) => can(p, "announcement.manage", { orgId: p.orgId, propertyId: x.id }));
    const blds = allowed.length ? await tx.select({ id: buildings.id, name: buildings.name, propertyId: buildings.propertyId }).from(buildings)
      .where(and(eq(buildings.orgId, p.orgId), inArray(buildings.propertyId, allowed.map((x) => x.id)), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }))).orderBy(asc(buildings.name)) : [];
    return { properties: allowed, buildings: blds, orgWide: p.role.scopeLevel === "org" && can(p, "announcement.manage") };
  });
}
