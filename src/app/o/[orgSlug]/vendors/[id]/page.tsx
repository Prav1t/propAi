import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getVendor, VENDOR_CATEGORIES } from "@/server/modules/vendors/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { cat, daysUntil, VENDOR_STATUS } from "@/lib/labels";
import {
  addContactAction, assignVendorPropertyAction, deleteVendorAction, inviteVendorUserAction, removeContactAction,
  unassignVendorPropertyAction, updateVendorAction,
} from "../../portfolio-actions";
import { vendorFields } from "../vendor-fields";

export const metadata = { title: "Vendor" };

export default async function VendorPage({ params }: PageProps<"/o/[orgSlug]/vendors/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getVendor(ctx, id));
  const v = d.vendor;
  const base = `/o/${orgSlug}`;
  const days = daysUntil(v.insuranceExpiresOn);
  return (
    <>
      <Breadcrumbs items={[{ label: "Vendors", href: `${base}/vendors` }, { label: v.name }]} />
      <PageHeader title={v.name} description={v.categories.map(cat).join(" · ") || "Vendor"} actions={<Badge tone={VENDOR_STATUS[v.status].tone}>{VENDOR_STATUS[v.status].label}</Badge>} />
      {days !== null && days <= 30 ? (
        <div className={`mb-4 rounded-[var(--radius-md)] border px-3 py-2 text-[13px] ${days < 0 ? "border-danger/30 bg-danger-soft text-danger" : "border-warning/30 bg-warning-soft text-warning"}`}>
          {days < 0 ? `Insurance expired on ${v.insuranceExpiresOn}.` : `Insurance expires in ${days} day${days === 1 ? "" : "s"} (${v.insuranceExpiresOn}).`}
        </div>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            {d.canManage ? (
              <div className="space-y-4 p-4">
                <SchemaForm action={updateVendorAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save vendor" fields={vendorFields(VENDOR_CATEGORIES, v)} />
                {d.canDelete ? <ConfirmAction action={deleteVendorAction.bind(null, orgSlug, id)} label="Delete vendor…" confirmLabel="Delete vendor" requireText="DELETE" description="Removes the vendor, its contacts and approvals, and deactivates its users." /> : null}
              </div>
            ) : (
              <DetailList items={[
                ["Legal name", v.legalName], ["Email", v.email], ["Phone", v.phone],
                ["Website", v.website ? <a className="text-accent hover:underline" href={v.website} rel="noopener noreferrer nofollow" target="_blank">{v.website}</a> : null],
                ["Service areas", v.serviceAreas.join(", ") || null], ["Response SLA", v.slaResponseHours ? `${v.slaResponseHours} h` : null],
                ["Hourly rate", v.hourlyRate ? `$${v.hourlyRate}` : null], ["Licence", v.licenseNumber], ["Insurance expires", v.insuranceExpiresOn], ["Notes", v.notes],
              ]} />
            )}
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Approved properties" />
            {d.properties.length === 0 ? <EmptyState title="Not approved for any of your properties" /> : (
              <ul className="divide-y divide-border">
                {d.properties.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <Link className="hover:underline" href={`${base}/properties/${p.id}`}>{p.name}</Link>
                    {d.canUnassign(p.id) ? <ConfirmAction action={unassignVendorPropertyAction.bind(null, orgSlug, id, p.id)} label="Remove" confirmLabel="Remove" variant="secondary" /> : null}
                  </li>
                ))}
              </ul>
            )}
            {d.assignableProperties.length ? (
              <div className="border-t border-border p-4">
                <SchemaForm action={assignVendorPropertyAction.bind(null, orgSlug, id)} submitLabel="Approve" fields={[
                  { name: "propertyId", label: "Approve for", type: "select", options: [{ value: "", label: "Choose a property…" }, ...d.assignableProperties.map((p) => ({ value: p.id, label: p.name }))] },
                ]} />
              </div>
            ) : null}
          </Panel>
          <Panel>
            <PanelHeader title="Contacts" />
            {d.contacts.length === 0 ? <EmptyState title="No contacts" /> : (
              <ul className="divide-y divide-border">
                {d.contacts.map((c) => (
                  <li key={c.id} className="flex items-start justify-between gap-2 px-4 py-2.5 text-sm">
                    <span><span className="font-medium">{c.name}</span>{c.isPrimary ? <Badge tone="accent" className="ml-2">Primary</Badge> : null}
                      <span className="block text-xs text-faint">{[c.title, c.phone, c.email].filter(Boolean).join(" · ")}</span></span>
                    {d.canManage ? <ConfirmAction action={removeContactAction.bind(null, orgSlug, c.id)} label="Remove" confirmLabel="Remove" variant="secondary" /> : null}
                  </li>
                ))}
              </ul>
            )}
            {d.canManage ? (
              <details className="border-t border-border px-4 py-3">
                <summary className="cursor-pointer text-[13px] text-accent">Add contact</summary>
                <div className="pt-3"><SchemaForm action={addContactAction.bind(null, orgSlug, id)} submitLabel="Add contact" resetOnSuccess fields={[
                  { name: "name", label: "Name", required: true }, { name: "title", label: "Title" },
                  { name: "phone", label: "Phone", type: "tel" }, { name: "email", label: "Email", type: "email" },
                  { name: "isPrimary", label: "Primary contact", type: "checkbox" },
                ]} /></div>
              </details>
            ) : null}
          </Panel>
          <Panel>
            <PanelHeader title="Vendor portal users" description="They see only work orders assigned to this company." />
            {d.appUsers.length === 0 && d.pendingInvites.length === 0 ? <EmptyState title="No users yet" /> : (
              <ul className="divide-y divide-border">
                {d.appUsers.map((u) => <li key={u.membershipId} className="px-4 py-2 text-sm">{u.name} <span className="text-xs text-faint">{u.email}</span> {u.status !== "active" ? <Badge>Deactivated</Badge> : null}</li>)}
                {d.pendingInvites.map((i) => <li key={i.id} className="px-4 py-2 text-sm">{i.email} <Badge tone="accent">Invited</Badge></li>)}
              </ul>
            )}
            {d.canManage ? (
              <div className="border-t border-border p-4">
                <SchemaForm action={inviteVendorUserAction.bind(null, orgSlug, id)} submitLabel="Send invite" resetOnSuccess fields={[{ name: "email", label: "Invite by email", type: "email" }]} />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
