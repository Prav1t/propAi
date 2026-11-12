import { log } from "@/server/log";
import { rateLimiter } from "@/server/auth/rate-limit";
import { requestMeta } from "@/server/request-meta";

export const dynamic = "force-dynamic";

const clip = (v: unknown, n = 200) => (typeof v === "string" ? v.split("?")[0].slice(0, n) : undefined);

// Content-Security-Policy violation reports from browsers (report-uri and the Reporting API). Logged as one line each,
// without query strings; limited per address so the endpoint can't be used to flood the log.
export async function POST(req: Request) {
  const { ip } = await requestMeta();
  if (!(await rateLimiter().hit(`csp:${ip ?? "unknown"}`, 30, 60_000)).allowed) return new Response(null, { status: 204 });
  try {
    const text = (await req.text()).slice(0, 8_000);
    const body = JSON.parse(text);
    const reports: Record<string, unknown>[] = Array.isArray(body) ? body.map((b) => b?.body ?? b) : [body?.["csp-report"] ?? body];
    for (const r of reports.slice(0, 5)) {
      log.warn("csp.violation", {
        directive: clip(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"], 80),
        blocked: clip(r["blocked-uri"] ?? r.blockedURL), document: clip(r["document-uri"] ?? r.documentURL),
        source: clip(r["source-file"] ?? r.sourceFile), line: Number(r["line-number"] ?? r.lineNumber) || undefined,
      });
    }
  } catch { /* not a report */ }
  return new Response(null, { status: 204 });
}
