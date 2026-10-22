import { z } from "zod";
import { getSession } from "@/server/auth/session";
import { orgPrincipalForSession } from "@/server/org-session";
import { requestMeta } from "@/server/request-meta";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError } from "@/server/modules/context";
import { runAssistantTurn, type AssistantEvent } from "@/server/ai/orchestrator";
import { isSameOrigin, jsonError } from "@/server/http";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

const body = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().max(4000),
  mode: z.string().max(20).nullish(),
});

// streams one assistant turn as newline-delimited JSON events (start, status, tool_start/tool_end, text, plan, notice/error, done)
export async function POST(req: Request, ctx: RouteContext<"/o/[orgSlug]/assistant/stream">) {
  if (!isSameOrigin(req)) return jsonError(403, "Cross-site request refused.");
  if (!req.headers.get("content-type")?.startsWith("application/json")) return jsonError(415, "Send JSON.");
  const { orgSlug } = await ctx.params;
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in first.");
  const { principal, decision } = await orgPrincipalForSession(session, orgSlug);
  if (!principal) return jsonError(404, "Not found.");
  if (!decision.ok) return jsonError(403, "This organization requires a different sign-in method. Reload the page.");
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await req.json());
  } catch {
    return jsonError(400, "Invalid request.");
  }

  const gen = runAssistantTurn({ principal, meta: await requestMeta() }, input, { signal: req.signal });
  // the first step validates permission, input and conversation ownership: report those as plain HTTP errors
  let first: IteratorResult<AssistantEvent>;
  try {
    first = await gen.next();
  } catch (e) {
    if (e instanceof ValidationError) return jsonError(400, e.message);
    if (e instanceof ForbiddenError) return jsonError(403, "The assistant isn't available to your role.");
    if (e instanceof NotFoundError) return jsonError(404, "Conversation not found.");
    log.error("ai.stream_failed", { error: e instanceof Error ? e.message : String(e) });
    return jsonError(500, "Something went wrong.");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: AssistantEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      try {
        if (!first.done) send(first.value);
        for await (const ev of gen) send(ev);
      } catch (e) {
        log.error("ai.stream_failed", { error: e instanceof Error ? e.message : String(e) });
        try {
          send({ type: "error", code: "internal", message: "Something went wrong while answering. Please try again." });
        } catch {
          /* client already gone */
        }
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
      // a policy may have let a change run during the turn: deliver the notifications it emitted
      const { afterChange } = await import("@/server/after-change");
      await afterChange();
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" },
  });
}
