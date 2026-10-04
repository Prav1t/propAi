import { getOrgContext, orNotFound } from "@/server/org-context";
import { getViolation } from "@/server/modules/parking/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { FormAlert } from "@/components/ui/form";
import { SchemaForm } from "@/components/ui/schema-form";
import { AttachmentList } from "@/components/ops/attachments";
import { VIOLATION_KIND, VIOLATION_SOURCE, VIOLATION_STATUS, fmtPlate } from "@/lib/facility-labels";
import { fmtDateTime } from "@/lib/time";
import { resolveViolationAction, reviewViolationAction, warnViolationAction } from "../../../frontdesk-actions";

export const metadata = { title: "Parking report" };

export default async function ViolationPage({ params }: PageProps<"/o/[orgSlug]/parking/violations/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getViolation(ctx, id));
  const v = d.violation;
  const tz = d.labels.tz;
  const base = `/o/${orgSlug}`;

  if (!("evidence" in d)) {
    // resident: the notice they received
    return (
      <>
        <Breadcrumbs items={[{ label: "My parking", href: `${base}/parking` }, { label: `Notice #${v.number}` }]} />
        <PageHeader title={`Parking notice for ${fmtPlate(v.plate)}`} description={`${VIOLATION_KIND[v.kind]} · ${d.labels.propertyName}`} actions={<Badge tone={VIOLATION_STATUS[v.status]?.tone}>{v.status === "resolved" ? "Resolved" : "Open"}</Badge>} />
        <Panel className="max-w-2xl">
          <PanelHeader title="Notice" />
          <p className="whitespace-pre-line px-4 pb-2 pt-4 text-sm">{v.warningText}</p>
          <DetailList items={[["Observed", fmtDateTime(v.observedAt, tz)], ["Where", [d.spaceCode ? `Space ${d.spaceCode}` : null, v.location].filter(Boolean).join(" · ") || null], ["Issued", fmtDateTime(v.warnedAt, tz)], ...(v.resolution ? [["Outcome", v.resolution] as [string, string]] : [])]} />
          <p className="px-4 pb-4 text-[13px] text-muted">Questions? Message management from the Messages page.</p>
        </Panel>
      </>
    );
  }

  const full = d as Extract<typeof d, { evidence: unknown }>;
  const r = full.violation;
  return (
    <>
      <Breadcrumbs items={[{ label: "Parking", href: `${base}/parking` }, { label: `Report #${r.number}` }]} />
      <PageHeader title={`#${r.number} ${VIOLATION_KIND[r.kind]} · ${fmtPlate(r.plate)}`} description={`${VIOLATION_SOURCE[r.source]} at ${d.labels.propertyName}`} actions={<Badge tone={VIOLATION_STATUS[r.status]?.tone}>{VIOLATION_STATUS[r.status]?.label}</Badge>} />
      {r.source === "detection" ? <div className="mb-4"><FormAlert kind="info">{`This is an automated detection (${Math.round(Number(r.confidence ?? 0) * 100)}% confidence), not a finding. Check it in person or against the footage before confirming.`}</FormAlert></div> : null}
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-6 lg:col-span-2">
          <Panel>
            <PanelHeader title="What was reported" />
            <DetailList items={[
              ["Plate", <span key="p" className="font-mono">{fmtPlate(r.plate)}</span>],
              ["Observed", fmtDateTime(r.observedAt, tz)],
              ["Where", [d.spaceCode ? `Space ${d.spaceCode}` : null, r.location].filter(Boolean).join(" · ") || null],
              ["Details", r.description],
              ["Registered to", d.unit ? `Unit ${d.unit.number}, ${d.unit.buildingName}` : "No registered vehicle with this plate"],
              ["Permit then", r.hadValidPermit === null ? null : r.hadValidPermit ? "A permit was valid at the time" : "No valid permit at the time"],
              ["Reported by", full.reportedByName ?? (r.source === "detection" ? "Camera integration" : null)],
              ...(r.reviewedAt ? [["Reviewed", `${fmtDateTime(r.reviewedAt, tz)} by ${full.reviewedByName ?? "staff"}${r.reviewNote ? ` — ${r.reviewNote}` : ""}`] as [string, string]] : []),
              ...(r.warnedAt ? [["Notice", `${fmtDateTime(r.warnedAt, tz)}: ${r.warningText}`] as [string, string]] : []),
              ...(r.resolution ? [["Outcome", r.resolution] as [string, string]] : []),
            ]} />
          </Panel>
          <Panel>
            <PanelHeader title="Evidence" />
            <div className="p-4">{full.evidence.length ? <AttachmentList files={full.evidence} base={base} /> : <p className="text-[13px] text-muted">No photos attached.</p>}</div>
          </Panel>
        </div>
        <div className="space-y-6">
          {r.status === "reported" ? (
            <Panel>
              <PanelHeader title="Review" description="Confirm only what you've verified. Dismiss false reports and detections." />
              {full.mustDeferReview ? <p className="p-4 text-[13px] text-muted">Your organization requires a second staff member to review reports. Ask a colleague to review this one.</p> : (
                <SchemaForm action={reviewViolationAction.bind(null, orgSlug, id)} submitLabel="Save review" className="p-4" fields={[
                  { name: "decision", label: "Decision", type: "select", options: [{ value: "confirm", label: "Confirm — it happened" }, { value: "dismiss", label: "Dismiss" }] },
                  { name: "note", label: "Note", type: "textarea", rows: 3, hint: "Required when dismissing." },
                ]} />
              )}
            </Panel>
          ) : null}
          {r.status === "confirmed" ? (
            <Panel>
              <PanelHeader title="Issue a notice" description={d.unit ? `Sent to the residents of Unit ${d.unit.number}.` : "No resident matches this plate, so the notice is recorded only (e.g. left on the windshield)."} />
              <SchemaForm action={warnViolationAction.bind(null, orgSlug, id)} submitLabel="Issue notice" className="p-4" fields={[
                { name: "message", label: "Notice text", type: "textarea", rows: 5, defaultValue: `Your vehicle ${fmtPlate(r.plate)} was parked ${r.kind === "wrong_space" ? "in a space that isn't yours" : r.kind === "fire_lane" ? "in the fire lane" : "without a valid permit"} on ${fmtDateTime(r.observedAt, tz)}. Please move it and contact the front desk if you think this is a mistake.` },
              ]} />
            </Panel>
          ) : null}
          {["confirmed", "warned"].includes(r.status) ? (
            <Panel>
              <PanelHeader title="Resolve" />
              <SchemaForm action={resolveViolationAction.bind(null, orgSlug, id)} submitLabel="Mark resolved" className="p-4" fields={[{ name: "resolution", label: "Outcome", placeholder: "e.g. vehicle moved by owner" }]} />
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
