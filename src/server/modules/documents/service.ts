import "server-only";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { buildings, documentVersions, documents, files, properties, units, users, DOCUMENT_CATEGORIES } from "../../db/schema";
import { authorize, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { matches, pageArgs, toPage, toPrefixQuery, visiblePropertyIds, type Page } from "../scope";
import { fileRows, prepareFiles, withStoredBlobs } from "../../files/service";
import { DOCUMENT_TYPES } from "../../files/sniff";
import { canManageDocument, canReadDocument, documentVisibleWhere } from "./access";
import { queueIndex } from "../../kb/indexer";
import { emit } from "../ops/core";

type DocRow = typeof documents.$inferSelect;

export const canUseDocuments = (p: Principal) => p.permissions.has("document.read") || p.permissions.has("document.manage");

export type DocumentListRow = { id: string; title: string; description: string | null; category: string; audience: string; important: boolean; status: string; currentVersion: number; updatedAt: Date; propertyName: string | null; buildingName: string | null; unitNumber: string | null; fileId: string | null; filename: string | null; sizeBytes: number | null; contentType: string | null };

export async function listDocuments(ctx: TenantCtx, opts: { q?: string; category?: string; propertyId?: string; view?: "active" | "archived"; importantOnly?: boolean; page?: number; pageSize?: number }): Promise<Page<DocumentListRow>> {
  const p = ctx.principal;
  if (!canUseDocuments(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize);
  const tsq = toPrefixQuery(opts.q);
  const archived = opts.view === "archived" && p.role.category === "staff";
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(documents.orgId, p.orgId), documentVisibleWhere(p), eq(documents.status, archived ? "archived" : "active"),
      opts.category ? eq(documents.category, opts.category) : undefined, opts.propertyId ? eq(documents.propertyId, opts.propertyId) : undefined,
      opts.importantOnly ? eq(documents.important, true) : undefined, tsq ? matches("documents", tsq) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(documents).where(where);
    const rows = await tx.select({
      id: documents.id, title: documents.title, description: documents.description, category: documents.category, audience: documents.audience, important: documents.important,
      status: documents.status, currentVersion: documents.currentVersion, updatedAt: documents.updatedAt, propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number,
      fileId: files.id, filename: files.filename, sizeBytes: files.sizeBytes, contentType: files.contentType,
    }).from(documents).leftJoin(properties, eq(properties.id, documents.propertyId)).leftJoin(buildings, eq(buildings.id, documents.buildingId)).leftJoin(units, eq(units.id, documents.unitId))
      .leftJoin(documentVersions, and(eq(documentVersions.documentId, documents.id), eq(documentVersions.version, documents.currentVersion)))
      .leftJoin(files, eq(files.id, documentVersions.fileId))
      .where(where).orderBy(desc(documents.important), asc(documents.category), asc(documents.title)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

async function loadDoc(tx: Tx, orgId: string, id: string) {
  const [d] = await tx.select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, orgId)));
  if (!d) throw new NotFoundError();
  return d;
}

export async function getDocument(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const d = await loadDoc(tx, p.orgId, id);
    if (!canReadDocument(p, d)) throw new NotFoundError();
    const manage = canManageDocument(p, d);
    const staff = manage || p.role.category === "staff";
    const versions = await tx.select({ v: documentVersions, file: files, uploader: users.name }).from(documentVersions)
      .innerJoin(files, eq(files.id, documentVersions.fileId)).leftJoin(users, eq(users.id, documentVersions.uploadedByUserId))
      .where(and(eq(documentVersions.documentId, id), staff ? undefined : eq(documentVersions.version, d.currentVersion))).orderBy(desc(documentVersions.version));
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number }).from(documents)
      .leftJoin(properties, eq(properties.id, documents.propertyId)).leftJoin(buildings, eq(buildings.id, documents.buildingId)).leftJoin(units, eq(units.id, documents.unitId))
      .where(eq(documents.id, id));
    // reading a document is an access event worth auditing (downloads are audited separately)
    await auditAs(tx, ctx, "document.viewed", "document", id);
    return { document: d, versions, labels, canManage: manage };
  });
}

export const documentSchema = z.object({
  title: z.string().trim().min(2, "Add a title.").max(160),
  description: z.string().trim().max(2000).optional().transform(blankToNull),
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  audience: z.enum(["staff", "residents", "owners"]).default("residents"),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  buildingId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  unitNumber: z.string().trim().max(20).optional().transform(blankToNull),
  important: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
  notes: z.string().trim().max(500).optional().transform(blankToNull),
});
export type DocumentInput = z.infer<typeof documentSchema>;

async function resolvePlace(tx: Tx, p: Principal, input: DocumentInput) {
  let buildingId = input.buildingId, unitId: string | null = null;
  if (buildingId) {
    const [b] = await tx.select().from(buildings).where(and(eq(buildings.id, buildingId), eq(buildings.orgId, p.orgId)));
    if (!b || (input.propertyId && b.propertyId !== input.propertyId)) throw new ValidationError("That building isn't part of the property.", "buildingId");
  }
  if (input.unitNumber) {
    if (!buildingId) throw new ValidationError("Choose the building for a unit document.", "buildingId");
    const [u] = await tx.select({ id: units.id }).from(units).where(and(eq(units.buildingId, buildingId), sql`lower(${units.number}) = lower(${input.unitNumber})`));
    if (!u) throw new ValidationError(`No unit ${input.unitNumber} in that building.`, "unitNumber");
    unitId = u.id;
  }
  if (!input.propertyId) {
    if (buildingId) throw new ValidationError("Choose the property.", "propertyId");
    buildingId = null;
  }
  const place = { orgId: p.orgId, propertyId: input.propertyId, buildingId, unitId, audience: input.audience, status: "active" };
  if (!canManageDocument(p, place)) {
    if (!input.propertyId && p.role.scopeLevel !== "org") throw new ValidationError("Organization-wide documents need an organization-wide role. Choose one of your properties.", "propertyId");
    throw new ForbiddenError();
  }
  return { buildingId, unitId };
}

