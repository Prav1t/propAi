import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import {
  canManageParking, canUseParking, listPermits, listSpaces, listVehicles, listViolations, myParking, parkingFormOptions, parkingStats, type PermitView, type ViolationView,
} from "@/server/modules/parking/service";
import { PARKING_SPACE_KINDS } from "@/server/db/schema";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { PlateLookup } from "@/components/frontdesk/plate-lookup";
import { PERMIT_KIND, PERMIT_STATE, SPACE_KIND, VIOLATION_KIND, VIOLATION_SOURCE, VIOLATION_STATUS, fmtPlate } from "@/lib/facility-labels";
import { opts } from "@/lib/labels";
import { fmtDateTime, relative, zonedParts } from "@/lib/time";
import {
  addVehicleAction, bulkSpacesAction, createSpaceAction, issuePermitAction, lookupPlateAction, removeVehicleAction,
} from "../frontdesk-actions";

export const metadata = { title: "Parking" };

const TABS = [{ key: "violations", label: "Reports & notices" }, { key: "spaces", label: "Spaces" }, { key: "permits", label: "Permits" }, { key: "vehicles", label: "Vehicles" }] as const;

export default async function ParkingPage({ params, searchParams }: PageProps<"/o/[orgSlug]/parking">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseParking(principal)) notFound();
  const base = `/o/${orgSlug}/parking`;

  if (!canManageParking(principal)) {
    const mine = await myParking(ctx);
    return (
      <>
        <PageHeader title="My parking" description="Your spaces, registered vehicles and permits." />
        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Panel>
            <PanelHeader title="Assigned spaces" />
            {mine.spaces.length === 0 ? <EmptyState title="No assigned space">Ask the front desk about parking at your building.</EmptyState> : (
              <ul className="divide-y divide-border text-sm">{mine.spaces.map((s) => <li key={s.id} className="flex justify-between gap-3 px-4 py-2.5"><span className="font-medium">Space {s.code}</span><span className="text-muted">{[s.level, SPACE_KIND[s.kind]].filter(Boolean).join(" · ")}</span></li>)}</ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Permits" />
            {mine.permits.length === 0 ? <EmptyState title="No active permits" /> : (
              <ul className="divide-y divide-border text-sm">{mine.permits.map((x) => (
                <li key={x.id} className="flex flex-wrap justify-between gap-3 px-4 py-2.5"><span><span className="font-mono font-medium">{fmtPlate(x.plate)}</span> · {PERMIT_KIND[x.kind]} permit #{x.number}{x.spaceCode ? ` · space ${x.spaceCode}` : ""}</span>
                  <span className="text-muted">{x.validUntil ? `until ${fmtDateTime(x.validUntil, x.tz)}` : "no end date"}</span></li>
              ))}</ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="My vehicles" description="Registered plates help the desk and patrols know whose car it is." />
            {mine.vehicles.length === 0 ? <EmptyState title="No vehicles registered" /> : (
              <ul className="divide-y divide-border text-sm">{mine.vehicles.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <span><span className="font-mono font-medium">{fmtPlate(v.plate)}</span> <span className="text-muted">{[v.color, v.make, v.model].filter(Boolean).join(" ")}</span></span>
                  <ConfirmAction action={removeVehicleAction.bind(null, orgSlug, v.id)} label="Remove" confirmLabel="Remove vehicle" variant="secondary" description="Permits for this vehicle are revoked too." />
                </li>
              ))}</ul>
            )}
            <div className="border-t border-border">
              <SchemaForm action={addVehicleAction.bind(null, orgSlug)} submitLabel="Register vehicle" columns={2} resetOnSuccess className="p-4" fields={[
                { name: "plate", label: "Licence plate", required: true },
                { name: "region", label: "Province / state", placeholder: "BC" },
                { name: "make", label: "Make" }, { name: "model", label: "Model" }, { name: "color", label: "Colour" },
              ]} />
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Parking notices" />
            {mine.notices.length === 0 ? <EmptyState title="No notices">You&apos;ll be notified if building staff issue a notice about one of your vehicles.</EmptyState> : (
              <ul className="divide-y divide-border text-sm">{mine.notices.map((n) => (
                <li key={n.id} className="flex justify-between gap-3 px-4 py-2.5"><Link href={`${base}/violations/${n.id}`} className="hover:underline">Notice #{n.number} · {fmtPlate(n.plate)} · {VIOLATION_KIND[n.kind]}</Link><Badge tone={VIOLATION_STATUS[n.status]?.tone}>{n.status === "resolved" ? "Resolved" : "Open"}</Badge></li>
              ))}</ul>
            )}
          </Panel>
        </div>
      </>
    );
  }

  const tab = TABS.find((t) => t.key === sp(q.tab))?.key ?? "violations";
  const [stats, opt] = await Promise.all([parkingStats(ctx), parkingFormOptions(ctx)]);
  const tabHref = (k: string) => `${base}?tab=${k}`;
  const keep = (extra: Record<string, string>) => { const s = new URLSearchParams(); for (const [a, b] of Object.entries(q)) if (typeof b === "string" && a !== "page") s.set(a, b); for (const [a, b] of Object.entries(extra)) s.set(a, b); return `${base}?${s}`; };
  const propOptions = opt.properties.map((x) => ({ value: x.id, label: x.name }));
  const buildingOptions = opt.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }));
  const tz = principal.orgTimezone ?? "America/Vancouver";
  const today = zonedParts(new Date(), tz).date;

  return (
    <>
      <PageHeader title="Parking" description="Spaces, permits, registered vehicles and violation reports." actions={<LinkButton href={`${base}/violations/new`}>Report a violation</LinkButton>} />
      {stats ? (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Reports to review" value={<span className={stats.review ? "text-warning" : undefined}>{stats.review}</span>} sub={stats.detections ? `${stats.detections} camera detection${stats.detections === 1 ? "" : "s"}` : undefined} />
          <Stat label="Open (confirmed)" value={stats.open} />
          <Stat label="Visitor spaces free now" value={`${stats.visitorFree} / ${stats.visitor}`} />
          <Stat label="Active permits" value={stats.activePermits} sub={`${stats.spaces} spaces`} />
        </div>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-3 [&>*]:min-w-0">
        <Panel className="xl:col-span-2">
          <LinkTabs active={tab} tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: tabHref(t.key) }))} />
          {tab === "violations" ? await (async () => {
            const views: { key: ViolationView; label: string }[] = [{ key: "review", label: "To review" }, { key: "open", label: "Open" }, { key: "closed", label: "Closed" }, { key: "all", label: "All" }];
            const view = views.find((v) => v.key === sp(q.view))?.key ?? "review";
            const data = await orNotFound(listViolations(ctx, { view, q: sp(q.q), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
            return (
              <>
                <nav aria-label="Report status" className="flex flex-wrap gap-1 border-b border-border px-3 py-2 text-[13px]">
                  {views.map((v) => <Link key={v.key} href={keep({ view: v.key })} aria-current={v.key === view ? "page" : undefined} className={`rounded-full px-2.5 py-1 ${v.key === view ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-subtle"}`}>{v.label}</Link>)}
                </nav>
                <FilterBar searchPlaceholder="Plate or report #…" filters={propOptions.length > 1 ? [{ name: "property", label: "Property", options: propOptions }] : []} />
                {data.rows.length === 0 ? <EmptyState title={view === "review" ? "Nothing to review" : "No reports here"} /> : (
                  <Table>
                    <thead><tr><Th>Report</Th><Th>Plate</Th><Th className="hidden md:table-cell">Where</Th><Th>Status</Th></tr></thead>
                    <tbody>{data.rows.map((v) => (
                      <tr key={v.id} className="hover:bg-subtle/60">
                        <Td><Link href={`${base}/violations/${v.id}`} className="font-medium hover:underline">#{v.number} {VIOLATION_KIND[v.kind]}</Link>
                          <div className="text-xs text-faint">{VIOLATION_SOURCE[v.source]}{v.source === "detection" && v.confidence ? ` · ${Math.round(Number(v.confidence) * 100)}% confidence` : ""} · {relative(v.observedAt)}</div></Td>
                        <Td className="font-mono text-[13px]">{fmtPlate(v.plate)}{v.unitNumber ? <div className="font-sans text-xs text-faint">Unit {v.unitNumber}</div> : null}</Td>
                        <Td className="hidden text-[13px] md:table-cell">{[v.spaceCode ? `Space ${v.spaceCode}` : null, v.location].filter(Boolean).join(" · ") || "—"}<div className="text-xs text-faint">{v.propertyName}</div></Td>
                        <Td><Badge tone={VIOLATION_STATUS[v.status]?.tone}>{VIOLATION_STATUS[v.status]?.label}</Badge></Td>
                      </tr>
                    ))}</tbody>
                  </Table>
                )}
                <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
              </>
            );
          })() : null}
          {tab === "spaces" ? await (async () => {
            const data = await orNotFound(listSpaces(ctx, { propertyId: sp(q.property), kind: sp(q.kind), q: sp(q.q), page: Number(sp(q.page)) || 1 }));
            const now = new Date();
            return (
              <>
                <FilterBar searchPlaceholder="Space number…" filters={[...(propOptions.length > 1 ? [{ name: "property", label: "Property", options: propOptions }] : []), { name: "kind", label: "Type", options: opts(SPACE_KIND) }]} />
                {data.rows.length === 0 ? <EmptyState title="No spaces yet">Add spaces with the forms on this page.</EmptyState> : (
                  <Table>
                    <thead><tr><Th>Space</Th><Th>Type</Th><Th>Assigned</Th><Th>Right now</Th></tr></thead>
                    <tbody>{data.rows.map((s) => (
                      <tr key={s.id} className="hover:bg-subtle/60">
                        <Td><Link href={`${base}/spaces/${s.id}`} className="font-medium hover:underline">{s.code}</Link><div className="text-xs text-faint">{[s.level, s.propertyName].filter(Boolean).join(" · ")}</div></Td>
                        <Td className="text-[13px]">{SPACE_KIND[s.kind]}{s.status === "out_of_service" ? <Badge tone="warning" className="ml-2">Out of service</Badge> : null}</Td>
                        <Td className="text-[13px]">{s.assignedUnit ? `Unit ${s.assignedUnit}` : "—"}</Td>
                        <Td className="text-[13px]">{s.permitPlate ? <><span className="font-mono">{fmtPlate(s.permitPlate)}</span><div className="text-xs text-faint">{PERMIT_KIND[s.permitKind ?? ""]}{s.permitUntil ? ` · ${relative(s.permitUntil, now).replace("in ", "")} left` : ""}</div></> : <span className="text-faint">Free</span>}</Td>
                      </tr>
                    ))}</tbody>
                  </Table>
                )}
                <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
              </>
            );
          })() : null}
          {tab === "permits" ? await (async () => {
            const views: { key: PermitView; label: string }[] = [{ key: "active", label: "Active" }, { key: "expired", label: "Expired" }, { key: "revoked", label: "Revoked" }, { key: "all", label: "All" }];
            const view = views.find((v) => v.key === sp(q.view))?.key ?? "active";
            const data = await orNotFound(listPermits(ctx, { view, q: sp(q.q), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
            return (
              <>
                <nav aria-label="Permit status" className="flex flex-wrap gap-1 border-b border-border px-3 py-2 text-[13px]">
                  {views.map((v) => <Link key={v.key} href={keep({ view: v.key })} aria-current={v.key === view ? "page" : undefined} className={`rounded-full px-2.5 py-1 ${v.key === view ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-subtle"}`}>{v.label}</Link>)}
                </nav>
                <FilterBar searchPlaceholder="Plate, unit or permit #…" filters={propOptions.length > 1 ? [{ name: "property", label: "Property", options: propOptions }] : []} />
                {data.rows.length === 0 ? <EmptyState title="No permits here" /> : (
                  <Table>
                    <thead><tr><Th>Permit</Th><Th>Plate</Th><Th className="hidden md:table-cell">Unit / space</Th><Th>Valid</Th></tr></thead>
                    <tbody>{data.rows.map((x) => (
                      <tr key={x.id}>
                        <Td><span className="font-medium">#{x.number}</span> <span className="text-[13px] text-muted">{PERMIT_KIND[x.kind]}</span><div className="text-xs text-faint">{x.propertyName}</div></Td>
                        <Td className="font-mono text-[13px]">{fmtPlate(x.plate)}</Td>
                        <Td className="hidden text-[13px] md:table-cell">{[x.unitNumber ? `Unit ${x.unitNumber}` : null, x.spaceCode ? `Space ${x.spaceCode}` : null].filter(Boolean).join(" · ") || "—"}</Td>
                        <Td className="text-[13px]"><Badge tone={PERMIT_STATE[x.state]?.tone}>{PERMIT_STATE[x.state]?.label}</Badge><div className="text-xs text-faint">{x.validUntil ? `until ${fmtDateTime(x.validUntil, x.tz)}` : "no end date"}</div></Td>
                      </tr>
                    ))}</tbody>
                  </Table>
                )}
                <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
              </>
            );
          })() : null}
          {tab === "vehicles" ? await (async () => {
            const data = await orNotFound(listVehicles(ctx, { q: sp(q.q), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
            return (
              <>
                <FilterBar searchPlaceholder="Plate or unit…" filters={propOptions.length > 1 ? [{ name: "property", label: "Property", options: propOptions }] : []} />
                {data.rows.length === 0 ? <EmptyState title="No vehicles" /> : (
                  <Table>
                    <thead><tr><Th>Plate</Th><Th>Vehicle</Th><Th>Unit</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                    <tbody>{data.rows.map((v) => (
                      <tr key={v.id}>
                        <Td className="font-mono font-medium">{fmtPlate(v.plate)}{v.region ? <span className="ml-1 font-sans text-xs text-faint">{v.region}</span> : null}</Td>
                        <Td className="text-[13px]">{[v.color, v.make, v.model].filter(Boolean).join(" ") || "—"}</Td>
                        <Td className="text-[13px]">Unit {v.unitNumber}<div className="text-xs text-faint">{v.buildingName}</div></Td>
                        <Td className="text-right"><ConfirmAction action={removeVehicleAction.bind(null, orgSlug, v.id)} label="Remove" confirmLabel="Remove" variant="secondary" /></Td>
                      </tr>
                    ))}</tbody>
                  </Table>
                )}
                <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
              </>
            );
          })() : null}
        </Panel>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Plate lookup" />
            <div className="p-4"><PlateLookup action={lookupPlateAction.bind(null, orgSlug)} base={`/o/${orgSlug}`} /></div>
          </Panel>
          {tab === "spaces" ? (
            <>
              <Panel>
                <PanelHeader title="Add a space" />
                <SchemaForm action={createSpaceAction.bind(null, orgSlug)} submitLabel="Add space" resetOnSuccess className="p-4" fields={[
                  { name: "propertyId", label: "Property", type: "select", options: propOptions, defaultValue: propOptions[0]?.value },
                  { name: "code", label: "Space number", required: true, placeholder: "P1-024" },
                  { name: "kind", label: "Type", type: "select", options: PARKING_SPACE_KINDS.map((k) => ({ value: k, label: SPACE_KIND[k] })) },
                  { name: "level", label: "Level (optional)", placeholder: "P1" },
                  { name: "assignBuildingId", label: "Assigned unit's building", type: "select", options: [{ value: "", label: "Not assigned" }, ...buildingOptions] },
                  { name: "assignUnitNumber", label: "Assigned unit (optional)" },
                ]} />
              </Panel>
              <Panel>
                <PanelHeader title="Add a range" description="e.g. P1-001 to P1-060" />
                <SchemaForm action={bulkSpacesAction.bind(null, orgSlug)} submitLabel="Add spaces" columns={2} className="p-4" fields={[
                  { name: "propertyId", label: "Property", type: "select", options: propOptions, defaultValue: propOptions[0]?.value, span: 2 },
                  { name: "prefix", label: "Prefix", placeholder: "P1-" }, { name: "pad", label: "Digits", type: "number", defaultValue: 3 },
                  { name: "from", label: "From", type: "number", defaultValue: 1 }, { name: "to", label: "To", type: "number", defaultValue: 20 },
                  { name: "kind", label: "Type", type: "select", options: PARKING_SPACE_KINDS.map((k) => ({ value: k, label: SPACE_KIND[k] })) },
                  { name: "level", label: "Level" },
                ]} />
              </Panel>
            </>
          ) : null}
          {tab === "permits" ? (
            <Panel>
              <PanelHeader title="Issue a permit" />
              <SchemaForm action={issuePermitAction.bind(null, orgSlug)} submitLabel="Issue permit" columns={2} resetOnSuccess className="p-4" fields={[
                { name: "propertyId", label: "Property", type: "select", options: propOptions, defaultValue: propOptions[0]?.value, span: 2 },
                { name: "kind", label: "Type", type: "select", options: opts(PERMIT_KIND) }, { name: "plate", label: "Licence plate", required: true },
                { name: "buildingId", label: "Unit's building", type: "select", options: [{ value: "", label: "No unit" }, ...buildingOptions], span: 2 },
                { name: "unitNumber", label: "Unit" }, { name: "spaceCode", label: "Space (optional)" },
                { name: "fromDate", label: "From", type: "date", defaultValue: today }, { name: "fromTime", label: "Time", type: "time", defaultValue: "00:00" },
                { name: "untilDate", label: "Until (optional)", type: "date" }, { name: "untilTime", label: "Time", type: "time", defaultValue: "23:59" },
                { name: "notes", label: "Notes", span: 2 },
              ]} />
            </Panel>
          ) : null}
          {tab === "vehicles" ? (
            <Panel>
              <PanelHeader title="Register a vehicle" />
              <SchemaForm action={addVehicleAction.bind(null, orgSlug)} submitLabel="Register" columns={2} resetOnSuccess className="p-4" fields={[
                { name: "plate", label: "Licence plate", required: true }, { name: "region", label: "Province / state" },
                { name: "buildingId", label: "Building", type: "select", options: buildingOptions, span: 2 }, { name: "unitNumber", label: "Unit", required: true },
                { name: "color", label: "Colour" }, { name: "make", label: "Make" }, { name: "model", label: "Model" },
              ]} />
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
