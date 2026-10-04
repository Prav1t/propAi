import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { residentUnitsForRequests } from "@/server/modules/maintenance/service";
import { PRIORITY_ORDER, WO_CATEGORIES } from "@/server/modules/maintenance/rules";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { assetOptions, woCategoryForAsset } from "@/server/modules/assets/service";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { PRIORITY, WO_CATEGORY } from "@/lib/ops-labels";
import { createWorkOrderAction } from "../../ops-actions";
import { WorkOrderForm } from "./wo-form";

export const metadata = { title: "New request" };

export default async function NewWorkOrderPage({ params, searchParams }: PageProps<"/o/[orgSlug]/maintenance/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("workorder.create")) notFound();
  const resident = principal.role.category === "resident";
  const units = resident ? (await residentUnitsForRequests(ctx)).map((u) => ({ value: u.id, label: `Unit ${u.number} · ${u.building}, ${u.property}` })) : [];
  const buildings = resident ? [] : (await listBuildingOptions(ctx)).map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }));
  const assets = resident ? [] : await assetOptions(ctx);
  // "Report a problem" from an asset page pre-selects it
  const fromAsset = assets.find((a) => a.id === sp(q.asset));
  return (
    <>
      <Breadcrumbs items={[{ label: resident ? "My requests" : "Maintenance", href: `/o/${orgSlug}/maintenance` }, { label: "New" }]} />
      <PageHeader title={resident ? "Report a problem" : "Create work order"} description={resident ? "Tell us what's wrong. We'll route it to the right person and keep you updated." : "Triage rules and SLA targets apply automatically."} />
      <Panel className="max-w-2xl p-4 sm:p-6">
        {resident && units.length === 0 ? (
          <EmptyState title="No unit linked to your account">Ask your building manager to link your account to your unit, then you can submit requests here.</EmptyState>
        ) : (
          <WorkOrderForm action={createWorkOrderAction.bind(null, orgSlug)} mode={resident ? "resident" : "staff"} units={units} buildings={buildings}
            assets={assets.map((a) => ({ value: a.id, label: `${a.name}${a.tag ? ` (${a.tag})` : ""} · ${a.propertyName}` }))}
            defaults={fromAsset ? { assetId: fromAsset.id, buildingId: fromAsset.buildingId ?? "", category: woCategoryForAsset(fromAsset.category) } : {}}
            categories={WO_CATEGORIES.map((c) => ({ value: c, label: WO_CATEGORY[c] }))} priorities={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY[p].label }))} />
        )}
      </Panel>
    </>
  );
}
