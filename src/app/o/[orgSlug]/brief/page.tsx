import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { buildBrief, canGetBrief } from "@/server/analytics/brief";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Daily brief" };

const DOT = { danger: "bg-danger", warning: "bg-warning", accent: "bg-accent", neutral: "bg-border-strong" };

export default async function BriefPage({ params }: PageProps<"/o/[orgSlug]/brief">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canGetBrief(ctx)) notFound();
  const b = await buildBrief(ctx);
  const base = `/o/${orgSlug}`;
  const when = new Date(b.generatedAt).toLocaleString("en-CA", { timeZone: principal.orgTimezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <>
      <PageHeader title="Daily brief" description={`As of ${when} · ${b.summary}`} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {b.headline.map((h) => (
          <Link key={h.key} href={`${base}${h.href}`} className="block rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3 hover:border-border-strong">
            <p className="text-[12px] text-muted">{h.label}</p>
            <p className={cn("mt-1 text-xl font-semibold tabular-nums", h.tone === "danger" && "text-danger", h.tone === "warning" && "text-warning")}>{h.value}</p>
          </Link>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {b.sections.map((s) => (
          <Panel key={s.key}>
            <PanelHeader title={s.title} />
            {s.items.length === 0 ? <p className="px-4 py-4 text-[13px] text-faint">{s.empty}</p> : (
              <ul className="divide-y divide-border">
                {s.items.map((it, i) => (
                  <li key={i} className="flex items-start gap-2 px-4 py-2.5 text-[13px]">
                    <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[it.tone ?? "neutral"])} />
                    {it.href ? <Link href={`${base}${it.href}`} className="hover:underline">{it.text}</Link> : <span>{it.text}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ))}
        <Panel className="lg:col-span-2">
          <PanelHeader title="Patterns worth a look" description="Found in recorded data; each links to the records behind it." />
          {b.insights.length === 0 ? <EmptyState title="Nothing unusual">No spikes, repeat failures or vendors missing targets right now.</EmptyState> : (
            <ul className="divide-y divide-border">
              {b.insights.map((i) => (
                <li key={i.key} className="px-4 py-2.5">
                  <Link href={`${base}${i.href}`} className="text-[13px] font-medium hover:underline">{i.title}</Link>
                  <p className="text-[12px] text-muted">{i.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
