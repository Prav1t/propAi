import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getDelivery } from "@/server/webhooks/service";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { DevButton } from "@/components/developers/developer-forms";
import { replayDeliveryAction } from "../../actions";

export const metadata = { title: "Webhook delivery" };

export default async function DeliveryPage({ params }: PageProps<"/o/[orgSlug]/settings/developers/deliveries/[deliveryId]">) {
  const { orgSlug, deliveryId } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("api.manage")) notFound();
  const { delivery: d, attempts } = await orNotFound(getDelivery(ctx, deliveryId));
  const tz = principal.orgTimezone;
  const fmt = (x: Date | null) => (x ? x.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "medium" }) : "—");
  return (
    <>
      <PageHeader title={`Delivery: ${d.eventType}`} description={`Created ${fmt(d.createdAt)}${d.replayOf ? " · a replay" : ""}`}
        actions={<Link className="text-sm text-accent underline" href={`/o/${orgSlug}/settings/developers/webhooks/${d.endpointId}`}>Back to the endpoint</Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="Payload" description="Exactly what is sent (signed, with the headers described on the Developers page)." />
          <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-[12px] leading-relaxed">{JSON.stringify(d.payload, null, 2)}</pre>
        </Panel>
        <Panel>
          <PanelHeader title="Status" />
          <div className="space-y-3 p-4 text-sm">
            <div>{d.status === "succeeded" ? <Badge tone="success">Delivered</Badge> : d.status === "pending" ? <Badge tone="warning">{d.attempts ? "Retrying" : "Waiting"}</Badge> : <Badge tone="danger">Gave up</Badge>}</div>
            {d.status === "pending" ? <p className="text-[13px] text-muted">Next attempt: {fmt(d.nextAttemptAt)}</p> : null}
            {d.deliveredAt ? <p className="text-[13px] text-muted">Delivered {fmt(d.deliveredAt)}</p> : null}
            <DevButton action={replayDeliveryAction.bind(null, orgSlug, d.id)} label="Send again" pendingLabel="Sending…" />
          </div>
        </Panel>
      </div>
      <Panel className="mt-6">
        <PanelHeader title="Attempts" />
        {attempts.length ? (
          <Table>
            <thead><tr><Th className="text-right">#</Th><Th>When</Th><Th>Result</Th><Th className="text-right">Time</Th><Th className="hidden md:table-cell">Response</Th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} className="align-top">
                  <Td className="text-right tabular-nums">{a.attempt}</Td>
                  <Td className="text-[13px]">{fmt(a.createdAt)}</Td>
                  <Td>{a.statusCode && a.statusCode >= 200 && a.statusCode < 300 ? <Badge tone="success">HTTP {a.statusCode}</Badge> : <Badge tone="danger">{a.statusCode ? `HTTP ${a.statusCode}` : "No response"}</Badge>}{a.error && !a.statusCode ? <div className="mt-0.5 text-[12px] text-muted">{a.error}</div> : null}</Td>
                  <Td className="text-right tabular-nums text-[13px]">{a.durationMs} ms</Td>
                  <Td className="hidden max-w-80 md:table-cell"><code className="block truncate font-mono text-[11px] text-muted">{a.responseSnippet ?? ""}</code></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="p-4 text-sm text-muted">No attempts yet.</p>}
      </Panel>
    </>
  );
}
