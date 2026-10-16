import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { availableReports } from "@/server/analytics/reports";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { REPORT_LABEL } from "@/lib/automation";

export const metadata = { title: "Reports" };

const ABOUT: Record<string, string> = {
  maintenance: "Every request created in the period, with response, completion and SLA outcome.", sla: "Targets met, by property.", vendors: "Vendor scorecard: jobs, speed and on-time rate.",
  complaints: "Complaints submitted.", incidents: "Incidents that occurred.", inspections: "Inspections completed and failed items.", amenities: "Bookings and utilisation per amenity.",
  packages: "Packages received and picked up, by property.", workload: "Open, overdue and completed work per staff member.", health: "Health score and factors, by property.",
};

export default async function ReportsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/analytics/reports">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx } = await getOrgContext(orgSlug);
  const reports = availableReports(ctx);
  if (!reports.length) notFound();
  const keep = new URLSearchParams(Object.entries(q).filter(([k, v]) => ["period", "property"].includes(k) && typeof v === "string") as [string, string][]);
  return (
    <>
      <PageHeader title="Reports" description="Tables built from recorded data for a period. Open one to filter, print or download it as CSV." />
      <Panel>
        <ul className="divide-y divide-border">
          {reports.map((r) => (
            <li key={r} className="px-4 py-3">
              <Link href={`/o/${orgSlug}/analytics/reports/${r}${keep.size ? `?${keep}` : ""}`} className="text-sm font-medium text-accent hover:underline">{REPORT_LABEL[r]}</Link>
              <p className="text-[13px] text-muted">{ABOUT[r]}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
