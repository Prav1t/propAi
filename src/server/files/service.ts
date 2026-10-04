import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { complaints, documents, files, incidents, inspections, packages, workOrders } from "../db/schema";
import { can, ForbiddenError, NotFoundError, type Principal } from "../authz/authorize";
import type { Tx } from "../db/client";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { addTimeline, type Visibility } from "../modules/ops/core";
import { canSeeWo, visibleLevels, woAccess } from "../modules/maintenance/service";
import { canManageDocument, canReadDocument } from "../modules/documents/access";
import { blobStore, fileScanner } from "./storage";
import { DOCUMENT_TYPES, MAX_BYTES, MEDIA_TYPES, sniff } from "./sniff";

export const ATTACHABLE = ["work_order", "incident", "complaint", "inspection", "package"] as const;
export type Attachable = (typeof ATTACHABLE)[number];
export type FileOwner = Attachable | "document";
export const MAX_FILES_PER_UPLOAD = 5;

type Levels = { read: Visibility[]; write: Visibility[] } | null;
const ALL: Visibility[] = ["public", "vendor", "internal"];

// what a principal may read/attach on an entity; null = can't see it at all
async function levelsFor(tx: Tx, p: Principal, entityType: FileOwner, entityId: string): Promise<Levels> {
  if (entityType === "work_order") {
    const [wo] = await tx.select().from(workOrders).where(and(eq(workOrders.id, entityId), eq(workOrders.orgId, p.orgId)));
    if (!wo) return null;
    const a = woAccess(p, wo);
    if (!canSeeWo(a)) return null;
    const read = visibleLevels(a);
    return { read, write: read };
  }
  if (entityType === "incident") {
    const [i] = await tx.select().from(incidents).where(and(eq(incidents.id, entityId), eq(incidents.orgId, p.orgId)));
    if (!i) return null;
    const staff = can(p, "incident.read", { orgId: p.orgId, propertyId: i.propertyId, buildingId: i.buildingId });
    if (staff) return { read: ALL, write: ALL };
    return i.reportedByUserId === p.userId ? { read: ["public"], write: ["public"] } : null;
  }
  if (entityType === "complaint") {
    const [c] = await tx.select().from(complaints).where(and(eq(complaints.id, entityId), eq(complaints.orgId, p.orgId)));
    if (!c) return null;
    const staff = can(p, "complaint.read", { orgId: p.orgId, propertyId: c.propertyId, buildingId: c.buildingId }) || c.assignedMembershipId === p.membershipId;
    if (staff) return { read: ALL, write: ALL };
    return c.submittedByUserId === p.userId ? { read: ["public"], write: ["public"] } : null;
  }
  if (entityType === "package") {
    const [k] = await tx.select().from(packages).where(and(eq(packages.id, entityId), eq(packages.orgId, p.orgId)));
    if (!k) return null;
    if (can(p, "package.manage", { orgId: p.orgId, propertyId: k.propertyId, buildingId: k.buildingId })) return { read: ALL, write: ALL };
    // residents see the arrival photo of their own unit's packages (signatures are internal)
    return p.permissions.has("package.read.own") && p.unitIds.has(k.unitId) ? { read: ["public"], write: [] } : null;
  }
  if (entityType === "document") {
    const [d] = await tx.select().from(documents).where(and(eq(documents.id, entityId), eq(documents.orgId, p.orgId)));
    if (!d || !canReadDocument(p, d)) return null;
    // superseded versions are internal, so residents only ever get the current file
    return canManageDocument(p, d) || p.role.category === "staff" ? { read: ALL, write: [] } : { read: ["public"], write: [] };
  }
  const [insp] = await tx.select().from(inspections).where(and(eq(inspections.id, entityId), eq(inspections.orgId, p.orgId)));
  if (!insp) return null;
  const ok = can(p, "inspection.read", { orgId: p.orgId, propertyId: insp.propertyId, buildingId: insp.buildingId }) || insp.inspectorMembershipId === p.membershipId;
  return ok ? { read: ALL, write: ALL } : null;
}

export type PreparedFile = { bytes: Uint8Array; mime: string; scan: string; filename: string; sha256: string; key: string };

