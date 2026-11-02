import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { workOrders } from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { tenantTx, ValidationError, type TenantCtx } from "../context";
import { assignWorkOrder, assignmentOptions, setWorkOrderPriority, transitionWorkOrder, woVisibleWhere } from "./service";
import { PRIORITY_ORDER } from "./rules";
import { listPropertyOptions } from "../portfolio/service";

// The same change to many work orders. Each one goes through the normal service call, so it gets its own permission
// check, audit entry, timeline line and events; one that can't be changed is reported and the rest still go ahead.

export const BULK_LIMIT = 100;

export const bulkSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assign"), target: z.string().regex(/^(member|vendor):[0-9a-f-]{36}$/, "Choose who to assign.") }),
  z.object({ op: z.literal("priority"), priority: z.enum(PRIORITY_ORDER as unknown as [string, ...string[]], { message: "Choose a priority." }) }),
  z.object({ op: z.literal("acknowledge") }),
  z.object({ op: z.literal("close") }),
]);
export type BulkInput = z.infer<typeof bulkSchema>;
export type BulkResult = { changed: number; unchanged: number; failed: { id: string; number: number | null; reason: string }[] };

const reason = (e: unknown) =>
  e instanceof ValidationError || e instanceof ForbiddenError ? e.message || "Not allowed."
    : e instanceof NotFoundError ? "Not found." : "Something went wrong.";

export async function bulkUpdateWorkOrders(ctx: TenantCtx, ids: string[], input: BulkInput): Promise<BulkResult> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new ValidationError("Select at least one work order.");
  if (unique.length > BULK_LIMIT) throw new ValidationError(`Select up to ${BULK_LIMIT} work orders at a time.`);
  if (!unique.every((id) => /^[0-9a-f-]{36}$/.test(id))) throw new ValidationError("Invalid selection.");
  const p = ctx.principal;
  // numbers for the summary, limited to what this person can see (anything else is reported as not found)
  const visible = await tenantTx(ctx, (tx) => tx.select({ id: workOrders.id, number: workOrders.number, status: workOrders.status })
    .from(workOrders).where(and(eq(workOrders.orgId, p.orgId), inArray(workOrders.id, unique), woVisibleWhere(p))));
  const byId = new Map(visible.map((w) => [w.id, w]));
  const out: BulkResult = { changed: 0, unchanged: 0, failed: [] };
  const [kind, targetId] = input.op === "assign" ? input.target.split(":") : [null, null];
  for (const id of unique) {
    const wo = byId.get(id);
    if (!wo) { out.failed.push({ id, number: null, reason: "Not found." }); continue; }
    try {
      if (input.op === "assign") {
        await assignWorkOrder(ctx, id, { membershipId: kind === "member" ? targetId : null, vendorId: kind === "vendor" ? targetId : null });
        out.changed++;
      } else if (input.op === "priority") {
        const r = await setWorkOrderPriority(ctx, id, input.priority as (typeof PRIORITY_ORDER)[number]);
        if (r.changed) out.changed++; else out.unchanged++;
      } else if (input.op === "acknowledge") {
        if (wo.status !== "new") { out.unchanged++; continue; }
        await transitionWorkOrder(ctx, id, { to: "acknowledged", note: null, resolutionNotes: null, cost: null });
        out.changed++;
      } else {
        if (wo.status === "closed") { out.unchanged++; continue; }
        if (wo.status !== "completed") throw new ValidationError("Only completed requests can be closed.");
        await transitionWorkOrder(ctx, id, { to: "closed", note: null, resolutionNotes: null, cost: null });
        out.changed++;
      }
    } catch (e) {
      if (!(e instanceof ValidationError || e instanceof ForbiddenError || e instanceof NotFoundError)) throw e;
      out.failed.push({ id, number: wo.number, reason: reason(e) });
    }
  }
  return out;
}

// who a manager can assign across the properties they manage (each work order still checks its own property)
export async function bulkAssignOptions(ctx: TenantCtx) {
  const props = await listPropertyOptions(ctx);
  const staff = new Map<string, string>();
  const vendors = new Map<string, string>();
  for (const prop of props.slice(0, 25)) {
    try {
      const o = await assignmentOptions(ctx, prop.id);
      for (const s of o.staff) staff.set(s.membershipId, s.name);
      for (const v of o.vendors) vendors.set(v.id, v.name);
    } catch (e) {
      if (!(e instanceof ForbiddenError || e instanceof NotFoundError)) throw e;
    }
  }
  const sort = (m: Map<string, string>) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { staff: sort(staff), vendors: sort(vendors) };
}
