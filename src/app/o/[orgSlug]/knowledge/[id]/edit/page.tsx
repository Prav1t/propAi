import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getEntry, knowledgeFormOptions } from "@/server/kb/knowledge";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { updateEntryAction } from "../../actions";
import { entryFields } from "../../entry-fields";

export const metadata = { title: "Edit knowledge entry" };

export default async function EditEntryPage({ params }: PageProps<"/o/[orgSlug]/knowledge/[id]/edit">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getEntry(ctx, id));
  if (!d.canManage) notFound();
  const o = await knowledgeFormOptions(ctx);
  const e = d.entry;
  return (
    <>
      <Breadcrumbs items={[{ label: "Knowledge base", href: `/o/${orgSlug}/knowledge` }, { label: e.title, href: `/o/${orgSlug}/knowledge/${id}` }, { label: "Edit" }]} />
      <PageHeader title={`Edit “${e.title}”`} description={`Saving creates version ${e.version + 1}. The assistant switches to it once it's indexed; earlier versions stay in the history.`} />
      <Panel className="max-w-3xl p-4 sm:p-6">
        <SchemaForm action={updateEntryAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save new version" pendingLabel="Saving…"
          fields={entryFields(o, { title: e.title, body: e.body, category: e.category, audience: e.audience, propertyId: e.propertyId, buildingId: e.buildingId }, true)} />
      </Panel>
    </>
  );
}
