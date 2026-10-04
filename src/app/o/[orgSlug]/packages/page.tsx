import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canManagePackages, canUsePackages, listPackages, OVERDUE_DAYS, packageStats, type PackageView } from "@/server/modules/packages/service";
import { CARRIERS } from "@/server/modules/packages/carrier";
import { PACKAGE_SIZES } from "@/server/db/schema";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { PackageIntake } from "@/components/community/package-intake";
import { ReleasePanel } from "@/components/community/release-panel";
import { PACKAGE_SIZE, PACKAGE_STATUS } from "@/lib/community-labels";
import { fmtDateTime, relative } from "@/lib/time";
import { logPackageAction, releasePackagesAction } from "../community-actions";

export const metadata = { title: "Packages" };

export default async function PackagesPage({ params, searchParams }: PageProps<"/o/[orgSlug]/packages">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUsePackages(principal)) notFound();
  const staff = canManagePackages(principal);
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}/packages`;

  if (!staff) {
    const waiting = await listPackages(ctx, { view: "waiting", pageSize: 50 });
    const history = await listPackages(ctx, { view: "all", page: Number(sp(q.page)) || 1, pageSize: 20 });
    return (
      <>
        <PageHeader title="My packages" description="Show your pickup code at the front desk." />
        <Panel className="mb-6">
          <PanelHeader title={waiting.total ? `${waiting.total} waiting for pickup` : "Nothing waiting"} />
          {waiting.rows.length === 0 ? <EmptyState title="No packages waiting">You&apos;ll get a notification when something arrives.</EmptyState> : (
            <ul className="divide-y divide-border">
              {waiting.rows.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <Link href={`${base}/${k.id}`} className="font-medium hover:underline">{k.carrier ?? "Package"}{k.perishable ? " · perishable" : ""}</Link>
                    <p className="text-[13px] text-muted">Arrived {relative(k.receivedAt)} · {PACKAGE_SIZE[k.size]}{k.recipientName ? ` · for ${k.recipientName}` : ""}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-faint">Pickup code</p>
                    <p className="font-mono text-xl font-semibold tracking-widest" aria-label={`Pickup code ${k.pickupCode?.split("").join(" ")}`}>{k.pickupCode}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="History" />
          {history.rows.filter((k) => k.status !== "waiting").length === 0 ? <EmptyState title="No past packages" /> : (
            <ul className="divide-y divide-border">
              {history.rows.filter((k) => k.status !== "waiting").map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <span><Link className="font-medium hover:underline" href={`${base}/${k.id}`}>{k.carrier ?? "Package"}</Link> <span className="text-faint">received {fmtDateTime(k.receivedAt, tz)}</span></span>
                  <span className="text-muted">{k.status === "picked_up" ? `Picked up${k.pickedUpByName ? ` by ${k.pickedUpByName}` : ""}` : PACKAGE_STATUS[k.status]?.label}</span>
                </li>
              ))}
            </ul>
          )}
          <Pagination page={history.page} pageCount={history.pageCount} total={history.total} basePath={base} params={q} />
        </Panel>
      </>
    );
  }

  const views: { key: PackageView; label: string }[] = [{ key: "waiting", label: "Waiting" }, { key: "overdue", label: `Over ${OVERDUE_DAYS} days` }, { key: "picked_up", label: "Picked up" }, { key: "returned", label: "Returned" }, { key: "all", label: "All" }];
  const view = views.find((v) => v.key === sp(q.view))?.key ?? "waiting";
  const data = await orNotFound(listPackages(ctx, { view, q: sp(q.q), buildingId: sp(q.building), page: Number(sp(q.page)) || 1 }));
  const stats = await packageStats(ctx);
  const buildings = (await listBuildingOptions(ctx)).filter((b) => can(principal, "package.manage", { orgId: principal.orgId, propertyId: b.propertyId, buildingId: b.id }));
  const releasable = view === "waiting" || view === "overdue";
  const overdueBefore = new Date(new Date().getTime() - OVERDUE_DAYS * 86_400_000);
  const keep = (k: string) => { const s = new URLSearchParams(); for (const [a, b] of Object.entries(q)) if (typeof b === "string" && a !== "page" && a !== "view") s.set(a, b); s.set("view", k); return `${base}?${s}`; };
  return (
    <>
      <PageHeader title="Packages" description="Log deliveries, notify residents and record pickups." />
      {stats ? (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Waiting" value={stats.waiting} />
          <Stat label={`Over ${OVERDUE_DAYS} days`} value={<span className={stats.overdue ? "text-warning" : undefined}>{stats.overdue}</span>} />
          <Stat label="Perishable waiting" value={<span className={stats.perishable ? "text-danger" : undefined}>{stats.perishable}</span>} />
          <Stat label="Received in 24 h" value={stats.last24h} />
        </div>
      ) : null}
      <Panel className="mb-6">
        <PanelHeader title="Log a package" />
        {buildings.length ? (
          <PackageIntake action={logPackageAction.bind(null, orgSlug)} buildings={buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))}
            carriers={CARRIERS} sizes={PACKAGE_SIZES.map((s) => ({ value: s, label: PACKAGE_SIZE[s] }))} />
        ) : <EmptyState title="No buildings in your scope" />}
      </Panel>
      <div className="grid gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: keep(v.key), count: v.key === view ? data.total : null }))} />
          <FilterBar searchPlaceholder="Unit, name, tracking or pickup code…" filters={buildings.length > 1 ? [{ name: "building", label: "Building", options: buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })) }] : []} />
          {data.rows.length === 0 ? <EmptyState title={view === "waiting" ? "Nothing waiting" : "No packages here"} /> : (
            <Table>
              <thead><tr>{releasable ? <Th className="w-8"><span className="sr-only">Select</span></Th> : null}<Th>Unit</Th><Th>Package</Th><Th className="hidden md:table-cell">Shelf</Th><Th>{releasable ? "Waiting" : "Status"}</Th></tr></thead>
              <tbody>
                {data.rows.map((k) => (
                  <tr key={k.id} className="hover:bg-subtle/60">
                    {releasable ? <Td><input type="checkbox" name="ids" value={k.id} form="release-form" aria-label={`Select package for unit ${k.unitNumber}`} className="size-4 accent-[var(--color-accent)]" /></Td> : null}
                    <Td><span className="font-medium tabular-nums">{k.unitNumber}</span><div className="text-xs text-faint">{k.buildingName}</div></Td>
                    <Td>
                      <Link className="hover:underline" href={`${base}/${k.id}`}>{k.recipientName ?? "Resident"}</Link>
                      {k.perishable ? <Badge tone="danger" className="ml-2">Perishable</Badge> : null}
                      <div className="text-xs text-faint">{[k.carrier, PACKAGE_SIZE[k.size], k.trackingNumber ? `…${k.trackingNumber.slice(-6)}` : null, k.photos ? "photo" : null].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td className="hidden text-[13px] md:table-cell">{k.shelfLocation ?? "—"}</Td>
                    <Td className="text-[13px]">{k.status === "waiting" ? <span title={fmtDateTime(k.receivedAt, tz)} className={k.receivedAt < overdueBefore ? "font-medium text-warning" : "text-muted"}>{relative(k.receivedAt).replace(" ago", "")}</span>
                      : <><Badge tone={PACKAGE_STATUS[k.status]?.tone}>{PACKAGE_STATUS[k.status]?.label}</Badge>{k.pickedUpByName ? <span className="block text-xs text-faint">{k.pickedUpByName}</span> : null}</>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
        </Panel>
        {releasable ? (
          <Panel className="h-fit xl:sticky xl:top-20">
            <PanelHeader title="Release" />
            <ReleasePanel action={releasePackagesAction.bind(null, orgSlug)} />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
