import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canManageAutomations, getRule } from "@/server/automation/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { ActionButton } from "@/components/ops/action-button";
import { FormAlert } from "@/components/ui/form";
import { RUN_STATUS } from "@/lib/automation-labels";
import { fmtDateTime } from "@/lib/time";
import { deleteRuleAction, setRuleEnabledAction } from "../actions";

export const metadata = { title: "Automation rule" };

export default async function RulePage({ params, searchParams }: PageProps<"/o/[orgSlug]/automations/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canManageAutomations(principal) || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await orNotFound(getRule(ctx, id));
  const base = `/o/${orgSlug}/automations`;
  const tz = principal.orgTimezone;
  return (
    <>
      <PageHeader
        title={r.wf.name}
        description={<><Link href={base} className="text-accent hover:underline">Automations</Link> · version {r.wf.version} · {r.wf.propertyId ? r.names.properties?.[r.wf.propertyId] : "every property"}</>}
        actions={r.editable ? <div className="flex flex-wrap gap-2">
          <LinkButton href={`${base}/${id}/edit`} variant="secondary" size="sm">Edit</LinkButton>
          {r.wf.enabled ? <ConfirmAction action={setRuleEnabledAction.bind(null, orgSlug, id, false)} label="Turn off" confirmLabel="Turn off" variant="secondary" description="It stops reacting to new events. Runs waiting for approval stay open." />
            : <ActionButton action={setRuleEnabledAction.bind(null, orgSlug, id, true)} label="Turn on" variant="primary" />}
          <ConfirmAction action={deleteRuleAction.bind(null, orgSlug, id)} label="Delete" confirmLabel="Delete rule" requireText="delete" description="The rule and its run history are removed. The audit log keeps what it did." />
        </div> : <Badge>Read-only for you</Badge>}
      />
      {sp(q.saved) ? <div className="mb-4"><FormAlert kind="success">{r.wf.enabled ? "Saved and on." : "Saved. It's off until you turn it on."}</FormAlert></div> : null}
      {r.wf.pausedReason ? <div className="mb-4"><FormAlert>{r.wf.pausedReason}</FormAlert></div> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="What it does" actions={r.wf.pausedReason ? <Badge tone="danger">Paused</Badge> : r.wf.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>} />
          {r.summary ? (
            <div className="space-y-3 px-4 py-3 text-sm">
              <p><span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-faint">When</span>{r.summary.when}</p>
              {r.summary.conditions.length ? <div><span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-faint">If</span>{r.summary.conditions.join(", and ")}</div> : null}
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Then</span>
                <ol className="mt-1 list-decimal space-y-1 pl-5">{r.summary.actions.map((a, i) => <li key={i}>{a}</li>)}</ol>
              </div>
            </div>
          ) : <EmptyState title="This rule can't be read">Edit it and save it again.</EmptyState>}
        </Panel>
        <Panel>
          <PanelHeader title="Details" />
          <dl className="space-y-2 px-4 py-3 text-[13px]">
            <div><dt className="text-faint">Runs as</dt><dd>{r.ownerName ?? "Nobody — save it again to take ownership"}</dd></div>
            <div><dt className="text-faint">Runs so far</dt><dd className="tabular-nums">{r.wf.runCount}</dd></div>
            <div><dt className="text-faint">Last run</dt><dd>{r.wf.lastRunAt ? fmtDateTime(r.wf.lastRunAt, tz) : "Never"}</dd></div>
            {r.wf.triggerType === "schedule" ? <div><dt className="text-faint">Next run</dt><dd>{r.wf.enabled && r.wf.nextRunAt ? fmtDateTime(r.wf.nextRunAt, tz) : "—"}</dd></div> : null}
            <div><dt className="text-faint">Updated</dt><dd>{fmtDateTime(r.wf.updatedAt, tz)}</dd></div>
          </dl>
          <p className="border-t border-border px-4 py-3 text-[12px] text-muted">It acts with its owner&apos;s permissions, checked again on every run. A rule never reacts to changes it made itself, chains of rules stop after 3 hops, and a rule that runs more than 100 times in an hour is paused.</p>
        </Panel>
      </div>
      <Panel className="mt-6">
        <PanelHeader title="Recent runs" actions={<Link href={`${base}?tab=runs`} className="text-[13px] text-accent hover:underline">All runs</Link>} />
        {r.runs.length === 0 ? <EmptyState title="No runs yet">{r.wf.enabled ? "It runs the next time something matches." : "Turn it on to start."} Use Edit → Test it to see what it would do.</EmptyState> : (
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><Th>When</Th><Th>For</Th><Th>Status</Th><Th className="hidden md:table-cell">Note</Th></tr></thead>
              <tbody>
                {r.runs.map((run) => (
                  <tr key={run.id}>
                    <Td className="whitespace-nowrap text-[13px]"><Link href={`${base}/runs/${run.id}`} className="hover:underline">{fmtDateTime(run.createdAt, tz)}</Link></Td>
                    <Td className="text-[13px] text-muted">{run.entityLabel ?? "—"}</Td>
                    <Td><Badge tone={RUN_STATUS[run.status]?.tone}>{RUN_STATUS[run.status]?.label ?? run.status}</Badge></Td>
                    <Td className="hidden max-w-sm truncate text-[12px] text-muted md:table-cell">{run.error ?? (run.workflowVersion !== r.wf.version ? `version ${run.workflowVersion}` : "")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Panel>
    </>
  );
}
