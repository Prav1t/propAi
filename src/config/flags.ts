// Feature flags (Iteration 10): gradual release switches. Resolution order, most specific first:
//   organization override (platform admin) → global override (platform admin) → environment FLAG_<KEY>=true|false → default.
// Flags gate rollout; plans gate what a customer pays for. Both are checked together in server/billing/entitlements.ts.

export const FLAGS = {
  public_api: { default: true, label: "REST API", description: "The /api/v1 REST API and API keys." },
  webhooks: { default: true, label: "Webhooks", description: "Outgoing signed webhooks and the delivery log." },
  integrations: { default: true, label: "Integrations", description: "Slack, Microsoft Teams and Twilio connections and the chat automation action." },
  advanced_analytics: { default: true, label: "Property health & insights", description: "Health scores and proactive insights on the analytics page and in the assistant." },
  self_serve_billing: { default: true, label: "Self-serve plan changes", description: "Organization admins can change plans themselves; when off, the billing page asks them to contact support." },
} as const;

export type FlagKey = keyof typeof FLAGS;
export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];
export const isFlagKey = (v: unknown): v is FlagKey => typeof v === "string" && v in FLAGS;

// environment default for a flag (FLAG_PUBLIC_API=false)
export function envFlag(key: FlagKey, env: Record<string, string | undefined> = process.env): boolean {
  const v = env[`FLAG_${key.toUpperCase()}`];
  if (v === "true" || v === "1" || v === "on") return true;
  if (v === "false" || v === "0" || v === "off") return false;
  return FLAGS[key].default;
}

// pure resolution over stored overrides
export function resolveFlags(overrides: { key: string; orgId: string | null; enabled: boolean }[], orgId: string | null, env?: Record<string, string | undefined>): Record<FlagKey, boolean> {
  const out = {} as Record<FlagKey, boolean>;
  for (const k of FLAG_KEYS) {
    const org = orgId ? overrides.find((o) => o.key === k && o.orgId === orgId) : undefined;
    const global = overrides.find((o) => o.key === k && o.orgId === null);
    out[k] = org ? org.enabled : global ? global.enabled : envFlag(k, env);
  }
  return out;
}
