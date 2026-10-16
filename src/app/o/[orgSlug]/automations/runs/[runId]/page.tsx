import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getRun } from "@/server/automation/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { DecideForm } from "@/components/automation/decide-form";
import { RUN_STATUS, STEP_STATUS } from "@/lib/automation-labels";
import { TRIGGERS, type TriggerType } from "@/lib/automation";
import { fmtDateTime } from "@/lib/time";
import { decideRunAction } from "../../actions";

export const metadata = { title: "Automation run" };

const DECIDED: Record<string, string> = {
  completed: "Approved — the remaining steps ran.",
  approved: "Approved.",
  declined: "Declined — the remaining steps won't run.",
};

export default async function RunPage({ params, searchParams }: PageProps<"/o/[orgSlug]/automations/runs/[runId]">) {
  const { orgSlug, runId } = await params;
  const decided = (await searchParams).decided;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!/^[0-9a-f-]{36}$/.test(runId)) notFound();
  const r = await orNotFound(getRun(ctx, runId));
  const base = `/o/${orgSlug}`;
  const tz = principal.orgTimezone;
  const st = RUN_STATUS[r.run.status];
  return (
    <>
      <PageHeader
        title={r.workflow.name}
        description={<>{r.canOpenRule ? <Link href={`${base}/automations/${r.workflow.id}`} className="text-accent hover:underline">Rule</Link> : "Automation run"} · {TRIGGERS[r.run.triggerType as TriggerType]?.label ?? r.run.triggerType} · {fmtDateTime(r.run.createdAt, tz)}{r.propertyName ? ` · ${r.propertyName}` : ""}</>}
        actions={<Badge tone={st?.tone}>{st?.label ?? r.run.status}</Badge>}
      />
      {typeof decided === "string" && DECIDED[decided] && !r.canDecide ? <div className="mb-4"><FormAlert kind="success">{DECIDED[decided]}</FormAlert></div> : null}
      {r.canDecide ? (
        <Panel className="mb-6 border-warning/40">
          <PanelHeader title="Your approval is needed" description={`The rule paused before the steps below “Ask for approval”. Approve to run them now with the rule owner's permissions, or decline to skip them.`} />
          <div className="px-4 py-3"><DecideForm approve={decideRunAction.bind(null, orgSlug, runId, "approve")} decline={decideRunAction.bind(null, orgSlug, runId, "decline")} /></div>
        </Panel>
      ) : null}
      <Panel>
        <PanelHeader title={r.run.entityLabel ?? "Steps"} description={r.run.error ?? (r.run.decidedAt ? `Decided by ${r.decidedBy ?? "someone"} ${fmtDateTime(r.run.decidedAt, tz)}` : undefined)} />
        <ol className="divide-y divide-border">
          {r.steps.map((s) => (
            <li key={s.index} className="flex gap-3 px-4 py-3">
              <span className="mt-0.5 w-5 shrink-0 text-right text-[12px] font-semibold tabular-nums text-faint">{s.index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium">{s.label}</p>
                  <Badge tone={STEP_STATUS[s.status]?.tone}>{STEP_STATUS[s.status]?.label ?? s.status}</Badge>
                </div>
                {s.summary ? <p className="mt-0.5 text-[13px] text-muted">{s.summary}</p> : null}
                {s.error ? <p className="mt-0.5 text-[13px] text-danger">{s.error}</p> : null}
                {s.record ? <Link href={`${base}${s.record.href}`} className="mt-0.5 inline-block text-[13px] text-accent hover:underline">{s.record.ref}: {s.record.title}</Link> : null}
                {s.at ? <p className="mt-0.5 text-[11px] text-faint">{fmtDateTime(new Date(s.at), tz)}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
