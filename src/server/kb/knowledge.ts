import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { buildings, documents, kbChunks, kbSources, knowledgeEntries, knowledgeEntryVersions, properties, users, KNOWLEDGE_CATEGORIES } from "../db/schema";
import type { Tx } from "../db/client";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../authz/authorize";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { visiblePropertyIds } from "../modules/scope";
import { documentVisibleWhere, placeVisibleWhere } from "../modules/documents/access";
import { queueIndex } from "./indexer";
import { embeddings } from "./embeddings";

type Entry = Pick<typeof knowledgeEntries.$inferSelect, "orgId" | "propertyId" | "buildingId" | "audience" | "status">;

// managing follows document management: knowledge.manage on the property; organization-wide entries need an org-wide role
export function canManageKnowledge(p: Principal, e: Pick<Entry, "orgId" | "propertyId">): boolean {
  if (e.orgId !== p.orgId) return false;
  return e.propertyId ? can(p, "knowledge.manage", { orgId: e.orgId, propertyId: e.propertyId }) : p.role.scopeLevel === "org" && can(p, "knowledge.manage");
}

// reading follows documents: staff in scope; residents for their audience and place, active entries only
export function canReadKnowledge(p: Principal, e: Entry): boolean {
  if (e.orgId !== p.orgId) return false;
  if (canManageKnowledge(p, e)) return true;
  if (!p.permissions.has("document.read")) return false;
  if (p.role.category === "staff") return e.propertyId ? can(p, "document.read", { orgId: e.orgId, propertyId: e.propertyId, buildingId: e.buildingId }) : true;
  if (p.role.category !== "resident" || e.status !== "active" || e.audience === "staff") return false;
  if (e.audience === "owners" && p.role.key !== "owner") return false;
  if (e.buildingId) return p.occupantBuildingIds.has(e.buildingId);
  if (e.propertyId) return p.occupantPropertyIds.has(e.propertyId);
  return true;
}

export function knowledgeVisibleWhere(p: Principal) {
  return placeVisibleWhere(p, { propertyId: knowledgeEntries.propertyId, buildingId: knowledgeEntries.buildingId, audience: knowledgeEntries.audience, status: knowledgeEntries.status }, "active");
}

export const canUseKnowledgeBase = (p: Principal) => p.permissions.has("knowledge.manage");

export const entrySchema = z.object({
  title: z.string().trim().min(3, "Add a title.").max(160),
  body: z.string().trim().min(20, "Write at least a sentence or two.").max(50_000, "Keep an entry under 50,000 characters; split long material into several entries."),
  category: z.enum(KNOWLEDGE_CATEGORIES).default("general"),
  audience: z.enum(["staff", "residents", "owners"]).default("residents"),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  buildingId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  notes: z.string().trim().max(500).optional().transform(blankToNull),
});
export type EntryInput = z.infer<typeof entrySchema>;

async function checkPlace(tx: Tx, p: Principal, input: { propertyId: string | null; buildingId: string | null }) {
  if (input.buildingId) {
    if (!input.propertyId) throw new ValidationError("Choose the property.", "propertyId");
    const [b] = await tx.select({ propertyId: buildings.propertyId }).from(buildings).where(and(eq(buildings.id, input.buildingId), eq(buildings.orgId, p.orgId)));
    if (!b || b.propertyId !== input.propertyId) throw new ValidationError("That building isn't part of the property.", "buildingId");
  }
  if (input.propertyId) {
    const [pr] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, input.propertyId), eq(properties.orgId, p.orgId)));
    if (!pr) throw new ValidationError("Choose a property.", "propertyId");
  }
  if (!canManageKnowledge(p, { orgId: p.orgId, propertyId: input.propertyId })) {
    if (!input.propertyId && p.role.scopeLevel !== "org") throw new ValidationError("Organization-wide entries need an organization-wide role. Choose one of your properties.", "propertyId");
    throw new ForbiddenError();
  }
}

