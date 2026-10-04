import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { usageOverview } from "@/server/ai/usage";
import { providerStatus } from "@/server/ai/providers";
import { aiConfig } from "@/server/ai/config";
import { BRAND } from "@/config/brand";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { fmtDateTime } from "@/lib/time";
import { AiSettingsForm } from "./ai-settings-form";

export const metadata = { title: "AI assistant settings" };

const OUTCOME_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ok: "success", ambiguous: "neutral", not_found: "neutral", denied: "warning", invalid: "warning", unknown_tool: "danger", error: "danger",
};
const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-CA");
const usd = (v: number | null) => (v === null ? "—" : v < 0.01 && v > 0 ? "< $0.01" : `$${v.toFixed(2)}`);

export default async function AiSettingsPage({ params }: PageProps<"/o/[orgSlug]/settings/ai">) {
  const { orgSlug } = await params;
  const { principal, ctx } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("ai.settings.manage")) notFound();
  const u = await usageOverview(ctx);
  const status = providerStatus();
  const cfg = aiConfig();
  return (
    <>
      <PageHeader title="AI assistant" description={`How ${BRAND.assistantName} is used in your organization. Figures are this calendar month (${u.tz}).`} />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Requests" value={n(u.totals.requests)} sub={`${n(u.totals.failed)} didn't finish${u.totals.refused ? ` · ${n(u.totals.refused)} refused` : ""}`} />
          <Stat label="Tokens" value={n(u.totals.inputTokens + u.totals.outputTokens)} sub={`${n(u.totals.inputTokens)} in · ${n(u.totals.outputTokens)} out`} />
          <Stat label="Estimated cost" value={usd(u.totals.cost)} sub={u.totals.unpriced ? `${n(u.totals.unpriced)} requests on a model without a price set` : "List prices; your bill may differ"} />
          <Stat label="Average response time" value={u.totals.avgLatencyMs === null ? "—" : `${(u.totals.avgLatencyMs / 1000).toFixed(1)} s`} sub={u.totals.demo ? `${n(u.totals.demo)} answered in demo mode` : undefined} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Settings" />
            <AiSettingsForm orgSlug={orgSlug} enabled={u.settings.enabled} cap={u.settings.monthlyRequestCap} used={u.totals.requests} />
          </Panel>
          <Panel>
            <PanelHeader title="Model" description="Set by your platform administrator in the server environment." />
            <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-[140px_1fr]">
              <dt className="text-muted">Provider</dt>
              <dd>{status.demo ? <><Badge tone="warning">Demo mode</Badge> <span className="text-[13px] text-muted">No language model — {status.reason}.</span></> : status.provider}</dd>
              <dt className="text-muted">Model</dt><dd className="font-mono text-[13px]">{status.model}</dd>
              <dt className="text-muted">Limits</dt><dd className="text-[13px]">{cfg.maxSteps} lookups per answer · {Math.round(cfg.timeoutMs / 1000)} s timeout · {cfg.requestsPerMinute} questions per person per minute</dd>
              <dt className="text-muted">Access</dt><dd className="text-[13px]">Read-only tools, filtered by each person&apos;s role and properties. Conversations are private to their author.</dd>
            </dl>
          </Panel>
        </div>

        <Panel>
          <PanelHeader title="By person" />
          {u.byUser.length ? (
            <Table>
              <thead><tr><Th>Person</Th><Th className="text-right">Requests</Th><Th className="text-right">Tokens</Th><Th className="text-right">Est. cost</Th></tr></thead>
              <tbody>
                {u.byUser.map((r) => (
                  <tr key={r.email ?? r.name ?? "former"}>
                    <Td>{r.name ?? "Former member"}<span className="block text-xs text-faint">{r.email}</span></Td>
                    <Td className="text-right tabular-nums">{n(r.requests)}</Td><Td className="text-right tabular-nums">{n(r.tokens)}</Td><Td className="text-right tabular-nums">{usd(r.cost)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No requests this month" />}
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Tools used" description="Every lookup runs through the same permission checks as the app." />
            {u.byTool.length ? (
              <Table>
                <thead><tr><Th>Tool</Th><Th className="text-right">Calls</Th><Th className="text-right">Denied</Th><Th className="text-right">Problems</Th><Th className="text-right">Avg ms</Th></tr></thead>
                <tbody>
                  {u.byTool.map((r) => (
                    <tr key={r.tool}><Td className="font-mono text-[12px]">{r.tool}</Td><Td className="text-right tabular-nums">{n(r.calls)}</Td><Td className="text-right tabular-nums">{n(r.denied)}</Td><Td className="text-right tabular-nums">{n(r.problems)}</Td><Td className="text-right tabular-nums">{n(r.avgMs)}</Td></tr>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="No tool calls this month" />}
          </Panel>
          <Panel>
            <PanelHeader title="Models" />
            {u.byModel.length ? (
              <Table>
                <thead><tr><Th>Provider</Th><Th>Model</Th><Th className="text-right">Requests</Th></tr></thead>
                <tbody>{u.byModel.map((r) => <tr key={`${r.provider}/${r.model}`}><Td>{r.provider}</Td><Td className="font-mono text-[12px]">{r.model}</Td><Td className="text-right tabular-nums">{n(r.requests)}</Td></tr>)}</tbody>
              </Table>
            ) : <EmptyState title="No requests this month" />}
          </Panel>
        </div>

        <Panel>
          <PanelHeader title="Recent tool calls" description="The action log: who asked, which tool ran, with what arguments, and the outcome." />
          {u.recent.length ? (
            <Table>
              <thead><tr><Th>When</Th><Th>Person</Th><Th>Tool</Th><Th>Outcome</Th><Th>Result</Th></tr></thead>
              <tbody>
                {u.recent.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap text-[13px] text-muted">{fmtDateTime(r.createdAt, u.tz)}</Td>
                    <Td className="text-[13px]">{r.userName ?? "Former member"}</Td>
                    <Td><span className="font-mono text-[12px]">{r.tool}</span><span className="block max-w-56 truncate font-mono text-[11px] text-faint" title={JSON.stringify(r.args)}>{JSON.stringify(r.args)}</span></Td>
                    <Td><Badge tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{r.outcome.replace("_", " ")}</Badge></Td>
                    <Td className="max-w-72 text-[13px] text-muted"><span className="line-clamp-2">{r.summary}</span><span className="text-[11px] text-faint">{r.durationMs} ms</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No tool calls yet" />}
        </Panel>
      </div>
    </>
  );
}
