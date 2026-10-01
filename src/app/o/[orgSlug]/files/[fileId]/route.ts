import { getSession } from "@/server/auth/session";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { openFile } from "@/server/files/service";
import { requestMeta } from "@/server/request-meta";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";

export const dynamic = "force-dynamic";

// permission-checked download; storage URLs are never exposed directly
export async function GET(_req: Request, ctx: RouteContext<"/o/[orgSlug]/files/[fileId]">) {
  const { orgSlug, fileId } = await ctx.params;
  const session = await getSession();
  if (!session) return new Response("Not found", { status: 404 });
  const principal = await loadPrincipal(session.user.id, orgSlug);
  if (!principal || !/^[0-9a-f-]{36}$/i.test(fileId)) return new Response("Not found", { status: 404 });
  try {
    const r = await openFile({ principal, meta: await requestMeta() }, fileId);
    if (r.kind === "redirect") return Response.redirect(r.url, 302);
    const name = r.file.filename.replace(/["\\\r\n]/g, "_");
    return new Response(Buffer.from(r.bytes), {
      headers: {
        "Content-Type": r.file.contentType,
        "Content-Length": String(r.bytes.length),
        "Content-Disposition": `${r.inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(r.file.filename)}`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
