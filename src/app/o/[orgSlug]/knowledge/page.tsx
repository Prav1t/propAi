import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canUseKnowledgeBase, kbStats, KB_FILTERS, listKnowledgeBase } from "@/server/kb/knowledge";
import { citationLabel, searchKnowledge } from "@/server/kb/retrieve";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { BRAND } from "@/config/brand";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { LinkTabs } from "@/components/ui/tabs";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/form";
import { DOCUMENT_AUDIENCE, DOCUMENT_CATEGORY, INDEX_STATUS, KNOWLEDGE_CATEGORY } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { reindexAction } from "./actions";

export const metadata = { title: "Knowledge base" };

type Filter = (typeof KB_FILTERS)[number];

export default async function KnowledgePage({ params, searchParams }: PageProps<"/o/[orgSlug]/knowledge">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseKnowledgeBase(principal)) notFound();
  const filter = (KB_FILTERS as readonly string[]).includes(sp(q.filter) ?? "") ? (sp(q.filter) as Filter) : "all";
  const test = sp(q.test)?.trim().slice(0, 300) || null;
  const [data, stats, props, trial] = await Promise.all([
    listKnowledgeBase(ctx, { q: sp(q.q), filter, propertyId: sp(q.property) }),
    kbStats(ctx),
    listPropertyOptions(ctx),
    test ? searchKnowledge(ctx, { query: test, limit: 6 }).catch(() => null) : Promise.resolve(null),
  ]);
  const base = `/o/${orgSlug}/knowledge`;
  const tz = principal.orgTimezone;
  const tab = (key: Filter) => `${base}${key === "all" ? "" : `?filter=${key}`}`;
  return (
    <>
      <PageHeader title="Knowledge base"
        description={`What ${BRAND.assistantName} answers rules and procedure questions from: your documents plus entries written here. Each person only ever gets passages they're allowed to read.`}
        actions={<div className="flex flex-wrap items-center gap-2">
          <LinkButton variant="secondary" href={`/o/${orgSlug}/documents/new`}>Upload document</LinkButton>
          <LinkButton href={`${base}/new`}>New entry</LinkButton>
        </div>} />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Sources" value={stats.sources.toLocaleString("en-CA")} sub={`${stats.indexed.toLocaleString("en-CA")} indexed${stats.pending ? ` · ${stats.pending} in progress` : ""}`} />
          <Stat label="Passages" value={stats.passages.toLocaleString("en-CA")} sub="The pieces answers are cited from" />
          <Stat label="Need attention" value={(stats.problems + stats.stale).toLocaleString("en-CA")} sub={stats.stale ? `${stats.stale} indexed with an older model` : "Unreadable, failed or empty sources"} />
          <Stat label="Search model" value={<span className="font-mono text-base">{stats.model}</span>} sub={stats.demo ? `Local demo embedder — ${stats.reason ?? "no key set"}. Keyword search does most of the work.` : "Meaning-based search plus keywords"} />
        </div>

        <Panel>
          <PanelHeader title="Try a question" description="See which passages the assistant would get for a question, as you. Residents only ever get passages for their audience and their home." />
          <form method="get" className="flex flex-wrap gap-2 p-4">
            <label htmlFor="kb-test" className="sr-only">Question</label>
            <Input id="kb-test" name="test" defaultValue={test ?? ""} placeholder="What are the rules for booking the party room?" className="min-w-0 flex-1" maxLength={300} />
            <button type="submit" className="h-9 rounded-[var(--radius-md)] bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90">Search</button>
          </form>
          {test ? (
            trial && trial.passages.length ? (
              <ol aria-label="Passages found" className="divide-y divide-border border-t border-border">
                {trial.passages.map((p, i) => (
                  <li key={p.chunkId} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={p.href} className="text-sm font-medium text-accent hover:underline">[{i + 1}] {citationLabel(p)}</Link>
                      <span className="text-[11px] tabular-nums text-faint">
                        {p.similarity !== null ? `meaning ${p.similarity.toFixed(2)} · ` : ""}{p.matchedTerms} of {trial.terms.length} words{p.audience === "staff" ? " · staff only" : p.audience === "owners" ? " · owners" : ""}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-4 whitespace-pre-line text-[13px] text-muted">{p.content}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="border-t border-border px-4 py-3 text-[13px] text-muted">Nothing you can access covers that — the assistant would say so instead of guessing.</p>
          ) : null}
        </Panel>

        <Panel>
          <LinkTabs active={filter} tabs={[
            { key: "all", label: "All sources", href: tab("all") },
            { key: "entries", label: "Entries", href: tab("entries") },
            { key: "documents", label: "Documents", href: tab("documents") },
            { key: "needs_attention", label: "Needs attention", href: tab("needs_attention"), count: stats.problems + stats.stale || null },
          ]} />
          <FilterBar searchPlaceholder="Search titles…" filters={props.length > 1 ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []} />
          {data.rows.length === 0 ? (
            <EmptyState title={filter === "needs_attention" ? "Everything is indexed" : "Nothing here yet"}>
              {filter === "needs_attention" ? null : "Write an entry — house rules, procedures, who to call — or upload a document."}
            </EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Source</Th><Th className="hidden md:table-cell">Applies to</Th><Th className="hidden lg:table-cell">Audience</Th><Th>Assistant index</Th><Th className="hidden sm:table-cell">Updated</Th></tr></thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = r.index ? INDEX_STATUS[r.index.status] ?? { label: r.index.status, tone: "neutral" as const } : null;
                  return (
                    <tr key={`${r.type}-${r.id}`}>
                      <Td>
                        <Link href={r.href} className="font-medium hover:underline">{r.title}</Link>
                        <span className="block text-xs text-faint">{r.type === "knowledge" ? "Entry" : "Document"} · {(r.type === "knowledge" ? KNOWLEDGE_CATEGORY : DOCUMENT_CATEGORY)[r.category] ?? r.category} · v{r.version}{r.status === "disabled" ? " · disabled" : ""}</span>
                      </Td>
                      <Td className="hidden text-[13px] md:table-cell">{r.propertyName ?? "All properties"}</Td>
                      <Td className="hidden text-[13px] lg:table-cell">{DOCUMENT_AUDIENCE[r.audience] ?? r.audience}</Td>
                      <Td>
                        {st ? <Badge tone={r.index!.stale ? "warning" : st.tone}>{r.index!.stale ? "Older model" : st.label}</Badge> : <Badge>Not indexed</Badge>}
                        {r.index ? <span className="mt-0.5 block text-xs text-faint">{r.index.status === "indexed" ? `${r.index.chunkCount} passage${r.index.chunkCount === 1 ? "" : "s"}` : r.index.error ? <span className="line-clamp-2 max-w-64">{r.index.error}</span> : null}</span> : null}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-[13px] text-muted sm:table-cell">{fmtDateTime(r.updatedAt, tz)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {data.truncated ? <p className="border-t border-border px-4 py-2 text-xs text-faint">Showing the 300 most recently updated of each kind. Search or filter to narrow it down.</p> : null}
        </Panel>

        <Panel>
          <PanelHeader title="Re-index" description="Rebuild every passage you manage — after changing the search model, or if something looks out of date. It runs in the background." />
          <div className="p-4">
            <ConfirmAction action={reindexAction.bind(null, orgSlug, { all: true })} label="Re-index everything…" confirmLabel="Re-index" variant="secondary"
              description="Every document and entry you manage is queued for indexing. Answers keep working from the current passages until each source is done." />
          </div>
        </Panel>
      </div>
    </>
  );
}
