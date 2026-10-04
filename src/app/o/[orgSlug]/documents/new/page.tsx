import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { documentFormOptions } from "@/server/modules/documents/service";
import { DOCUMENT_CATEGORIES } from "@/server/db/schema";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { DOCUMENT_AUDIENCE, DOCUMENT_CATEGORY } from "@/lib/community-labels";
import { createDocumentAction } from "../../community-actions";

export const metadata = { title: "Upload document" };

const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.csv,.jpg,.jpeg,.png";

export default async function NewDocumentPage({ params }: PageProps<"/o/[orgSlug]/documents/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("document.manage")) notFound();
  const o = await documentFormOptions(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Documents", href: `/o/${orgSlug}/documents` }, { label: "Upload" }]} />
      <PageHeader title="Upload document" description="PDF, Word, Excel, PowerPoint, text, CSV or images. Files are checked by content, not by name." />
      <Panel className="max-w-3xl p-4 sm:p-6">
        {!o.orgWide && !o.properties.length ? <EmptyState title="No properties you can upload to" /> : (
          <SchemaForm action={createDocumentAction.bind(null, orgSlug)} columns={2} submitLabel="Upload" pendingLabel="Uploading…" fields={[
            { name: "files", label: "File", type: "file", accept: ACCEPT, span: 2 },
            { name: "title", label: "Title", span: 2, placeholder: "Strata bylaws (2024 consolidated)" },
            { name: "category", label: "Category", type: "select", options: DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_CATEGORY[c] })) },
            { name: "audience", label: "Who can see it", type: "select", defaultValue: "residents", options: Object.entries(DOCUMENT_AUDIENCE).map(([value, label]) => ({ value, label })) },
            { name: "propertyId", label: "Property", type: "select", defaultValue: o.orgWide ? "" : o.properties[0]?.id, options: [...(o.orgWide ? [{ value: "", label: "All properties" }] : []), ...o.properties.map((p) => ({ value: p.id, label: p.name }))] },
            { name: "buildingId", label: "Building (optional)", type: "select", options: [{ value: "", label: "Whole property" }, ...o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
            { name: "unitNumber", label: "Unit (optional)", placeholder: "For a unit's lease or notices", hint: "Only that unit's residents (and staff) will see it." },
            { name: "important", label: "Mark as important (shown on residents' home screen)", type: "checkbox" },
            { name: "description", label: "Description (optional)", type: "textarea", span: 2, rows: 3 },
            { name: "notes", label: "Version note (optional)", span: 2, placeholder: "Adopted at the AGM, March 2026" },
          ]} />
        )}
      </Panel>
    </>
  );
}
