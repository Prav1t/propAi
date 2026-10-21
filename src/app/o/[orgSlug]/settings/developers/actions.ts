"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getOrgContext } from "@/server/org-context";
import { assertWritable } from "@/server/billing/entitlements";
import { toActionError, str, type ActionState } from "@/server/actions";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { createApiKey, revokeApiKey } from "@/server/api/keys";
import { createEndpoint, deleteEndpoint, replayDelivery, rotateSecret, sendTestEvent, setEndpointActive, updateEndpoint } from "@/server/webhooks/service";
import { afterChange } from "@/server/after-change";

const base = (slug: string) => `/o/${slug}/settings/developers`;

// these forms carry multi-value fields (scopes, events), so they parse FormData themselves
async function run(slug: string, fd: FormData, fn: (ctx: TenantCtx) => Promise<Omit<ActionState, "ok">>, opts: { readOnlyOk?: boolean } = {}): Promise<ActionState> {
  const values: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) values[k] = v;
  try {
    const { ctx } = await getOrgContext(slug);
    if (!opts.readOnlyOk) await assertWritable(ctx.principal.orgId);
    const r = await fn(ctx);
    revalidatePath(base(slug), "layout");
    return { ok: true, ...r };
  } catch (e) {
    return toActionError(e, values);
  }
}

export async function createApiKeyAction(slug: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => {
    const r = await createApiKey(ctx, { name: str(fd, "name"), scopes: fd.getAll("scopes").map(String), propertyIds: fd.getAll("propertyIds").map(String).filter(Boolean), expiresInDays: str(fd, "expiresInDays") });
    return { message: "API key created.", data: { secret: r.token, label: "API key" } };
  });
}

export async function revokeApiKeyAction(slug: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => { await revokeApiKey(ctx, str(fd, "id")); return { message: "Key revoked." }; }, { readOnlyOk: true });
}

export async function createEndpointAction(slug: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => {
    const r = await createEndpoint(ctx, { url: str(fd, "url"), description: str(fd, "description"), events: fd.getAll("events").map(String) });
    return { message: "Endpoint added.", data: { secret: r.secret, label: "Signing secret", href: `${base(slug)}/webhooks/${r.id}` } };
  });
}

export async function updateEndpointAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => { await updateEndpoint(ctx, id, { url: str(fd, "url"), description: str(fd, "description"), events: fd.getAll("events").map(String) }); return { message: "Saved." }; });
}

export async function setEndpointActiveAction(slug: string, id: string, active: boolean, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => { await setEndpointActive(ctx, id, active); after(() => afterChange()); return { message: active ? "Switched on. Waiting deliveries will be sent." : "Switched off." }; }, { readOnlyOk: !active });
}

export async function rotateSecretAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => ({ message: "New secret created. The old one stops working now.", data: { secret: await rotateSecret(ctx, id), label: "Signing secret" } }));
}

export async function deleteEndpointAction(slug: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const r = await run(slug, fd, async (ctx) => { await deleteEndpoint(ctx, id); return {}; }, { readOnlyOk: true });
  if (r.ok) redirect(base(slug));
  return r;
}

export async function sendTestEventAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => {
    const d = await sendTestEvent(ctx, id);
    if (d.status === "succeeded") return { message: `Delivered — your endpoint answered ${d.lastStatusCode}.` };
    throw new ValidationError(`Not delivered: ${d.lastError ?? "no response"}. See the delivery log below.`);
  });
}

export async function replayDeliveryAction(slug: string, deliveryId: string, _: ActionState, fd: FormData) {
  return run(slug, fd, async (ctx) => {
    const d = await replayDelivery(ctx, deliveryId);
    if (d.status !== "succeeded") throw new ValidationError(`Sent again but not accepted: ${d.lastError ?? "no response"}.${d.status === "pending" ? " It will be retried." : ""}`);
    return { message: `Sent again — answered ${d.lastStatusCode}.` };
  });
}
