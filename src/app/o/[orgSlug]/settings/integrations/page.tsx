import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listIntegrations } from "@/server/integrations/service";
import { getEntitlements } from "@/server/billing/entitlements";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { INTEGRATIONS, PLANNED_INTEGRATIONS } from "@/lib/integrations";
import { connectIntegrationAction, disconnectIntegrationAction, testIntegrationAction } from "./actions";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage({ params }: PageProps<"/o/[orgSlug]/settings/integrations">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("integration.manage")) notFound();
  const [items, ent] = await Promise.all([listIntegrations(ctx), getEntitlements(principal.orgId)]);
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) : "never");
  return (
    <>
      <PageHeader title="Integrations" description="Connect the tools your team already uses. Credentials are encrypted and never shown again in full." />
      {!ent.features.integrations ? (
        <FormAlert kind="info">{ent.plan.features.includes("integrations") ? "Integrations are switched off for your organization right now." : <>Integrations are included in the Professional and Enterprise plans. See <Link className="underline" href={`/o/${orgSlug}/settings/billing`}>Billing</Link>.</>}</FormAlert>
      ) : null}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {items.map((it) => {
          const def = INTEGRATIONS[it.key];
          return (
            <Panel key={it.key} data-testid={`integration-${it.key}`}>
              <PanelHeader title={def.name} description={def.description}
                actions={it.connected ? (it.status === "error" ? <Badge tone="danger">Last use failed</Badge> : <Badge tone="success">Connected</Badge>) : <Badge>Not connected</Badge>} />
              <div className="space-y-4 p-4">
                {it.connected ? (
                  <>
                    <dl className="space-y-1 text-[13px]">
                      {def.fields.map((f) => (
                        <div key={f.key} className="flex justify-between gap-3"><dt className="text-muted">{f.label}</dt><dd className="font-mono text-[12px]">{f.secret ? it.secretHints[f.key] ?? "••••" : it.config[f.key] ?? "—"}</dd></div>
                      ))}
                      <div className="flex justify-between gap-3"><dt className="text-muted">Last used</dt><dd>{fmt(it.lastUsedAt)}</dd></div>
                    </dl>
                    {it.lastError ? <FormAlert>{it.lastError}</FormAlert> : null}
                    {ent.features.integrations ? (
                      <SchemaForm action={testIntegrationAction.bind(null, orgSlug, it.key)} submitLabel={def.kind === "sms" ? "Send test SMS" : "Send test message"} pendingLabel="Sending…"
                        fields={def.kind === "sms" ? [{ name: "to", label: "Send the test to", type: "tel", placeholder: "+16045550123" }] : []} />
                    ) : null}
                    <ConfirmAction action={disconnectIntegrationAction.bind(null, orgSlug, it.key)} label="Disconnect" confirmLabel="Disconnect"
                      description={def.kind === "chat" ? "Automation rules that post here will fail until it's connected again." : "Nothing will be sent through Twilio until it's connected again."} />
                  </>
                ) : null}
                {ent.features.integrations ? (
                  <details open={!it.connected}>
                    <summary className="cursor-pointer text-sm font-medium text-accent">{it.connected ? "Replace the credentials" : "Connect"}</summary>
                    <p className="mt-2 text-[13px] text-muted">{def.setup}</p>
                    <SchemaForm className="mt-3" action={connectIntegrationAction.bind(null, orgSlug, it.key)} submitLabel={it.connected ? "Save" : "Connect"} pendingLabel="Saving…"
                      fields={def.fields.map((f) => ({ name: f.key, label: f.label + (f.optional ? " (optional)" : ""), type: f.secret ? "text" as const : "text" as const, placeholder: f.placeholder, defaultValue: f.secret ? "" : it.config[f.key] ?? "" }))} />
                  </details>
                ) : null}
              </div>
            </Panel>
          );
        })}
      </div>
      <Panel className="mt-6">
        <PanelHeader title="Coming later" description="Planned connections. They aren't available yet." />
        <ul className="divide-y divide-border">
          {PLANNED_INTEGRATIONS.map((p) => <li key={p.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"><span><span className="font-medium">{p.name}</span><span className="block text-[13px] text-muted">{p.description}</span></span><Badge>Planned</Badge></li>)}
        </ul>
      </Panel>
    </>
  );
}
