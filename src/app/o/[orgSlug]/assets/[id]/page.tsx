import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { assetFormOptions, getAsset } from "@/server/modules/assets/service";
import { ASSET_STATUSES } from "@/server/db/schema";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { LinkButton } from "@/components/ui/button";
import { SchemaForm } from "@/components/ui/schema-form";
import { ActionButton } from "@/components/ops/action-button";
import { AttachmentList, UploadForm } from "@/components/ops/attachments";
import { ASSET_CATEGORY, ASSET_STATUS, CRITICALITY, INTERVAL_UNIT, hours } from "@/lib/facility-labels";
import { PRIORITY, WO_STATUS } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import { assetStatusAction, createPmAction, generatePmAction, pmActiveAction, updateAssetAction } from "../../frontdesk-actions";
import { uploadAttachmentAction } from "../../ops-actions";
import { assetFields } from "../asset-fields";

export const metadata = { title: "Asset" };
const money = (n: number) => `$${n.toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;

export default async function AssetPage({ params }: PageProps<"/o/[orgSlug]/assets/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getAsset(ctx, id));
  const a = d.asset;
  const tz = d.labels.tz;
  const base = `/o/${orgSlug}`;
  const manage = d.access.manage;
  const o = manage ? await assetFormOptions(ctx) : null;
  return (
    <>
      <Breadcrumbs items={[{ label: "Assets", href: `${base}/assets` }, { label: a.name }]} />
      <PageHeader title={a.name} description={`${ASSET_CATEGORY[a.category]} · ${d.labels.propertyName}${d.labels.buildingName ? ` · ${d.labels.buildingName}` : ""}${a.location ? ` · ${a.location}` : ""}`}
        actions={<div className="flex flex-wrap items-center gap-2"><Badge tone={ASSET_STATUS[a.status]?.tone}>{ASSET_STATUS[a.status]?.label}</Badge>
          <LinkButton size="sm" variant="secondary" href={`${base}/maintenance/new?asset=${a.id}`}>Report a problem</LinkButton></div>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Reactive requests (90 d)" value={<span className={d.stats.reactive90d >= 3 ? "text-warning" : undefined}>{d.stats.reactive90d}</span>} />
        <Stat label="Downtime (90 d)" value={hours(d.stats.downtime90d)} sub={`${d.stats.outages365d} outage${d.stats.outages365d === 1 ? "" : "s"} in 12 months`} />
        <Stat label="Maintenance cost (12 mo)" value={money(d.stats.cost365d)} sub={`${money(d.stats.reactiveCost365d)} reactive`} />
        <Stat label="PM completed (12 mo)" value={d.stats.pmDone365d} />
      </div>
      {d.openDowntime ? <div className="mb-6 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger" role="status">Out of service since {fmtDateTime(d.openDowntime.startedAt, tz)} — {d.openDowntime.reason}{d.openDowntime.workOrderId ? <> · <Link className="underline" href={`${base}/maintenance/${d.openDowntime.workOrderId}`}>repair work order</Link></> : null}</div> : null}
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-6 lg:col-span-2">
          <Panel>
            <PanelHeader title="Preventive maintenance" description="Work orders open automatically ahead of each due date." />
            {d.schedules.length === 0 ? <EmptyState title="No schedules" /> : (
              <Table>
                <thead><tr><Th>Task</Th><Th>Every</Th><Th>Next due</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                <tbody>{d.schedules.map((s) => (
                  <tr key={s.id} className={s.active ? undefined : "opacity-60"}>
                    <Td><span className="font-medium">{s.title}</span><div className="text-xs text-faint">{[s.vendorName ?? s.assigneeName, PRIORITY[s.priority]?.label ? `${PRIORITY[s.priority].label} priority` : null, `opens ${s.leadDays} days ahead`].filter(Boolean).join(" · ")}</div></Td>
                    <Td className="text-[13px]">{s.every}</Td>
                    <Td className="text-[13px]">{s.nextDueOn}{s.lastWorkOrderId ? <div className="text-xs"><Link className="text-accent hover:underline" href={`${base}/maintenance/${s.lastWorkOrderId}`}>last work order</Link></div> : null}</Td>
                    <Td className="space-x-1 text-right">{manage ? <>
                      {s.active ? <ActionButton action={generatePmAction.bind(null, orgSlug, s.id)} label="Create now" /> : null}
                      <ActionButton action={pmActiveAction.bind(null, orgSlug, s.id, !s.active)} label={s.active ? "Pause" : "Resume"} variant="ghost" />
                    </> : s.active ? null : <Badge>Paused</Badge>}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
            {manage && a.status !== "retired" ? (
              <details className="border-t border-border">
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-accent">Add a schedule</summary>
                <SchemaForm action={createPmAction.bind(null, orgSlug, id)} submitLabel="Add schedule" columns={2} resetOnSuccess className="px-4 pb-4" fields={[
                  { name: "title", label: "Task", required: true, placeholder: "Quarterly filter change", span: 2 },
                  { name: "intervalCount", label: "Every", type: "number", defaultValue: 1 },
                  { name: "intervalUnit", label: "Unit", type: "select", options: Object.entries(INTERVAL_UNIT).map(([value, label]) => ({ value, label })), defaultValue: "month" },
                  { name: "nextDueOn", label: "Next due", type: "date", required: true },
                  { name: "leadDays", label: "Open work order this many days ahead", type: "number", defaultValue: 7 },
                  { name: "priority", label: "Priority", type: "select", options: Object.entries(PRIORITY).map(([value, v]) => ({ value, label: v.label })), defaultValue: "normal" },
                  { name: "assignVendorId", label: "Assign to vendor", type: "select", options: [{ value: "", label: "Nobody" }, ...(o?.vendors ?? []).map((v) => ({ value: v.id, label: v.name }))], defaultValue: a.vendorId ?? "" },
                  { name: "assignMembershipId", label: "…or staff member", type: "select", options: [{ value: "", label: "Nobody" }, ...(o?.staff ?? []).map((s) => ({ value: s.id, label: s.name }))] },
                  { name: "instructions", label: "Instructions", type: "textarea", span: 2 },
                ]} />
              </details>
            ) : null}
          </Panel>
          <Panel>
            <PanelHeader title="Work order history" />
            {d.history.length === 0 ? <EmptyState title="No work orders yet" /> : (
              <Table>
                <thead><tr><Th>Request</Th><Th>Status</Th><Th className="hidden md:table-cell">Opened</Th><Th className="text-right">Cost</Th></tr></thead>
                <tbody>{d.history.map((w) => (
                  <tr key={w.id}>
                    <Td><Link href={`${base}/maintenance/${w.id}`} className="hover:underline">#{w.number} {w.title}</Link><div className="text-xs text-faint">{w.sourceType === "pm_schedule" ? "Preventive" : "Reactive"}{w.vendorName ? ` · ${w.vendorName}` : ""}</div></Td>
                    <Td><Badge tone={WO_STATUS[w.status]?.tone}>{WO_STATUS[w.status]?.label}</Badge></Td>
                    <Td className="hidden text-[13px] md:table-cell">{fmtDateTime(w.createdAt, tz)}</Td>
                    <Td className="text-right tabular-nums text-[13px]">{w.cost ? money(Number(w.cost)) : "—"}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Downtime" />
            {d.downtime.length === 0 ? <EmptyState title="No recorded downtime" /> : (
              <ul className="divide-y divide-border text-[13px]">{d.downtime.map((x) => (
                <li key={x.id} className="flex flex-wrap justify-between gap-2 px-4 py-2.5"><span>{x.reason}</span>
                  <span className="text-muted">{fmtDateTime(x.startedAt, tz)} → {x.endedAt ? `${fmtDateTime(x.endedAt, tz)} (${hours((x.endedAt.getTime() - x.startedAt.getTime()) / 3_600_000)})` : "ongoing"}</span></li>
              ))}</ul>
            )}
          </Panel>
          {manage && o ? (
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Edit details</summary>
                <SchemaForm action={updateAssetAction.bind(null, orgSlug, id)} submitLabel="Save" columns={2} className="px-4 pb-4"
                  fields={assetFields({ properties: o.properties.map((p) => ({ value: p.id, label: p.name })), buildings: o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })), vendors: o.vendors.map((v) => ({ value: v.id, label: v.name })) }, a)} />
              </details>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Details" />
            <DetailList items={[
              ["Tag", a.tag], ["Make / model", [a.make, a.model].filter(Boolean).join(" ") || null], ["Serial", a.serialNumber],
              ["Criticality", <Badge key="c" tone={CRITICALITY[a.criticality]?.tone}>{CRITICALITY[a.criticality]?.label}</Badge>],
              ["Installed", a.installedOn], ["Warranty", a.warrantyUntil ? `until ${a.warrantyUntil}` : null], ["Expected life", a.expectedLifeYears ? `${a.expectedLifeYears} years` : null],
              ["Replacement", a.replacementCost ? money(Number(a.replacementCost)) : null],
              ["Service vendor", d.vendor ? <Link key="v" className="text-accent hover:underline" href={`${base}/vendors/${d.vendor.id}`}>{d.vendor.name}</Link> : null],
              ["Notes", a.notes],
            ]} />
          </Panel>
          {manage ? (
            <Panel>
              <PanelHeader title="Status" description="Marking it out of service starts a downtime record." />
              <SchemaForm action={assetStatusAction.bind(null, orgSlug, id)} submitLabel="Update status" className="p-4" fields={[
                { name: "status", label: "Status", type: "select", options: ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS[s].label })), defaultValue: a.status },
                { name: "note", label: "What's wrong / note" },
              ]} />
            </Panel>
          ) : null}
          <Panel>
            <PanelHeader title="Files" description="Manuals, warranty papers, photos." />
            <div className="space-y-3 p-4">
              {d.attachments.length ? <AttachmentList files={d.attachments} base={base} /> : <p className="text-[13px] text-muted">No files yet.</p>}
              {manage ? <UploadForm action={uploadAttachmentAction.bind(null, orgSlug, "asset", id)} levels={["internal"]} /> : null}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
