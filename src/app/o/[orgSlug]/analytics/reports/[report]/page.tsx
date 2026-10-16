import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { analyticsFilters } from "@/server/analytics/page-filters";
import { availableReports, buildReport, isReportKey, type Cell, type Column } from "@/server/analytics/reports";
import { fmtValue } from "@/server/analytics/metrics";
import { EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { PrintButton } from "@/components/analytics/print-button";
import { fmtDateTime } from "@/lib/time";

export const metadata = { title: "Report" };

const RECORD_PATH: Record<string, string> = { maintenance: "maintenance", complaints: "complaints", incidents: "incidents", inspections: "inspections", vendors: "vendors", health: "analytics/health" };
const SHOWN = 300;

function cell(c: Column, v: Cell, tz: string) {
  if (v === null || v === undefined || v === "") return "—";
  if (c.unit === "datetime" && typeof v === "string") return fmtDateTime(new Date(v), tz);
  if (c.unit && c.unit !== "text" && c.unit !== "date" && c.unit !== "datetime" && typeof v === "number") return fmtValue(v, c.unit);
  return String(v);
}

export default async function ReportPage({ params, searchParams }: PageProps<"/o/[orgSlug]/analytics/reports/[report]">) {
  const { orgSlug, report } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!isReportKey(report) || !availableReports(ctx).includes(report)) notFound();
  const f = await analyticsFilters(ctx, await searchParams);
  const r = await orNotFound(buildReport(ctx, report, f.period, { propertyId: f.propertyId }));
  const base = `/o/${orgSlug}`;
  const numeric = (c: Column) => !!c.unit && !["text", "date", "datetime"].includes(c.unit);
  const linkCol = r.columns[0].key;
  return (
    <>
      <PageHeader
        title={r.title}
        description={<>{r.description} {f.period.label} ({f.period.fromDate} to {f.period.toDate}). <Link href={`${base}/analytics/reports`} className="text-accent hover:underline">All reports</Link></>}
        actions={<div className="flex gap-2" data-print-hide>
          <LinkButton href={`${base}/analytics/reports/${report}/csv${f.query()}`} size="sm" prefetch={false}>Download CSV</LinkButton>
          <PrintButton />
        </div>}
      />
      <div data-print-hide><Panel className="mb-4">
        <FilterBar search={false} filters={[
          { name: "period", label: "Period", allLabel: "Last 30 days", options: f.periodOptions.filter((o) => o.value !== "30d") },
          ...(f.properties.length > 1 ? [{ name: "property", label: "Property", allLabel: "all", options: f.properties.map((p) => ({ value: p.id, label: p.name })) }] : []),
        ]} />
      </Panel></div>
      <Panel>
        {r.rows.length === 0 ? <EmptyState title="Nothing in this period">Try a longer period.</EmptyState> : (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{r.title}, {f.period.label}</caption>
              <thead><tr>{r.columns.map((c) => <Th key={c.key} className={numeric(c) ? "text-right" : undefined}>{c.label}</Th>)}</tr></thead>
              <tbody>
                {r.rows.slice(0, SHOWN).map((row, i) => (
                  <tr key={String(row.id ?? i)}>
                    {r.columns.map((c) => (
                      <Td key={c.key} className={numeric(c) ? "text-right tabular-nums" : "whitespace-nowrap"}>
                        {c.key === linkCol && row.id && RECORD_PATH[report] ? <Link href={`${base}/${RECORD_PATH[report]}/${row.id}`} className="font-medium hover:underline">{cell(c, row[c.key], principal.orgTimezone)}</Link> : cell(c, row[c.key], principal.orgTimezone)}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {r.rows.length > SHOWN || r.truncated ? <p className="border-t border-border px-4 py-2 text-[12px] text-muted">Showing the first {SHOWN} of {r.rows.length}{r.truncated ? "+" : ""} rows. The CSV has {r.truncated ? "the first 5,000" : "all of them"}.</p> : null}
      </Panel>
    </>
  );
}
