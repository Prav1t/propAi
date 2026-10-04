import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canUseMessages, messageableResidents } from "@/server/modules/messaging/service";
import { residentUnitsForRequests } from "@/server/modules/maintenance/service";
import { THREAD_CATEGORIES } from "@/server/db/schema";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { THREAD_CATEGORY } from "@/lib/community-labels";
import { startThreadAction } from "../../community-actions";

export const metadata = { title: "New message" };

export default async function NewMessagePage({ params, searchParams }: PageProps<"/o/[orgSlug]/messages/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseMessages(principal)) notFound();
  const staff = principal.permissions.has("message.manage");
  const base = `/o/${orgSlug}/messages`;
  const categories = THREAD_CATEGORIES.map((c) => ({ value: c, label: THREAD_CATEGORY[c] }));
  if (!staff) {
    const units = await residentUnitsForRequests(ctx);
    return (
      <>
        <Breadcrumbs items={[{ label: "Messages", href: base }, { label: "New" }]} />
        <PageHeader title="Message management" description="For repairs, use “Report a problem” so the request is tracked." />
        <Panel className="max-w-2xl p-4 sm:p-6">
          {units.length === 0 ? <EmptyState title="Your account isn't linked to a unit yet" /> : (
            <SchemaForm action={startThreadAction.bind(null, orgSlug)} submitLabel="Send" hidden={units.length === 1 ? { unitId: units[0].id } : undefined} fields={[
              ...(units.length > 1 ? [{ name: "unitId", label: "About unit", type: "select" as const, options: units.map((u) => ({ value: u.id, label: `Unit ${u.number} · ${u.building}` })) }] : []),
              { name: "subject", label: "Subject", autoFocus: true, maxLength: 140 },
              { name: "category", label: "Topic", type: "select", options: categories },
              { name: "body", label: "Message", type: "textarea", rows: 6, maxLength: 5000 },
            ]} />
          )}
        </Panel>
      </>
    );
  }
  const residentId = sp(q.residentId);
  const found = await messageableResidents(ctx, sp(q.q));
  const chosen = residentId ? found.find((r) => r.id === residentId) ?? (await messageableResidents(ctx)).find((r) => r.id === residentId) : null;
  return (
    <>
      <Breadcrumbs items={[{ label: "Resident messages", href: base }, { label: "New" }]} />
      <PageHeader title="Message a resident" description="Only residents who use the app can receive in-app messages." />
      <Panel className="max-w-2xl p-4 sm:p-6">
        {chosen ? (
          <>
            <p className="mb-4 text-sm">To <span className="font-medium">{chosen.first} {chosen.last}</span> <span className="text-muted">· Unit {chosen.unit}, {chosen.building}</span> <Link className="ml-2 text-[13px] text-accent hover:underline" href={`${base}/new`}>Change</Link></p>
            <SchemaForm action={startThreadAction.bind(null, orgSlug)} submitLabel="Send" hidden={{ residentId: chosen.id }} fields={[
              { name: "subject", label: "Subject", autoFocus: true, maxLength: 140 },
              { name: "category", label: "Topic", type: "select", options: categories },
              { name: "body", label: "Message", type: "textarea", rows: 6, maxLength: 5000 },
            ]} />
          </>
        ) : (
          <>
            <form action={`${base}/new`} className="mb-4 flex gap-2">
              <label htmlFor="who" className="sr-only">Find a resident</label>
              <input id="who" name="q" defaultValue={sp(q.q)} placeholder="Name or unit number" className="h-9 flex-1 rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 text-sm" />
              <button className="h-9 rounded-[var(--radius-md)] border border-border-strong px-3 text-sm hover:bg-subtle">Search</button>
            </form>
            {found.length === 0 ? <EmptyState title="No residents with app accounts match" /> : (
              <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border">
                {found.map((r) => <li key={`${r.id}-${r.unit}`}><Link href={`${base}/new?residentId=${r.id}`} className="flex justify-between px-3 py-2 text-sm hover:bg-subtle"><span>{r.first} {r.last}</span><span className="text-muted">Unit {r.unit} · {r.building}</span></Link></li>)}
              </ul>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
