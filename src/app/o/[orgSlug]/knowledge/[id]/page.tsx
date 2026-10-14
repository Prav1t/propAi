import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getEntry } from "@/server/kb/knowledge";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { LinkButton } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { FormAlert } from "@/components/ui/form";
import { MarkdownView } from "@/components/ai/markdown-view";
import { DOCUMENT_AUDIENCE, INDEX_STATUS, KNOWLEDGE_CATEGORY } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { reindexAction, setEntryStatusAction } from "../actions";

export const metadata = { title: "Knowledge entry" };

export default async function EntryPage({ params, searchParams }: PageProps<"/o/[orgSlug]/knowledge/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const asked = Number(sp(q.v)) || undefined;
  const d = await orNotFound(getEntry(ctx, id, { version: asked }));
  const e = d.entry;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}/knowledge`;
  const shown = d.shownVersion && d.shownVersion.version !== e.version ? d.shownVersion : null;
  const st = d.index ? INDEX_STATUS[d.index.status] : null;
  const place = d.labels?.buildingName ? `${d.labels.buildingName}, ${d.labels.propertyName}` : d.labels?.propertyName ?? "All properties";
  return (
    <>
      {d.canManage ? <Breadcrumbs items={[{ label: "Knowledge base", href: base }, { label: e.title }]} /> : null}
      <PageHeader title={e.title} description={`${KNOWLEDGE_CATEGORY[e.category] ?? e.category} · ${place}`}
        actions={d.canManage ? <div className="flex items-center gap-2">
          {e.status === "disabled" ? <Badge tone="warning">Disabled</Badge> : null}
          <LinkButton href={`${base}/${id}/edit`}>Edit</LinkButton>
        </div> : null} />
      {sp(q.created) ? <div className="mb-4"><FormAlert kind="success">Saved. It&apos;s being indexed — the assistant can use it in a moment.</FormAlert></div> : null}
      {sp(q.saved) ? <div className="mb-4"><FormAlert kind="success">Version {e.version} saved and queued for indexing.</FormAlert></div> : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title={shown ? `Version ${shown.version} (not current)` : "Content"}
              description={shown ? <Link href={`${base}/${id}`} className="text-accent hover:underline">Back to the current version</Link> : undefined} />
            <div className="px-4 py-4"><MarkdownView text={shown ? shown.body : e.body} /></div>
          </Panel>
          {d.canManage && d.passages.length ? (
            <Panel>
              <PanelHeader title={`Passages (${d.passages.length})`} description="How this entry is split for search. Answers cite the section heading of the passage they quote." />
              <ol className="divide-y divide-border">
                {d.passages.map((p) => (
                  <li key={p.ordinal} className="px-4 py-2.5 text-[13px]">
                    <span className="font-medium">{p.heading ?? "Introduction"}</span>
                    <span className="ml-2 text-[11px] text-faint">~{p.tokenCount} tokens{p.embedded ? "" : " · keyword search only"}</span>
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-muted">{p.content}</p>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="About" />
            <DetailList items={[
              ["Audience", principal.role.category === "staff" ? DOCUMENT_AUDIENCE[e.audience] : null],
              ["Version", String(e.version)],
              ["Updated", fmtDateTime(e.updatedAt, tz)],
            ]} />
          </Panel>
          {d.canManage ? (
            <Panel>
              <PanelHeader title="Assistant index" />
              <div className="space-y-3 p-4 text-[13px]">
                <p className="flex flex-wrap items-center gap-2">
                  {st ? <Badge tone={d.index!.stale ? "warning" : st.tone}>{d.index!.stale ? "Indexed with an older model" : st.label}</Badge> : <Badge>Not indexed</Badge>}
                  {d.index?.status === "indexed" ? <span className="text-muted">{d.index.chunkCount} passage{d.index.chunkCount === 1 ? "" : "s"} · version {d.index.indexedVersion}{d.index.indexedAt ? ` · ${fmtDateTime(d.index.indexedAt, tz)}` : ""}</span> : null}
                </p>
                {d.index?.error ? <p className="text-danger">{d.index.error}</p> : null}
                {e.status === "disabled" ? <p className="text-muted">Disabled entries are never used in answers.</p> : null}
                <ConfirmAction action={reindexAction.bind(null, orgSlug, { entryId: id })} label="Re-index" confirmLabel="Re-index now" variant="secondary" />
              </div>
              <div className="border-t border-border p-4">
                {e.status === "active"
                  ? <ConfirmAction action={setEntryStatusAction.bind(null, orgSlug, id, "disabled")} label="Disable…" confirmLabel="Disable" description="The assistant stops using it straight away. You can enable it again later." />
                  : <ConfirmAction action={setEntryStatusAction.bind(null, orgSlug, id, "active")} label="Enable" confirmLabel="Enable" variant="secondary" />}
              </div>
            </Panel>
          ) : null}
          {d.versions.length ? (
            <Panel>
              <PanelHeader title="Versions" />
              <ul className="divide-y divide-border">
                {d.versions.map((v) => (
                  <li key={v.version} className="px-4 py-2.5 text-[13px]">
                    <span className="flex items-center justify-between gap-2">
                      <Link href={v.version === e.version ? `${base}/${id}` : `${base}/${id}?v=${v.version}`} className="font-medium hover:underline">Version {v.version}</Link>
                      {v.version === e.version ? <Badge tone="success">Current</Badge> : null}
                    </span>
                    <span className="block text-xs text-faint">{[fmtDateTime(v.createdAt, tz), v.author, v.notes].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
