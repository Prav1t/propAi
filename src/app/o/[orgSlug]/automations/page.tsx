import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canManageAutomations, listRules, listRuns, pendingApprovalsFor } from "@/server/automation/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { LinkTabs } from "@/components/ui/tabs";
import { Pagination } from "@/components/ui/pagination";
import { FormAlert } from "@/components/ui/form";
import { RUN_STATUS } from "@/lib/automation-labels";
import { TEMPLATES } from "@/lib/automation-templates";
import { TRIGGERS, type TriggerType } from "@/lib/automation";
import { fmtDateTime, relative } from "@/lib/time";

export const metadata = { title: "Automations" };

export default async function AutomationsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/automations">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const approvals = await pendingApprovalsFor(ctx);
  const manager = canManageAutomations(principal);
  if (!manager && !approvals.length) notFound();
  const base = `/o/${orgSlug}/automations`;
  const tab = manager ? (["rules", "runs", "approvals"].includes(sp(q.tab) ?? "") ? sp(q.tab)! : "rules") : "approvals";
  const status = sp(q.status) && sp(q.status)! in RUN_STATUS ? sp(q.status) : undefined;
  const rules = manager && tab === "rules" ? await listRules(ctx) : [];
  const runs = manager && tab === "runs" ? await listRuns(ctx, { status, page: Number(sp(q.page)) || 1 }) : null;
  const tz = principal.orgTimezone;
  return (
    <>
      <PageHeader title="Automations" description="Rules that react to what happens in your buildings — WHEN something happens, IF it matches, THEN do these steps. Every run is logged."
        actions={manager ? <LinkButton href={`${base}/new`}>New rule</LinkButton> : null} />
      {sp(q.deleted) ? <div className="mb-4"><FormAlert kind="success">Rule deleted. Its run history is gone; the audit log keeps what it did.</FormAlert></div> : null}
      <Panel>
        <LinkTabs active={tab} tabs={[
          ...(manager ? [{ key: "rules", label: "Rules", href: base }, { key: "runs", label: "Runs", href: `${base}?tab=runs` }] : []),
          { key: "approvals", label: "Waiting for my approval", href: `${base}?tab=approvals`, count: approvals.length || null },
        ]} />

        {tab === "rules" ? (
          rules.length === 0 ? (
            <EmptyState title="No rules yet">Start from a template below, or build one from scratch.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead><tr><Th>Rule</Th><Th className="hidden lg:table-cell">When</Th><Th>Status</Th><Th className="hidden md:table-cell">Last run</Th><Th className="text-right">Runs</Th></tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <Link href={`${base}/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        <div className="text-[12px] text-faint">{r.propertyName ?? "Every property"}{r.ownerName ? ` · runs as ${r.ownerName}` : ""}{r.editable ? "" : " · read-only for you"}</div>
                      </Td>
                      <Td className="hidden max-w-md text-[13px] text-muted lg:table-cell">{r.summary ? `${r.summary.when}${r.summary.conditions.length ? `, if ${r.summary.conditions.join(" and ")}` : ""}` : TRIGGERS[r.triggerType as TriggerType]?.label}</Td>
                      <Td>
                        {r.pausedReason ? <Badge tone="danger">Paused</Badge> : r.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                        {r.waiting ? <span className="ml-1"><Badge tone="warning">{r.waiting} waiting</Badge></span> : null}
                        {r.failed7d ? <span className="ml-1"><Badge tone="danger">{r.failed7d} failed</Badge></span> : null}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-[13px] text-muted md:table-cell">{r.lastRunAt ? relative(r.lastRunAt) : r.nextRunAt && r.enabled ? `next ${fmtDateTime(r.nextRunAt, tz)}` : "—"}</Td>
                      <Td className="text-right tabular-nums">{r.runCount}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )
        ) : null}

        {tab === "runs" && runs ? (
          <>
            <nav aria-label="Run status" className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-[13px]">
              {[["", "All"], ...Object.entries(RUN_STATUS).map(([k, v]) => [k, v.label])].map(([k, l]) => (
                <Link key={k} href={`${base}?tab=runs${k ? `&status=${k}` : ""}`} aria-current={(status ?? "") === k ? "page" : undefined} className={(status ?? "") === k ? "font-medium text-fg" : "text-muted hover:text-fg"}>{l}</Link>
              ))}
            </nav>
            {runs.rows.length === 0 ? <EmptyState title="No runs">Runs appear here each time a rule fires.</EmptyState> : (
              <div className="overflow-x-auto">
                <Table>
                  <thead><tr><Th>When</Th><Th>Rule</Th><Th>For</Th><Th>Status</Th></tr></thead>
                  <tbody>
                    {runs.rows.map((r) => (
                      <tr key={r.id}>
                        <Td className="whitespace-nowrap text-[13px]"><Link href={`${base}/runs/${r.id}`} className="hover:underline">{fmtDateTime(r.createdAt, tz)}</Link></Td>
                        <Td className="text-[13px]">{r.workflowName}</Td>
                        <Td className="text-[13px] text-muted">{r.entityLabel ?? "—"}{r.propertyName ? ` · ${r.propertyName}` : ""}</Td>
                        <Td><Badge tone={RUN_STATUS[r.status]?.tone}>{RUN_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            <Pagination page={runs.page} pageCount={runs.pageCount} total={runs.total} basePath={base} params={q} />
          </>
        ) : null}

        {tab === "approvals" ? (
          approvals.length === 0 ? <EmptyState title="Nothing waiting for you">When a rule asks your role to approve a step, it shows up here.</EmptyState> : (
            <ul className="divide-y divide-border">
              {approvals.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <Link href={`${base}/runs/${a.id}`} className="text-sm font-medium hover:underline">{a.workflowName}</Link>
                    <p className="text-[12px] text-muted">{a.entityLabel ?? ""}{a.propertyName ? ` · ${a.propertyName}` : ""}{a.requestedAt ? ` · asked ${relative(a.requestedAt)}` : ""}</p>
                  </div>
                  <LinkButton href={`${base}/runs/${a.id}`} size="sm" variant="secondary">Review</LinkButton>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </Panel>

      {manager && tab === "rules" ? (
        <section aria-labelledby="tpl-h" className="mt-8">
          <h2 id="tpl-h" className="mb-2 text-sm font-semibold">Start from a template</h2>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {TEMPLATES.map((t) => (
              <li key={t.key}>
                <Link href={`${base}/new?template=${t.key}`} className="block h-full rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3 hover:border-border-strong">
                  <p className="text-[13px] font-medium">{t.title}</p>
                  <p className="mt-0.5 text-[12px] text-muted">{t.about}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
