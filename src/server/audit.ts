import "server-only";
import type { Tx } from "./db/client";
import { auditLogs } from "./db/schema";
import type { RequestMeta } from "./request-meta";

export type AuditEntry = {
  orgId: string | null;
  actorUserId: string | null;
  action: string; // e.g. "member.invited", "org.settings.updated"
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  aiGenerated?: boolean;
  approvalId?: string | null;
};

// strips secrets before persisting snapshots
const SECRET_KEYS = /password|secret|token|hash/i;
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(val)]),
    );
  }
  return v;
}

// always call inside the same transaction as the change it describes
export async function writeAudit(tx: Tx, entry: AuditEntry, meta?: RequestMeta | null): Promise<void> {
  await tx.insert(auditLogs).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
    requestId: meta?.requestId ?? null,
    aiGenerated: entry.aiGenerated ?? false,
    approvalId: entry.approvalId ?? null,
  });
}
