import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { canUseKnowledgeBase, knowledgeFormOptions } from "@/server/kb/knowledge";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createEntryAction } from "../actions";
import { entryFields } from "../entry-fields";

export const metadata = { title: "New knowledge entry" };

export default async function NewEntryPage({ params }: PageProps<"/o/[orgSlug]/knowledge/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseKnowledgeBase(principal)) notFound();
  const o = await knowledgeFormOptions(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Knowledge base", href: `/o/${orgSlug}/knowledge` }, { label: "New entry" }]} />
      <PageHeader title="New knowledge entry" description="Teach the assistant something in your own words — building rules, procedures, who to call. It's indexed as soon as you save." />
      <Panel className="max-w-3xl p-4 sm:p-6">
        {!o.orgWide && !o.properties.length ? <EmptyState title="No properties you can add knowledge for" /> : (
          <SchemaForm action={createEntryAction.bind(null, orgSlug)} columns={2} submitLabel="Save entry" pendingLabel="Saving…" fields={entryFields(o)} />
        )}
      </Panel>
    </>
  );
}
