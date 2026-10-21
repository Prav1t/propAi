import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getEndpoint } from "@/server/webhooks/service";
import { notFound } from "next/navigation";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Pagination } from "@/components/ui/pagination";
import { DevButton, EndpointForm } from "@/components/developers/developer-forms";
import { PUBLIC_EVENTS } from "@/server/webhooks/catalog";
import { deleteEndpointAction, rotateSecretAction, sendTestEventAction, setEndpointActiveAction, updateEndpointAction } from "../../actions";

export const metadata = { title: "Webhook endpoint" };

const STATUS_TONE = { succeeded: "success", pending: "warning", failed: "danger" } as const;

export default async function EndpointPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/developers/webhooks/[endpointId]">) {
  const { orgSlug, endpointId } = await params;
  const page = Number(sp((await searchParams).page) ?? 1) || 1;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("api.manage")) notFound();
  const { endpoint: e, deliveries, pageCount, total } = await orNotFound(getEndpoint(ctx, endpointId, { page }));
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "medium" }) : "—");
  const base = `/o/${orgSlug}/settings/developers`;
  return (
    <>
      <PageHeader title="Webhook endpoint" description={e.url} actions={<Link className="text-sm text-accent underline" href={base}>All endpoints</Link>} />
      {e.status === "disabled" ? <FormAlert>{`Switched off${e.disabledReason ? `: ${e.disabledReason}` : "."} Deliveries wait until it's switched back on.`}</FormAlert> : null}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="Settings" />
          <div className="p-4"><EndpointForm action={updateEndpointAction.bind(null, orgSlug, e.id)} events={PUBLIC_EVENTS.map((x) => ({ type: x.type, description: x.description }))} initial={{ url: e.url, description: e.description, events: e.events }} submitLabel="Save" /></div>
        </Panel>
        <Panel>
          <PanelHeader title="Actions" />
          <div className="space-y-4 p-4 text-sm">
            <div className="flex items-center gap-2">Status: {e.status === "active" ? <Badge tone="success">On</Badge> : <Badge tone="danger">Off</Badge>}</div>
            <dl className="space-y-1 text-[13px]">
              <div className="flex justify-between gap-2"><dt className="text-muted">Last success</dt><dd>{fmt(e.lastSuccessAt)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">Failures in a row</dt><dd className="tabular-nums">{e.consecutiveFailures}</dd></div>
            </dl>
            <DevButton action={sendTestEventAction.bind(null, orgSlug, e.id)} label="Send a test event" pendingLabel="Sending…" />
            <DevButton action={setEndpointActiveAction.bind(null, orgSlug, e.id, e.status !== "active")} label={e.status === "active" ? "Switch off" : "Switch on"} />
            <DevButton action={rotateSecretAction.bind(null, orgSlug, e.id)} label="Rotate signing secret" />
            <ConfirmAction action={deleteEndpointAction.bind(null, orgSlug, e.id)} label="Delete endpoint" confirmLabel="Delete" description="Its delivery log is deleted too." />
          </div>
        </Panel>
      </div>
      <Panel className="mt-6">
        <PanelHeader title="Deliveries" description="Newest first. Open one to see the payload and every attempt." />
        {deliveries.length ? (
          <>
            <Table>
              <thead><tr><Th>Event</Th><Th>Created</Th><Th>Status</Th><Th className="text-right">Attempts</Th><Th className="hidden md:table-cell">Last response</Th><Th className="hidden md:table-cell">Next try</Th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <Td><Link className="font-mono text-[12px] text-accent hover:underline" href={`${base}/deliveries/${d.id}`}>{d.eventType}</Link>{d.replayOf ? <span className="ml-1 text-[11px] text-faint">replay</span> : null}</Td>
                    <Td className="text-[13px] text-muted">{fmt(d.createdAt)}</Td>
                    <Td><Badge tone={STATUS_TONE[d.status as keyof typeof STATUS_TONE] ?? "neutral"}>{d.status === "succeeded" ? "Delivered" : d.status === "pending" ? (d.attempts ? "Retrying" : "Waiting") : "Gave up"}</Badge></Td>
                    <Td className="text-right tabular-nums">{d.attempts}</Td>
                    <Td className="hidden max-w-64 truncate text-[13px] text-muted md:table-cell">{d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.lastError ?? "—"}</Td>
                    <Td className="hidden text-[13px] text-muted md:table-cell">{d.status === "pending" ? fmt(d.nextAttemptAt) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageCount={pageCount} total={total} basePath={`${base}/webhooks/${e.id}`} params={{}} />
          </>
        ) : <p className="p-4 text-sm text-muted">Nothing sent yet. Use “Send a test event”, or wait for a subscribed event.</p>}
      </Panel>
    </>
  );
}
