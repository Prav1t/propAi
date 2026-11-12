import { after } from "next/server";
import { handleApiRequest } from "@/server/api/v1/handler";
import { requestMeta } from "@/server/request-meta";
import { afterChange } from "@/server/after-change";
import { env } from "@/server/env";
import { count, observe } from "@/server/ops/metrics";

export const dynamic = "force-dynamic";

// REST API v1 (Iteration 10): bearer API keys only — no cookies, so no CSRF surface. See src/server/api/v1/handler.ts.
async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const started = performance.now();
  const { response, write } = await handleApiRequest(req, path, await requestMeta(), env().APP_URL);
  // totals by method and status class only: paths carry record ids
  const labels = { method: req.method, status: `${Math.floor(response.status / 100)}xx` };
  count("app_api_requests_total", labels);
  observe("app_api_request_duration_seconds", (performance.now() - started) / 1000, { method: req.method });
  // like a change made in the app: notifications, automation rules and webhooks follow the response
  if (write && response.status < 400) after(() => afterChange());
  return response;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
