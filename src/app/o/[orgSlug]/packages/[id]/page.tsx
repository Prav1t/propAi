import { getOrgContext, orNotFound } from "@/server/org-context";
import { getPackage } from "@/server/modules/packages/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { AttachmentList } from "@/components/ops/attachments";
import { ReleasePanel } from "@/components/community/release-panel";
import { PACKAGE_SIZE, PACKAGE_STATUS } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { releasePackagesAction, returnPackageAction } from "../../community-actions";

export const metadata = { title: "Package" };

export default async function PackagePage({ params }: PageProps<"/o/[orgSlug]/packages/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getPackage(ctx, id));
  const k = d.package;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  return (
    <>
      <Breadcrumbs items={[{ label: d.access.manage ? "Packages" : "My packages", href: `${base}/packages` }, { label: `Unit ${d.labels?.unitNumber}` }]} />
      <PageHeader title={`${k.carrier ?? "Package"} for ${k.recipientName ?? `Unit ${d.labels?.unitNumber}`}`} description={`${d.labels?.buildingName} · Unit ${d.labels?.unitNumber}`}
        actions={<Badge tone={PACKAGE_STATUS[k.status]?.tone}>{PACKAGE_STATUS[k.status]?.label}</Badge>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            <DetailList items={[
              ["Received", `${fmtDateTime(k.receivedAt, tz)}${d.receivedByName ? ` by ${d.receivedByName}` : ""}`],
              ["Pickup code", k.pickupCode && k.status === "waiting" ? <span key="c" className="font-mono text-lg font-semibold tracking-widest">{k.pickupCode}</span> : null],
              ["Carrier", k.carrier], ["Tracking", k.trackingNumber], ["Size", PACKAGE_SIZE[k.size]], ["Perishable", k.perishable ? "Yes — refrigerate" : null],
              ["Shelf", k.shelfLocation], ["Notes", k.notes],
              ["Picked up", k.pickedUpAt ? `${fmtDateTime(k.pickedUpAt, tz)} by ${k.pickedUpByName}${d.releasedByName ? ` (released by ${d.releasedByName})` : ""}` : null],
              ["Returned", k.returnedAt ? `${fmtDateTime(k.returnedAt, tz)} — ${k.returnReason}` : null],
            ]} />
          </Panel>
          <Panel>
            <PanelHeader title={d.access.manage ? "Photos & signature" : "Photo"} />
            <AttachmentList files={d.attachments} base={base} />
          </Panel>
        </div>
        {d.access.manage && k.status === "waiting" ? (
          <div className="space-y-6">
            <Panel><PanelHeader title="Release" /><ReleasePanel action={releasePackagesAction.bind(null, orgSlug)} single={{ id, recipient: k.recipientName }} /></Panel>
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">Return to sender</summary>
                <div className="border-t border-border p-4"><SchemaForm action={returnPackageAction.bind(null, orgSlug, id)} submitLabel="Mark returned" fields={[{ name: "reason", label: "Reason", placeholder: "Refused / not a resident / unclaimed after 14 days" }]} /></div>
              </details>
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}