export async function createEntry(ctx: TenantCtx, input: EntryInput) {
  const p = ctx.principal;
  authorize(p, "knowledge.manage");
  return tenantTx(ctx, async (tx) => {
    await checkPlace(tx, p, input);
    const [e] = await tx.insert(knowledgeEntries).values({
      orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId, title: input.title, body: input.body, category: input.category,
      audience: input.audience, version: 1, createdByUserId: p.userId, updatedByUserId: p.userId,
    }).returning();
    await tx.insert(knowledgeEntryVersions).values({ orgId: p.orgId, entryId: e.id, version: 1, title: e.title, body: e.body, category: e.category, audience: e.audience, notes: input.notes, createdByUserId: p.userId });
    await queueIndex(tx, { orgId: p.orgId, entryId: e.id, version: 1 });
    await auditAs(tx, ctx, "knowledge.created", "knowledge_entry", e.id, undefined, { title: e.title, category: e.category, audience: e.audience, propertyId: e.propertyId });
    return e;
  });
}

// every edit is a new version; the assistant answers from the current one only
export async function updateEntry(ctx: TenantCtx, id: string, input: EntryInput) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [before] = await tx.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.orgId, p.orgId))).for("update");
    if (!before) throw new NotFoundError();
    if (!canManageKnowledge(p, before)) throw canReadKnowledge(p, before) ? new ForbiddenError() : new NotFoundError();
    await checkPlace(tx, p, input);
    const version = before.version + 1;
    const [after] = await tx.update(knowledgeEntries).set({
      title: input.title, body: input.body, category: input.category, audience: input.audience, propertyId: input.propertyId, buildingId: input.buildingId, version, updatedByUserId: p.userId,
    }).where(eq(knowledgeEntries.id, id)).returning();
    await tx.insert(knowledgeEntryVersions).values({ orgId: p.orgId, entryId: id, version, title: input.title, body: input.body, category: input.category, audience: input.audience, notes: input.notes, createdByUserId: p.userId });
    await queueIndex(tx, { orgId: p.orgId, entryId: id, version });
    await auditAs(tx, ctx, "knowledge.updated", "knowledge_entry", id,
      { version: before.version, title: before.title, audience: before.audience, propertyId: before.propertyId },
      { version, title: after.title, audience: after.audience, propertyId: after.propertyId, notes: input.notes });
    return after;
  });
}

// disabled entries stay in the list for managers but are never retrieved
export async function setEntryStatus(ctx: TenantCtx, id: string, status: "active" | "disabled") {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const [e] = await tx.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.orgId, p.orgId)));
    if (!e) throw new NotFoundError();
    if (!canManageKnowledge(p, e)) throw canReadKnowledge(p, e) ? new ForbiddenError() : new NotFoundError();
    if (e.status === status) return;
    await tx.update(knowledgeEntries).set({ status, updatedByUserId: p.userId }).where(eq(knowledgeEntries.id, id));
    await auditAs(tx, ctx, status === "disabled" ? "knowledge.disabled" : "knowledge.enabled", "knowledge_entry", id);
  });
}

export type IndexInfo = { status: string; chunkCount: number; error: string | null; indexedAt: Date | null; indexedVersion: number | null; version: number; embeddingModel: string | null; stale: boolean };

const indexInfo = (s: typeof kbSources.$inferSelect | null | undefined, currentModel: string): IndexInfo | null =>
  s ? {
    status: s.status, chunkCount: s.chunkCount, error: s.error, indexedAt: s.indexedAt, indexedVersion: s.indexedVersion, version: s.version, embeddingModel: s.embeddingModel,
    stale: s.status === "indexed" && !!s.embeddingModel && s.embeddingModel !== currentModel,
  } : null;

export async function getEntry(ctx: TenantCtx, id: string, opts: { version?: number } = {}) {
  const p = ctx.principal;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  return tenantTx(ctx, async (tx) => {
    const [e] = await tx.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.orgId, p.orgId)));
    if (!e || !canReadKnowledge(p, e)) throw new NotFoundError();
    const manage = canManageKnowledge(p, e);
    const staff = manage || p.role.category === "staff";
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name }).from(knowledgeEntries)
      .leftJoin(properties, eq(properties.id, knowledgeEntries.propertyId)).leftJoin(buildings, eq(buildings.id, knowledgeEntries.buildingId)).where(eq(knowledgeEntries.id, id));
    const versions = staff
      ? await tx.select({ version: knowledgeEntryVersions.version, notes: knowledgeEntryVersions.notes, createdAt: knowledgeEntryVersions.createdAt, author: users.name, title: knowledgeEntryVersions.title, body: knowledgeEntryVersions.body })
        .from(knowledgeEntryVersions).leftJoin(users, eq(users.id, knowledgeEntryVersions.createdByUserId)).where(eq(knowledgeEntryVersions.entryId, id)).orderBy(desc(knowledgeEntryVersions.version))
      : [];
    const shown = opts.version && staff ? versions.find((v) => v.version === opts.version) ?? null : null;
    const [src] = manage ? await tx.select().from(kbSources).where(eq(kbSources.entryId, id)) : [];
    const passages = manage && src
      ? await tx.select({ ordinal: kbChunks.ordinal, heading: kbChunks.heading, content: kbChunks.content, tokenCount: kbChunks.tokenCount, embedded: sql<boolean>`${kbChunks.embedding} is not null` })
        .from(kbChunks).where(eq(kbChunks.sourceId, src.id)).orderBy(asc(kbChunks.ordinal))
      : [];
    return {
      entry: e, labels, canManage: manage, versions: versions.map((v) => ({ version: v.version, notes: v.notes, createdAt: v.createdAt, author: v.author, title: v.title })), shownVersion: shown,
      index: indexInfo(src, embeddings().model.id), passages,
    };
  });
}

