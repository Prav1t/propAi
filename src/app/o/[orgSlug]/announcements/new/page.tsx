import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { announcementFormOptions } from "@/server/modules/announcements/service";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createAnnouncementAction } from "../../community-actions";
import { announcementFields } from "../announcement-fields";

export const metadata = { title: "New announcement" };

export default async function NewAnnouncementPage({ params }: PageProps<"/o/[orgSlug]/announcements/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("announcement.manage")) notFound();
  const opts = await announcementFormOptions(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Announcements", href: `/o/${orgSlug}/announcements?view=published` }, { label: "New" }]} />
      <PageHeader title="New announcement" description={`Times are in ${principal.orgTimezone}.`} />
      <Panel className="max-w-3xl p-4 sm:p-6">
        {!opts.orgWide && !opts.properties.length ? <EmptyState title="No properties you can post to" /> : (
          <SchemaForm action={createAnnouncementAction.bind(null, orgSlug)} columns={2} submitLabel="Save announcement" fields={announcementFields(opts)} />
        )}
      </Panel>
    </>
  );
}
