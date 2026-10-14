import { getOrgContext, orNotFound } from "@/server/org-context";
import { getDocument } from "@/server/modules/documents/service";
import { DOCUMENT_CATEGORIES } from "@/server/db/schema";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { LinkButton } from "@/components/ui/button";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DOCUMENT_AUDIENCE, DOCUMENT_CATEGORY, fileSize } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { addVersionAction, archiveDocumentAction, updateDocumentAction } from "../../community-actions";
import { documentIndexInfo } from "@/server/kb/knowledge";
import { reindexAction } from "../../knowledge/actions";
import { INDEX_STATUS } from "@/lib/community-labels";

export const metadata = { title: "Document" };

export default async function DocumentPage({ params }: PageProps<"/o/[orgSlug]/documents/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getDocument(ctx, id));
  const doc = d.document;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  const current = d.versions.find((v) => v.v.version === doc.currentVersion);
  const index = d.canManage ? await documentIndexInfo(ctx, id) : null;
  const st = index ? INDEX_STATUS[index.status] : null;
  return (
    <>
      <Breadcrumbs items={[{ label: "Documents", href: `${base}/documents` }, { label: doc.title }]} />
      <PageHeader title={doc.title} description={`${DOCUMENT_CATEGORY[doc.category]} · ${d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}, ${d.labels.buildingName}` : d.labels?.buildingName ? `${d.labels.buildingName}, ${d.labels.propertyName}` : d.labels?.propertyName ?? "All properties"}`}
        actions={<div className="flex items-center gap-2">
          {doc.status === "archived" ? <Badge>Archived</Badge> : null}
          {current ? <LinkButton href={`${base}/files/${current.file.id}`}>Download {(current.file.filename.split(".").pop() ?? "").toUpperCase()}</LinkButton> : null}
        </div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="About" />
            {doc.description ? <p className="whitespace-pre-line px-4 py-3 text-sm">{doc.description}</p> : null}
            <DetailList items={[
              ["Audience", d.canManage || principal.role.category === "staff" ? DOCUMENT_AUDIENCE[doc.audience] : null],
              ["Current file", current ? `${current.file.filename} · ${fileSize(current.file.sizeBytes)}` : null],
              ["Updated", fmtDateTime(doc.updatedAt, tz)],
            ]} />
          </Panel>
          {d.versions.length > 1 || d.canManage ? (
            <Panel>
              <PanelHeader title="Versions" description={d.canManage ? "Residents only ever see the current version." : undefined} />
              <ul className="divide-y divide-border">
                {d.versions.map(({ v, file, uploader }) => (
                  <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                    <span><span className="font-medium">Version {v.version}</span>{v.version === doc.currentVersion ? <Badge tone="success" className="ml-2">Current</Badge> : null}
                      <span className="block text-xs text-faint">{[fmtDateTime(v.createdAt, tz), uploader, v.notes].filter(Boolean).join(" · ")}</span></span>
                    <a className="text-accent hover:underline" href={`${base}/files/${file.id}`}>{file.filename} · {fileSize(file.sizeBytes)}</a>
                  </li>
                ))}
              </ul>
              {d.canManage && doc.status === "active" ? (
                <details className="border-t border-border">
                  <summary className="cursor-pointer px-4 py-3 text-[13px] text-accent">Upload a new version</summary>
                  <div className="px-4 pb-4"><SchemaForm action={addVersionAction.bind(null, orgSlug, id)} submitLabel="Upload version" pendingLabel="Uploading…" resetOnSuccess fields={[
                    { name: "files", label: "File", type: "file", accept: ".pdf,.docx,.xlsx,.pptx,.txt,.csv,.jpg,.jpeg,.png" },
                    { name: "notes", label: "What changed?" },
                  ]} /></div>
                </details>
              ) : null}
            </Panel>
          ) : null}
        </div>
        {d.canManage ? (
          <div className="space-y-6">
            <Panel>
              <PanelHeader title="Assistant index" description="The assistant answers questions from the current version's text, citing this document." />
              <div className="space-y-3 p-4 text-[13px]">
                <p className="flex flex-wrap items-center gap-2">
                  {st ? <Badge tone={index!.stale ? "warning" : st.tone}>{index!.stale ? "Indexed with an older model" : st.label}</Badge> : <Badge>Not indexed</Badge>}
                  {index?.status === "indexed" ? <span className="text-muted">{index.chunkCount} passage{index.chunkCount === 1 ? "" : "s"} · version {index.indexedVersion}</span> : null}
                </p>
                {index?.error ? <p className="text-danger">{index.error}</p> : null}
                {principal.permissions.has("knowledge.manage") ? <ConfirmAction action={reindexAction.bind(null, orgSlug, { documentId: id })} label="Re-index" confirmLabel="Re-index now" variant="secondary" /> : null}
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Edit" />
              <div className="p-4">
                <SchemaForm action={updateDocumentAction.bind(null, orgSlug, id)} submitLabel="Save" fields={[
                  { name: "title", label: "Title", defaultValue: doc.title },
                  { name: "category", label: "Category", type: "select", defaultValue: doc.category, options: DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_CATEGORY[c] })) },
                  { name: "audience", label: "Who can see it", type: "select", defaultValue: doc.audience, options: Object.entries(DOCUMENT_AUDIENCE).map(([value, label]) => ({ value, label })) },
                  { name: "important", label: "Important", type: "checkbox", defaultValue: doc.important },
                  { name: "description", label: "Description", type: "textarea", rows: 3, defaultValue: doc.description ?? "" },
                ]} />
              </div>
              <div className="border-t border-border p-4">
                {doc.status === "active"
                  ? <ConfirmAction action={archiveDocumentAction.bind(null, orgSlug, id, true)} label="Archive…" confirmLabel="Archive" description="Residents will no longer see it. Staff can restore it." />
                  : <ConfirmAction action={archiveDocumentAction.bind(null, orgSlug, id, false)} label="Restore" confirmLabel="Restore" variant="secondary" />}
              </div>
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}