/* ───────────── the knowledge base page: every source the assistant can answer from ───────────── */

export type KbRow = {
  type: "knowledge" | "document"; id: string; title: string; category: string; audience: string; status: string; version: number;
  propertyName: string | null; updatedAt: Date; href: string; index: IndexInfo | null;
};

export const KB_FILTERS = ["all", "needs_attention", "entries", "documents"] as const;

export async function listKnowledgeBase(ctx: TenantCtx, opts: { q?: string; filter?: (typeof KB_FILTERS)[number]; propertyId?: string } = {}): Promise<{ rows: KbRow[]; truncated: boolean }> {
  const p = ctx.principal;
  if (!canUseKnowledgeBase(p)) throw new ForbiddenError();
  const LIMIT = 300;
  const like = opts.q?.trim() ? `%${opts.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const currentModel = embeddings().model.id;
  return tenantTx(ctx, async (tx) => {
    const entries = opts.filter === "documents" ? [] : await tx.select({ e: knowledgeEntries, propertyName: properties.name, src: kbSources }).from(knowledgeEntries)
      .leftJoin(properties, eq(properties.id, knowledgeEntries.propertyId)).leftJoin(kbSources, eq(kbSources.entryId, knowledgeEntries.id))
      .where(and(eq(knowledgeEntries.orgId, p.orgId), knowledgeVisibleWhere(p), like ? ilike(knowledgeEntries.title, like) : undefined,
        opts.propertyId ? or(eq(knowledgeEntries.propertyId, opts.propertyId), isNull(knowledgeEntries.propertyId)) : undefined))
      .orderBy(desc(knowledgeEntries.updatedAt)).limit(LIMIT);
    const docs = opts.filter === "entries" ? [] : await tx.select({ d: documents, propertyName: properties.name, src: kbSources }).from(documents)
      .leftJoin(properties, eq(properties.id, documents.propertyId)).leftJoin(kbSources, eq(kbSources.documentId, documents.id))
      .where(and(eq(documents.orgId, p.orgId), documentVisibleWhere(p), eq(documents.status, "active"), like ? ilike(documents.title, like) : undefined,
        opts.propertyId ? or(eq(documents.propertyId, opts.propertyId), isNull(documents.propertyId)) : undefined))
      .orderBy(desc(documents.updatedAt)).limit(LIMIT);
    let rows: KbRow[] = [
      ...entries.map(({ e, propertyName, src }): KbRow => ({
        type: "knowledge", id: e.id, title: e.title, category: e.category, audience: e.audience, status: e.status, version: e.version, propertyName, updatedAt: e.updatedAt,
        href: `/o/${p.orgSlug}/knowledge/${e.id}`, index: indexInfo(src, currentModel),
      })),
      ...docs.map(({ d, propertyName, src }): KbRow => ({
        type: "document", id: d.id, title: d.title, category: d.category, audience: d.audience, status: d.status, version: d.currentVersion, propertyName, updatedAt: d.updatedAt,
        href: `/o/${p.orgSlug}/documents/${d.id}`, index: indexInfo(src, currentModel),
      })),
    ];
    if (opts.filter === "needs_attention") rows = rows.filter((r) => !r.index || ["failed", "unsupported", "empty"].includes(r.index.status) || r.index.stale);
    rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { rows, truncated: entries.length >= LIMIT || docs.length >= LIMIT };
  });
}

// counts over the sources this manager can see (the same scope as the list)
export async function kbStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canUseKnowledgeBase(p)) throw new ForbiddenError();
  const model = embeddings();
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ status: kbSources.status, chunks: kbSources.chunkCount, embeddingModel: kbSources.embeddingModel }).from(kbSources)
      .leftJoin(documents, eq(documents.id, kbSources.documentId)).leftJoin(knowledgeEntries, eq(knowledgeEntries.id, kbSources.entryId))
      .where(and(eq(kbSources.orgId, p.orgId), or(
        and(sql`${kbSources.documentId} is not null`, eq(documents.status, "active"), documentVisibleWhere(p)),
        and(sql`${kbSources.entryId} is not null`, knowledgeVisibleWhere(p)),
      )));
    const n = (...st: string[]) => rows.filter((r) => st.includes(r.status)).length;
    const stale = rows.filter((r) => r.status === "indexed" && r.embeddingModel && r.embeddingModel !== model.model.id).length;
    return {
      sources: rows.length, indexed: n("indexed"), pending: n("queued", "indexing"), problems: n("failed", "unsupported", "empty"),
      passages: rows.reduce((a, r) => a + r.chunks, 0), stale, model: model.model.id, demo: model.model.demo, reason: model.reason,
    };
  });
}

// re-index one source (a manager of it) or everything the manager can manage
export async function reindex(ctx: TenantCtx, target: { documentId?: string; entryId?: string; all?: boolean }) {
  const p = ctx.principal;
  authorize(p, "knowledge.manage");
  return tenantTx(ctx, async (tx) => {
    let n = 0;
    if (target.entryId) {
      const [e] = await tx.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.id, target.entryId), eq(knowledgeEntries.orgId, p.orgId)));
      if (!e || !canManageKnowledge(p, e)) throw new NotFoundError();
      await queueIndex(tx, { orgId: p.orgId, entryId: e.id, version: e.version });
      n = 1;
    } else if (target.documentId) {
      const [d] = await tx.select().from(documents).where(and(eq(documents.id, target.documentId), eq(documents.orgId, p.orgId)));
      if (!d || !canManageKnowledge(p, d)) throw new NotFoundError();
      await queueIndex(tx, { orgId: p.orgId, documentId: d.id, version: d.currentVersion });
      n = 1;
    } else if (target.all) {
      const visible = visiblePropertyIds(p);
      const scope = (col: typeof documents.propertyId | typeof knowledgeEntries.propertyId) =>
        visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;
      const es = await tx.select({ id: knowledgeEntries.id, version: knowledgeEntries.version }).from(knowledgeEntries).where(and(eq(knowledgeEntries.orgId, p.orgId), scope(knowledgeEntries.propertyId)));
      const ds = await tx.select({ id: documents.id, version: documents.currentVersion }).from(documents).where(and(eq(documents.orgId, p.orgId), eq(documents.status, "active"), scope(documents.propertyId)));
      for (const e of es) await queueIndex(tx, { orgId: p.orgId, entryId: e.id, version: e.version });
      for (const d of ds) await queueIndex(tx, { orgId: p.orgId, documentId: d.id, version: d.version });
      n = es.length + ds.length;
    }
    await auditAs(tx, ctx, "knowledge.reindexed", target.all ? "organization" : target.entryId ? "knowledge_entry" : "document", target.entryId ?? target.documentId ?? p.orgId, undefined, { sources: n });
    return n;
  });
}

export async function knowledgeFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined)).orderBy(asc(properties.name));
    const manageable = props.filter((x) => canManageKnowledge(p, { orgId: p.orgId, propertyId: x.id }));
    const blds = manageable.length ? await tx.select({ id: buildings.id, name: buildings.name, propertyId: buildings.propertyId, propertyName: properties.name }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId)).where(and(eq(buildings.orgId, p.orgId), inArray(buildings.propertyId, manageable.map((x) => x.id)))).orderBy(asc(properties.name), asc(buildings.name)) : [];
    return { properties: manageable, buildings: blds, orgWide: canManageKnowledge(p, { orgId: p.orgId, propertyId: null }) };
  });
}

// the document page's "assistant index" line
export async function documentIndexInfo(ctx: TenantCtx, documentId: string): Promise<IndexInfo | null> {
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(kbSources).where(and(eq(kbSources.documentId, documentId), eq(kbSources.orgId, ctx.principal.orgId)));
    return indexInfo(s, embeddings().model.id);
  });
}
