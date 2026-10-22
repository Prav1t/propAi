"use server";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { requireRecentAuth } from "@/server/reauth";
import { verifyAllAuditChains } from "@/server/audit-integrity";
import { adminSetOrganizationStatus } from "@/server/modules/organizations/service";
import { adminSetFlag, adminUpdateSubscription } from "@/server/billing/admin";
import { requestMeta } from "@/server/request-meta";
import { str, toActionError, type ActionState } from "@/server/actions";
import { isPlanKey, LIMITS, type LimitKey } from "@/config/plans";
import type { LimitOverrides } from "@/lib/billing";

// platform administration: platform admins only, with a recent sign-in (F-09)
async function admin() {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  await requireRecentAuth("/admin");
  return s.user.id;
}

export async function setOrgStatusAction(fd: FormData): Promise<void> {
  const actor = await admin();
  const status = str(fd, "status") === "active" ? "active" : "suspended";
  await adminSetOrganizationStatus(actor, str(fd, "orgId"), status, await requestMeta());
  revalidatePath("/admin");
}

// "" = leave as is, "default" = remove the override, "on"/"off" = force
export async function setFlagAction(orgId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  try {
    const v = str(fd, "value");
    await adminSetFlag(actor, str(fd, "key"), orgId, v === "on" ? true : v === "off" ? false : null);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Saved." };
}

export async function updateSubscriptionAction(orgId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await admin();
  const values: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) values[k] = v;
  const planKey = str(fd, "planKey");
  if (!isPlanKey(planKey)) return { error: "Choose a plan.", values };
  const overrides: LimitOverrides = {};
  for (const k of Object.keys(LIMITS) as LimitKey[]) {
    const raw = str(fd, `limit_${k}`).trim();
    if (raw === "") continue; // plan default
    if (raw.toLowerCase() === "unlimited") { overrides[k] = null; continue; }
    const n = Number(raw.replace(/[, ]/g, ""));
    if (!Number.isInteger(n) || n < 0) return { error: "Limits are whole numbers, “unlimited”, or blank for the plan default.", fieldErrors: { [`limit_${k}`]: "Enter a whole number." }, values };
    overrides[k] = n;
  }
  const extend = Number(str(fd, "extendTrialDays") || 0);
  const status = str(fd, "status");
  try {
    await adminUpdateSubscription(actor, orgId, {
      planKey, limitOverrides: overrides, extendTrialDays: extend > 0 ? Math.min(extend, 90) : undefined,
      status: status === "active" || status === "trialing" ? status : undefined,
    });
  } catch (e) {
    return toActionError(e, values);
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Subscription updated." };
}

// every audit chain, recomputed (read-only, so no recent sign-in needed)
export async function verifyAllAuditAction(_: ActionState): Promise<ActionState> {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const chains = await verifyAllAuditChains();
  const bad = chains.filter((c) => c.problem);
  const total = chains.reduce((n, c) => n + c.checked, 0);
  if (bad.length) return { error: bad.map((c) => `${c.chainKey}: entry ${c.problemSeq} — ${c.problem}`).join("\n") };
  return { ok: true, message: `${chains.length} chains, ${total} entries: all intact.` };
}
