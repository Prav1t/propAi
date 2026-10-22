import "server-only";
import { and, eq } from "drizzle-orm";
import { withContext } from "../db/client";
import { integrations } from "../db/schema";
import { authorize, NotFoundError } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { seal, unseal } from "../keyring";
import { log } from "../log";
import { assertFeature, loadEntitlements } from "../billing/entitlements";
import { INTEGRATIONS, isE164, isIntegrationKey, validateIntegration, type ChatProvider, type IntegrationKey } from "@/lib/integrations";
import { postChatMessage, sendSms, type SmsCreds } from "./adapters";
import { BRAND } from "@/config/brand";

// Integrations (Iteration 10): connect / test / disconnect, and the calls automation rules make.

export type IntegrationView = {
  key: IntegrationKey; connected: boolean; status: string | null; config: Record<string, string>; secretHints: Record<string, string>;
  lastUsedAt: Date | null; lastError: string | null; connectedAt: Date | null;
};

const mask = (s: string) => (s.length <= 8 ? "••••" : `••••${s.slice(-4)}`);

export async function listIntegrations(ctx: TenantCtx): Promise<IntegrationView[]> {
  authorize(ctx.principal, "integration.manage");
  const rows = await tenantTx(ctx, (tx) => tx.select().from(integrations).where(eq(integrations.orgId, ctx.principal.orgId)));
  return (Object.keys(INTEGRATIONS) as IntegrationKey[]).map((key) => {
    const r = rows.find((x) => x.provider === key);
    let hints: Record<string, string> = {};
    if (r?.credentialsEnc) {
      try {
        hints = Object.fromEntries(Object.entries(JSON.parse(unseal(r.credentialsEnc)) as Record<string, string>).map(([k, v]) => [k, mask(v)]));
      } catch { /* unreadable after a key rotation: shown as connected without hints */ }
    }
    return { key, connected: !!r, status: r?.status ?? null, config: (r?.config ?? {}) as Record<string, string>, secretHints: hints, lastUsedAt: r?.lastUsedAt ?? null, lastError: r?.lastError ?? null, connectedAt: r?.createdAt ?? null };
  });
}

export async function connectIntegration(ctx: TenantCtx, key: string, values: Record<string, string>) {
  authorize(ctx.principal, "integration.manage");
  if (!isIntegrationKey(key)) throw new NotFoundError();
  await assertFeature(ctx.principal.orgId, "integrations");
  const errors = validateIntegration(key, values);
  const first = Object.entries(errors)[0];
  if (first) throw new ValidationError(first[1], first[0]);
  const def = INTEGRATIONS[key];
  const secrets: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const f of def.fields) {
    const v = values[f.key]?.trim();
    if (!v) continue;
    if (f.secret) secrets[f.key] = v;
    else config[f.key] = v;
  }
  await tenantTx(ctx, async (tx) => {
    const values = { config, credentialsEnc: seal(JSON.stringify(secrets)), status: "connected", lastError: null, connectedByUserId: ctx.principal.userId };
    await tx.insert(integrations).values({ orgId: ctx.principal.orgId, provider: key, ...values })
      .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: values });
    await auditAs(tx, ctx, "integration.connected", "integration", null, undefined, { provider: key, config }); // secrets never in the audit log
  });
}

export async function disconnectIntegration(ctx: TenantCtx, key: string) {
  authorize(ctx.principal, "integration.manage");
  if (!isIntegrationKey(key)) throw new NotFoundError();
  await tenantTx(ctx, async (tx) => {
    const rows = await tx.delete(integrations).where(and(eq(integrations.orgId, ctx.principal.orgId), eq(integrations.provider, key))).returning({ id: integrations.id });
    if (!rows.length) throw new NotFoundError();
    await auditAs(tx, ctx, "integration.disconnected", "integration", rows[0].id, { provider: key });
  });
}

async function loadCreds(orgId: string, key: IntegrationKey) {
  const [r] = await withContext({ orgId, system: true }, (tx) => tx.select().from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, key))));
  if (!r?.credentialsEnc) return null;
  return { row: r, creds: { ...(r.config as Record<string, string>), ...(JSON.parse(unseal(r.credentialsEnc)) as Record<string, string>) } };
}

async function record(orgId: string, key: IntegrationKey, error: string | null) {
  await withContext({ orgId, system: true }, (tx) => tx.update(integrations).set({ lastUsedAt: new Date(), lastError: error, status: error ? "error" : "connected" })
    .where(and(eq(integrations.orgId, orgId), eq(integrations.provider, key)))).catch(() => {});
}

// used by automation rules and by "Send test message"; throws a readable error on failure
export async function sendChatMessage(orgId: string, provider: ChatProvider, text: string): Promise<{ channel: string | null }> {
  const ent = await withContext({ orgId, system: true }, (tx) => loadEntitlements(tx, orgId));
  if (!ent.features.integrations) throw new ValidationError(`Integrations aren't included in the ${ent.plan.name} plan.`);
  const c = await loadCreds(orgId, provider);
  if (!c) throw new ValidationError(`${INTEGRATIONS[provider].name} isn't connected. Connect it in Organization → Integrations.`);
  try {
    await postChatMessage(provider, c.creds.webhookUrl, text);
    await record(orgId, provider, null);
    return { channel: c.creds.channel ?? null };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 300) || "The message wasn't accepted.";
    await record(orgId, provider, msg);
    log.warn("integrations.chat_failed", { orgId, provider, err: msg });
    throw new ValidationError(`Couldn't post to ${INTEGRATIONS[provider].name}: ${msg}`);
  }
}

export async function testIntegration(ctx: TenantCtx, key: string, opts: { to?: string } = {}): Promise<string> {
  authorize(ctx.principal, "integration.manage");
  if (!isIntegrationKey(key)) throw new NotFoundError();
  await assertFeature(ctx.principal.orgId, "integrations");
  const orgId = ctx.principal.orgId;
  if (key === "twilio") {
    const to = opts.to?.trim() ?? "";
    if (!isE164(to)) throw new ValidationError("Enter the number to text in international format, like +16045550100.", "to");
    const c = await loadCreds(orgId, key);
    if (!c) throw new ValidationError("Twilio isn't connected.");
    try {
      await sendSms(c.creds as unknown as SmsCreds, to, `Test message from ${BRAND.name}: your Twilio connection works.`);
      await record(orgId, key, null);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 300) || "Twilio didn't accept the message.";
      await record(orgId, key, msg);
      throw new ValidationError(`The test SMS failed: ${msg}`);
    }
    await tenantTx(ctx, (tx) => auditAs(tx, ctx, "integration.tested", "integration", null, undefined, { provider: key }));
    return `Test SMS sent to ${to}.`;
  }
  const r = await sendChatMessage(orgId, key, `Test message from ${BRAND.name}: automation rules can post here.`);
  await tenantTx(ctx, (tx) => auditAs(tx, ctx, "integration.tested", "integration", null, undefined, { provider: key }));
  return `Test message posted${r.channel ? ` to ${r.channel}` : ""}.`;
}

// connected chat providers, for the rule builder
export async function connectedChat(orgId: string): Promise<{ provider: ChatProvider; name: string; channel: string | null }[]> {
  const rows = await withContext({ orgId, system: true }, (tx) => tx.select().from(integrations).where(eq(integrations.orgId, orgId)));
  return rows.filter((r) => r.provider === "slack" || r.provider === "teams")
    .map((r) => ({ provider: r.provider as ChatProvider, name: INTEGRATIONS[r.provider as ChatProvider].name, channel: ((r.config as Record<string, string>).channel ?? null) }));
}
