import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canUseDocuments, listDocuments } from "@/server/modules/documents/service";
import { DOCUMENT_CATEGORIES } from "@/server/db/schema";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { DOCUMENT_AUDIENCE, DOCUMENT_CATEGORY, fileSize } from "@/lib/community-labels";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/documents">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseDocuments(principal)) notFound();
  const staff = principal.role.category === "staff";
  const view = staff && sp(q.view) === "archived" ? "archived" : "active";
  const data = await listDocuments(ctx, { q: sp(q.q), category: sp(q.category), propertyId: sp(q.property), view, page: Number(sp(q.page)) || 1 });
  const props = staff ? await listPropertyOptions(ctx) : [];
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title="Documents" description={staff ? "Bylaws, rules, notices, manuals and unit documents — each shown only to its audience." : "Rules, bylaws, notices and documents for your home."}
        actions={principal.permissions.has("document.manage") ? <LinkButton href={`${base}/documents/new`}>Upload document</LinkButton> : null} />
      <Panel>
        {staff ? <LinkTabs active={view} tabs={[{ key: "active", label: "Current", href: `${base}/documents` }, { key: "archived", label: "Archived", href: `${base}/documents?view=archived` }]} /> : null}
        <FilterBar searchPlaceholder="Search titles and descriptions…" filters={[
          { name: "category", label: "Category", options: DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_CATEGORY[c] })) },
          ...(props.length > 1 ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []),
        ]} />
        {data.rows.length === 0 ? <EmptyState title="No documents found" /> : (
          <Table>
            <thead><tr><Th>Document</Th><Th className="hidden md:table-cell">Applies to</Th>{staff ? <Th className="hidden lg:table-cell">Audience</Th> : null}<Th className="text-right">File</Th></tr></thead>
            <tbody>
              {data.rows.map((d) => (
                <tr key={d.id} className="hover:bg-subtle/60">
                  <Td>
                    <Link className="font-medium hover:underline" href={`${base}/documents/${d.id}`}>{d.title}</Link>
                    {d.important ? <Badge tone="accent" className="ml-2">Important</Badge> : null}
                    <div className="text-xs text-faint">{DOCUMENT_CATEGORY[d.category]}{d.currentVersion > 1 ? ` · version ${d.currentVersion}` : ""}</div>
                  </Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{d.unitNumber ? `Unit ${d.unitNumber}, ${d.buildingName}` : d.buildingName ? `${d.buildingName}, ${d.propertyName}` : d.propertyName ?? "All properties"}</Td>
                  {staff ? <Td className="hidden lg:table-cell"><Badge tone={d.audience === "staff" ? "warning" : "neutral"}>{DOCUMENT_AUDIENCE[d.audience]}</Badge></Td> : null}
                  <Td className="text-right">{d.fileId ? <a className="text-[13px] text-accent hover:underline" href={`${base}/files/${d.fileId}`}>{(d.filename?.split(".").pop() ?? "file").toUpperCase()} · {fileSize(d.sizeBytes ?? 0)}</a> : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/documents`} params={q} />
      </Panel>
    </>
  );
}
