import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { MEETING_KIND } from "@/lib/governance";
import { createMeetingAction } from "../../governance-actions";

export const metadata = { title: "Schedule a meeting" };

export default async function NewMeetingPage({ params }: PageProps<"/o/[orgSlug]/meetings/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("meeting.manage")) notFound();
  const props = await listPropertyOptions(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Meetings", href: `/o/${orgSlug}/meetings` }, { label: "Schedule" }]} />
      <PageHeader title="Schedule a meeting" description={`Times are in ${principal.orgTimezone ?? "UTC"}.`} />
      <Panel className="max-w-2xl p-4 sm:p-6">
        <SchemaForm action={createMeetingAction.bind(null, orgSlug)} columns={2} submitLabel="Schedule meeting" fields={[
          { name: "title", label: "Title", span: 2, autoFocus: true, placeholder: "Council meeting, November" },
          { name: "propertyId", label: "Property", type: "select", defaultValue: props.length === 1 ? props[0].id : "", options: [...(props.length === 1 ? [] : [{ value: "", label: "Choose…" }]), ...props.map((p) => ({ value: p.id, label: p.name }))] },
          { name: "kind", label: "Kind of meeting", type: "select", defaultValue: "council", options: Object.entries(MEETING_KIND).map(([value, label]) => ({ value, label })) },
          { name: "scheduledAt", label: "Date and time", type: "datetime-local" },
          { name: "location", label: "Where (optional)", placeholder: "Amenity room, or a video link" },
          { name: "agenda", label: "Agenda (one item per line)", type: "textarea", span: 2, rows: 6, hint: "You can add items, motions and minutes afterwards." },
        ]} />
      </Panel>
    </>
  );
}
