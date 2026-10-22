"use server";
import { getOrgContext } from "@/server/org-context";
import { verifyOrgAuditChain } from "@/server/audit-integrity";
import { toActionError, type ActionState } from "@/server/actions";

// recomputes this organization's audit hash chain
export async function verifyAuditAction(slug: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx } = await getOrgContext(slug);
    const r = await verifyOrgAuditChain(ctx);
    if (r.problem) return { error: `Integrity problem at entry ${r.problemSeq}: ${r.problem}. ${r.checked} entries before it check out.` };
    return { ok: true, message: r.checked ? `All ${r.checked} entries check out (entries ${r.firstSeq}–${r.lastSeq}): nothing has been changed, removed or reordered.` : "No entries yet." };
  } catch (e) {
    return toActionError(e);
  }
}
