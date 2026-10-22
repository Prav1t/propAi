import { getSession } from "@/server/auth/session";
import { orgPrincipalForSession } from "@/server/org-session";
import { openExport } from "@/server/privacy/service";
import { requestMeta } from "@/server/request-meta";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";

export const dynamic = "force-dynamic";

// a personal data export (privacy managers only, for 7 days; every download is audited)
export async function GET(_req: Request, ctx: RouteContext<"/o/[orgSlug]/settings/privacy/exports/[requestId]">) {
  const { orgSlug, requestId } = await ctx.params;
  const session = await getSession();
  if (!session || !/^[0-9a-f-]{36}$/i.test(requestId)) return new Response("Not found", { status: 404 });
  const { principal, decision } = await orgPrincipalForSession(session, orgSlug);
  if (!principal || !decision.ok) return new Response("Not found", { status: 404 });
  try {
    const { bytes, filename } = await openExport({ principal, meta: await requestMeta() }, requestId);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
