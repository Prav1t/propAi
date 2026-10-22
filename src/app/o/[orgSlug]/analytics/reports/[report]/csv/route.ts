import { getSession } from "@/server/auth/session";
import { orgPrincipalForSession } from "@/server/org-session";
import { requestMeta } from "@/server/request-meta";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { availableReports, exportReportCsv, isReportKey } from "@/server/analytics/reports";
import { analyticsFilters } from "@/server/analytics/page-filters";

export const dynamic = "force-dynamic";

// the same report as the page, as CSV (formula-safe cells); every export is audited
export async function GET(req: Request, ctx: RouteContext<"/o/[orgSlug]/analytics/reports/[report]/csv">) {
  const { orgSlug, report } = await ctx.params;
  const session = await getSession();
  if (!session) return new Response("Not found", { status: 404 });
  const { principal, decision } = await orgPrincipalForSession(session, orgSlug);
  if (principal && !decision.ok) return new Response("This organization requires a different sign-in method.", { status: 403 });
  if (!principal || !isReportKey(report)) return new Response("Not found", { status: 404 });
  const tctx = { principal, meta: await requestMeta() };
  if (!availableReports(tctx).includes(report)) return new Response("Not found", { status: 404 });
  try {
    const f = await analyticsFilters(tctx, Object.fromEntries(new URL(req.url).searchParams));
    const { filename, csv } = await exportReportCsv(tctx, report, f.period, { propertyId: f.propertyId });
    return new Response(`﻿${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
