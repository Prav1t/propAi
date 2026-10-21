import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listApiKeys } from "@/server/api/keys";
import { listEndpoints } from "@/server/webhooks/service";
import { getEntitlements } from "@/server/billing/entitlements";
import { listVisibleProperties } from "@/server/modules/organizations/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CreateKeyForm, Disclosure, EndpointForm } from "@/components/developers/developer-forms";
import { API_SCOPES } from "@/lib/api-scopes";
import { PUBLIC_EVENTS } from "@/server/webhooks/catalog";
import { createApiKeyAction, createEndpointAction, revokeApiKeyAction } from "./actions";

export const metadata = { title: "Developers" };

export default async function DevelopersPage({ params }: PageProps<"/o/[orgSlug]/settings/developers">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("api.manage")) notFound();
  const ent = await getEntitlements(principal.orgId);
  const [keys, endpoints, properties] = await Promise.all([listApiKeys(ctx), listEndpoints(ctx), listVisibleProperties(ctx)]);
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) : "—");
  const myScopes = API_SCOPES.filter((s) => principal.permissions.has(s.perm));
  const propName = Object.fromEntries(properties.map((p) => [p.id, p.name]));
  const scopeLabel = (perm: string) => { const s = API_SCOPES.find((x) => x.perm === perm); return s ? `${s.label} (${s.access})` : perm; };
  const upgrade = <Link className="underline" href={`/o/${orgSlug}/settings/billing`}>Billing</Link>;

  return (
    <>
      <PageHeader title="Developers" description="API keys for your own systems and webhooks that tell them when something happens."
        actions={<Link className="text-sm text-accent underline" href="/developers/api">API reference</Link>} />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="API keys" description="A key acts for the person who created it, limited to the permissions and properties chosen here. Send it as Authorization: Bearer ak_…" />
          {!ent.features.api ? <div className="p-4"><FormAlert kind="info">{ent.plan.features.includes("api") ? "The REST API is switched off for your organization right now." : <>The REST API is included in the Professional and Enterprise plans. See {upgrade}.</>}</FormAlert></div> : null}
          {keys.length ? (
            <Table>
              <thead><tr><Th>Name</Th><Th>Key</Th><Th className="hidden lg:table-cell">Permissions</Th><Th className="hidden md:table-cell">Last used</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {keys.map((k) => {
                  const expired = k.expired;
                  return (
                    <tr key={k.id} className={k.revokedAt || expired ? "opacity-60" : undefined}>
                      <Td><div className="font-medium">{k.name}</div><div className="text-xs text-faint">by {k.createdByName ?? "a removed member"} · {fmt(k.createdAt)}</div></Td>
                      <Td className="font-mono text-[12px]">ak_{k.prefix}_…</Td>
                      <Td className="hidden max-w-80 text-[12px] text-muted lg:table-cell">{k.permissions.map(scopeLabel).join(", ")}{k.propertyIds.length ? <div className="mt-0.5 text-faint">Only: {k.propertyIds.map((id) => propName[id] ?? "a property").join(", ")}</div> : null}</Td>
                      <Td className="hidden text-[13px] text-muted md:table-cell">{fmt(k.lastUsedAt)}</Td>
                      <Td>{k.revokedAt ? <Badge tone="danger">Revoked</Badge> : expired ? <Badge>Expired</Badge> : <Badge tone="success">Active</Badge>}{k.expiresAt && !k.revokedAt && !expired ? <div className="mt-0.5 text-[11px] text-faint">until {fmt(k.expiresAt)}</div> : null}</Td>
                      <Td className="text-right">{!k.revokedAt ? <ConfirmAction action={revokeApiKeyAction.bind(null, orgSlug)} hidden={{ id: k.id }} label="Revoke" confirmLabel="Revoke key" description="Requests with this key will be refused immediately." /> : null}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : <EmptyState title="No API keys yet">Create one for each system that connects, so you can revoke them separately.</EmptyState>}
          {ent.features.api ? (
            <Disclosure summary="Create an API key" defaultOpen={!keys.length}>
              <CreateKeyForm action={createApiKeyAction.bind(null, orgSlug)} scopes={[...myScopes]} properties={properties.map((p) => ({ id: p.id, name: p.name }))} requireProperties={principal.role.scopeLevel !== "org"} />
            </Disclosure>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Webhooks" description="We POST a signed JSON event to your URL when something happens. Failed deliveries are retried for about two days; every attempt is logged." />
          {!ent.features.webhooks ? <div className="p-4"><FormAlert kind="info">{ent.plan.features.includes("webhooks") ? "Webhooks are switched off for your organization right now." : <>Webhooks are included in the Professional and Enterprise plans. See {upgrade}.</>}</FormAlert></div> : null}
          {endpoints.length ? (
            <Table>
              <thead><tr><Th>Endpoint</Th><Th className="hidden md:table-cell">Events</Th><Th className="hidden md:table-cell">Last success</Th><Th>Status</Th></tr></thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.id}>
                    <Td><Link className="font-medium text-accent hover:underline" href={`/o/${orgSlug}/settings/developers/webhooks/${e.id}`}>{e.url}</Link>{e.description ? <div className="text-xs text-faint">{e.description}</div> : null}</Td>
                    <Td className="hidden text-[13px] text-muted md:table-cell">{e.events.length} event{e.events.length === 1 ? "" : "s"}</Td>
                    <Td className="hidden text-[13px] text-muted md:table-cell">{fmt(e.lastSuccessAt)}</Td>
                    <Td>
                      {e.status === "active" ? <Badge tone="success">On</Badge> : <Badge tone="danger">Off</Badge>}
                      {e.pending ? <span className="ml-2 text-[12px] text-warning">{e.pending} waiting</span> : null}
                      {e.failed24h ? <span className="ml-2 text-[12px] text-danger">{e.failed24h} failed attempt{e.failed24h === 1 ? "" : "s"} (24h)</span> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No webhook endpoints">Add your URL to receive events like new work orders and incidents.</EmptyState>}
          {ent.features.webhooks ? (
            <Disclosure summary="Add an endpoint" defaultOpen={!endpoints.length}>
              <EndpointForm action={createEndpointAction.bind(null, orgSlug)} events={PUBLIC_EVENTS.map((e) => ({ type: e.type, description: e.description }))} submitLabel="Add endpoint" />
            </Disclosure>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Verifying webhooks" />
          <div className="space-y-2 p-4 text-[13px]">
            <p>Each request has <code className="font-mono">Webhook-Id</code>, <code className="font-mono">Webhook-Timestamp</code> and <code className="font-mono">Webhook-Signature: t=…,v1=…</code>. Compute HMAC-SHA256 of <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code> with your endpoint&apos;s signing secret, compare it to v1 in constant time, and reject timestamps more than five minutes old.</p>
            <p>Answer with any 2xx status within ten seconds. Redirects aren&apos;t followed. The event&apos;s <code className="font-mono">id</code> stays the same on retries and replays — use it to skip duplicates.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