export async function createDocument(ctx: TenantCtx, input: DocumentInput, upload: File | null) {
  const p = ctx.principal;
  if (!upload || upload.size === 0) throw new ValidationError("Choose a file.", "files");
  authorize(p, "document.manage");
  const prepared = await prepareFiles(p.orgId, "document", [upload], DOCUMENT_TYPES);
  return withStoredBlobs(prepared, () => tenantTx(ctx, async (tx) => {
    const place = await resolvePlace(tx, p, input);
    const [d] = await tx.insert(documents).values({
      orgId: p.orgId, propertyId: input.propertyId, ...place, title: input.title, description: input.description, category: input.category,
      audience: input.audience, important: input.important, currentVersion: 1, createdByUserId: p.userId,
    }).returning();
    const [f] = await tx.insert(files).values(fileRows(prepared, p, "document", d.id, "public")).returning();
    await tx.insert(documentVersions).values({ orgId: p.orgId, documentId: d.id, version: 1, fileId: f.id, notes: input.notes, uploadedByUserId: p.userId });
    await queueIndex(tx, { orgId: p.orgId, documentId: d.id, version: 1 }); // the assistant can answer from it once indexed
    await auditAs(tx, ctx, "document.created", "document", d.id, undefined, { title: d.title, audience: d.audience, file: f.filename });
    await emit(tx, ctx, "document.uploaded", { documentId: d.id, version: 1 });
    return d;
  }));
}

// a new version becomes current; the previous file stays for staff but is hidden from residents
export async function addDocumentVersion(ctx: TenantCtx, id: string, upload: File | null, notes: string | null) {
  const p = ctx.principal;
  if (!upload || upload.size === 0) throw new ValidationError("Choose a file.", "files");
  const prepared = await prepareFiles(p.orgId, "document", [upload], DOCUMENT_TYPES);
  return withStoredBlobs(prepared, () => tenantTx(ctx, async (tx) => {
    const [d] = await tx.select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, p.orgId))).for("update");
    if (!d) throw new NotFoundError();
    if (!canManageDocument(p, d)) throw canReadDocument(p, d) ? new ForbiddenError() : new NotFoundError();
    const version = d.currentVersion + 1;
    const [f] = await tx.insert(files).values(fileRows(prepared, p, "document", d.id, "public")).returning();
    await tx.update(files).set({ visibility: "internal" }).where(and(eq(files.entityType, "document"), eq(files.entityId, d.id), sql`${files.id} <> ${f.id}`));
    await tx.insert(documentVersions).values({ orgId: p.orgId, documentId: d.id, version, fileId: f.id, notes, uploadedByUserId: p.userId });
    await tx.update(documents).set({ currentVersion: version }).where(eq(documents.id, d.id));
    await queueIndex(tx, { orgId: p.orgId, documentId: d.id, version }); // older versions' passages are replaced
    await auditAs(tx, ctx, "document.version_added", "document", d.id, { version: d.currentVersion }, { version, file: f.filename });
    await emit(tx, ctx, "document.uploaded", { documentId: d.id, version });
    return version;
  }));
}

export const documentMetaSchema = documentSchema.pick({ title: true, description: true, category: true, audience: true, important: true });

export async function updateDocument(ctx: TenantCtx, id: string, input: z.infer<typeof documentMetaSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const d = await loadDoc(tx, p.orgId, id);
    if (!canManageDocument(p, d)) throw canReadDocument(p, d) ? new ForbiddenError() : new NotFoundError();
    const [after] = await tx.update(documents).set(input).where(eq(documents.id, id)).returning();
    // passages carry the title for search and citations; audience and status are checked live at retrieval
    if (after.title !== d.title) await queueIndex(tx, { orgId: p.orgId, documentId: id, version: after.currentVersion });
    await auditAs(tx, ctx, "document.updated", "document", id, { title: d.title, audience: d.audience, category: d.category }, input);
    return after;
  });
}

export async function setDocumentArchived(ctx: TenantCtx, id: string, archived: boolean) {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const d = await loadDoc(tx, p.orgId, id);
    if (!canManageDocument(p, d)) throw canReadDocument(p, d) ? new ForbiddenError() : new NotFoundError();
    await tx.update(documents).set({ status: archived ? "archived" : "active" }).where(eq(documents.id, id));
    await auditAs(tx, ctx, archived ? "document.archived" : "document.restored", "document", id);
  });
}

export async function documentFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined)).orderBy(asc(properties.name));
    const manageable = props.filter((x) => canManageDocument(p, { orgId: p.orgId, propertyId: x.id, buildingId: null, unitId: null, audience: "residents", status: "active" }));
    const blds = manageable.length ? await tx.select({ id: buildings.id, name: buildings.name, propertyId: buildings.propertyId, propertyName: properties.name }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId)).where(and(eq(buildings.orgId, p.orgId), inArray(buildings.propertyId, manageable.map((x) => x.id)))).orderBy(asc(properties.name), asc(buildings.name)) : [];
    return { properties: manageable, buildings: blds, orgWide: p.role.scopeLevel === "org" && p.permissions.has("document.manage") };
  });
}

export type { DocRow };
