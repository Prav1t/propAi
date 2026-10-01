import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { complaints, files, incidents, inspections, workOrders } from "../db/schema";
import { can, ForbiddenError, NotFoundError, type Principal } from "../authz/authorize";
import type { Tx } from "../db/client";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { addTimeline, type Visibility } from "../modules/ops/core";
import { canSeeWo, visibleLevels, woAccess } from "../modules/maintenance/service";
import { blobStore, fileScanner } from "./storage";
import { MAX_BYTES, sniff } from "./sniff";

export const ATTACHABLE = ["work_order", "incident", "complaint", "inspection"] as const;
export type Attachable = (typeof ATTACHABLE)[number];
export const MAX_FILES_PER_UPLOAD = 5;

type Levels = { read: Visibility[]; write: Visibility[] } | null;

// what a principal may read/attach on an entity; null = can't see it at all
async function levelsFor(tx: Tx, p: Principal, entityType: Attachable, entityId: string): Promise<Levels> {
  const all: Visibility[] = ["public", "vendor", "internal"];
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
    if (staff) return { read: all, write: all };
    return i.reportedByUserId === p.userId ? { read: ["public"], write: ["public"] } : null;
  }
  if (entityType === "complaint") {
    const [c] = await tx.select().from(complaints).where(and(eq(complaints.id, entityId), eq(complaints.orgId, p.orgId)));
    if (!c) return null;
    const staff = can(p, "complaint.read", { orgId: p.orgId, propertyId: c.propertyId, buildingId: c.buildingId }) || c.assignedMembershipId === p.membershipId;
    if (staff) return { read: all, write: all };
    return c.submittedByUserId === p.userId ? { read: ["public"], write: ["public"] } : null;
  }
  const [insp] = await tx.select().from(inspections).where(and(eq(inspections.id, entityId), eq(inspections.orgId, p.orgId)));
  if (!insp) return null;
  const ok = can(p, "inspection.read", { orgId: p.orgId, propertyId: insp.propertyId, buildingId: insp.buildingId }) || insp.inspectorMembershipId === p.membershipId;
  return ok ? { read: all, write: all } : null;
}

// stores uploads after sniffing real type, enforcing size limits, and scanning
export async function uploadFiles(ctx: TenantCtx, entityType: Attachable, entityId: string, uploads: File[], visibility: Visibility) {
  const p = ctx.principal;
  if (!ATTACHABLE.includes(entityType)) throw new ValidationError("Unsupported attachment target.");
  const real = uploads.filter((f) => f && f.size > 0);
  if (!real.length) throw new ValidationError("Choose at least one file.", "files");
  if (real.length > MAX_FILES_PER_UPLOAD) throw new ValidationError(`Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`, "files");

  const levels = await tenantTx(ctx, (tx) => levelsFor(tx, p, entityType, entityId));
  if (!levels) throw new NotFoundError();
  if (!levels.write.includes(visibility)) throw new ForbiddenError("You can't share files at that visibility.");

  const prepared: { bytes: Uint8Array; kind: NonNullable<ReturnType<typeof sniff>>; scan: string; filename: string; sha256: string; key: string }[] = [];
  for (const f of real) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = sniff(bytes);
    if (!kind) throw new ValidationError(`“${f.name}” isn't a supported file. Use JPG, PNG, WebP, GIF, HEIC, PDF, MP4 or MOV.`, "files");
    if (bytes.length > MAX_BYTES[kind.mime]) throw new ValidationError(`“${f.name}” is too large (max ${Math.round(MAX_BYTES[kind.mime] / 1_000_000)} MB).`, "files");
    const scan = await fileScanner().scan(bytes);
    if (scan === "infected") throw new ValidationError(`“${f.name}” was blocked by the malware scanner.`, "files");
    const safeName = (f.name || `file.${kind.ext}`).replace(/[^\w.\- ]+/g, "_").slice(-120);
    prepared.push({ bytes, kind, scan, filename: safeName, sha256: createHash("sha256").update(bytes).digest("hex"), key: `${p.orgId}/${entityType}/${randomUUID()}` });
  }
  const store = blobStore();
  for (const x of prepared) await store.put(x.key, x.bytes, x.kind.mime);
  try {
    return await tenantTx(ctx, async (tx) => {
      const rows = await tx.insert(files).values(prepared.map((x) => ({
        orgId: p.orgId, entityType, entityId, storageKey: x.key, filename: x.filename, contentType: x.kind.mime, sizeBytes: x.bytes.length,
        sha256: x.sha256, visibility, scanStatus: x.scan, uploadedByUserId: p.userId,
      }))).returning();
      await addTimeline(tx, ctx, { entityType, entityId, kind: "attachment", visibility, body: `Attached ${rows.map((r) => r.filename).join(", ")}.` });
      await auditAs(tx, ctx, "file.uploaded", entityType, entityId, undefined, rows.map((r) => ({ id: r.id, filename: r.filename, size: r.sizeBytes, type: r.contentType })));
      return rows;
    });
  } catch (e) {
    for (const x of prepared) await store.delete(x.key); // don't orphan blobs
    throw e;
  }
}

// permission-checked download; every access is audit-logged
export async function openFile(ctx: TenantCtx, fileId: string) {
  const p = ctx.principal;
  const f = await tenantTx(ctx, async (tx) => {
    const [f] = await tx.select().from(files).where(and(eq(files.id, fileId), eq(files.orgId, p.orgId)));
    if (!f) throw new NotFoundError();
    const levels = await levelsFor(tx, p, f.entityType as Attachable, f.entityId);
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