// validates uploads without storing anything: real type from content, per-type size limits, scanner hook
export async function prepareFiles(orgId: string, owner: FileOwner, uploads: File[], allowed: string[] = MEDIA_TYPES): Promise<PreparedFile[]> {
  const real = uploads.filter((f) => f && f.size > 0);
  if (real.length > MAX_FILES_PER_UPLOAD) throw new ValidationError(`Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`, "files");
  const out: PreparedFile[] = [];
  for (const f of real) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = sniff(bytes, f.name);
    if (!kind || !allowed.includes(kind.mime)) {
      const list = allowed === DOCUMENT_TYPES ? "PDF, Word, Excel, PowerPoint, text, CSV, JPG or PNG" : "JPG, PNG, WebP, GIF, HEIC, PDF, MP4 or MOV";
      throw new ValidationError(`“${f.name}” isn't a supported file. Use ${list}.`, "files");
    }
    if (bytes.length > MAX_BYTES[kind.mime]) throw new ValidationError(`“${f.name}” is too large (max ${Math.round(MAX_BYTES[kind.mime] / 1_000_000)} MB).`, "files");
    const scan = await fileScanner().scan(bytes);
    if (scan === "infected") throw new ValidationError(`“${f.name}” was blocked by the malware scanner.`, "files");
    const safeName = (f.name || `file.${kind.ext}`).replace(/[^\w.\- ]+/g, "_").slice(-120);
    out.push({ bytes, mime: kind.mime, scan, filename: safeName, sha256: createHash("sha256").update(bytes).digest("hex"), key: `${orgId}/${owner}/${randomUUID()}` });
  }
  return out;
}

// writes blobs, runs the database work, and removes the blobs again if that work fails
export async function withStoredBlobs<T>(prepared: PreparedFile[], fn: () => Promise<T>): Promise<T> {
  const store = blobStore();
  for (const x of prepared) await store.put(x.key, x.bytes, x.mime);
  try {
    return await fn();
  } catch (e) {
    for (const x of prepared) await store.delete(x.key); // don't orphan blobs
    throw e;
  }
}

export function fileRows(prepared: PreparedFile[], p: Principal, entityType: FileOwner, entityId: string, visibility: Visibility) {
  return prepared.map((x) => ({
    orgId: p.orgId, entityType, entityId, storageKey: x.key, filename: x.filename, contentType: x.mime, sizeBytes: x.bytes.length,
    sha256: x.sha256, visibility, scanStatus: x.scan, uploadedByUserId: p.userId,
  }));
}

// attachments on operational records (documents have their own versioned upload)
export async function uploadFiles(ctx: TenantCtx, entityType: Attachable, entityId: string, uploads: File[], visibility: Visibility) {
  const p = ctx.principal;
  if (!ATTACHABLE.includes(entityType)) throw new ValidationError("Unsupported attachment target.");
  if (!uploads.some((f) => f && f.size > 0)) throw new ValidationError("Choose at least one file.", "files");
  const levels = await tenantTx(ctx, (tx) => levelsFor(tx, p, entityType, entityId));
  if (!levels) throw new NotFoundError();
  if (!levels.write.includes(visibility)) throw new ForbiddenError("You can't share files at that visibility.");
  const prepared = await prepareFiles(p.orgId, entityType, uploads);
  return withStoredBlobs(prepared, () => tenantTx(ctx, async (tx) => {
    const rows = await tx.insert(files).values(fileRows(prepared, p, entityType, entityId, visibility)).returning();
    if (entityType !== "package") await addTimeline(tx, ctx, { entityType, entityId, kind: "attachment", visibility, body: `Attached ${rows.map((r) => r.filename).join(", ")}.` });
    await auditAs(tx, ctx, "file.uploaded", entityType, entityId, undefined, rows.map((r) => ({ id: r.id, filename: r.filename, size: r.sizeBytes, type: r.contentType })));
    return rows;
  }));
}

// permission-checked download; every access is audit-logged
export async function openFile(ctx: TenantCtx, fileId: string) {
  const p = ctx.principal;
  const f = await tenantTx(ctx, async (tx) => {
    const [f] = await tx.select().from(files).where(and(eq(files.id, fileId), eq(files.orgId, p.orgId)));
    if (!f) throw new NotFoundError();
    const levels = await levelsFor(tx, p, f.entityType as FileOwner, f.entityId);
    if (!levels || !levels.read.includes(f.visibility as Visibility)) throw new NotFoundError();
    await auditAs(tx, ctx, "file.downloaded", "file", f.id);
    return f;
  });
  // only raster images render inline; everything else downloads
  const inline = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(f.contentType);
  const store = blobStore();
  const signed = await store.signedUrl(f.storageKey, f.filename, inline, 60);
  if (signed) return { kind: "redirect" as const, url: signed };
  return { kind: "bytes" as const, bytes: await store.get(f.storageKey), file: f, inline };
}
