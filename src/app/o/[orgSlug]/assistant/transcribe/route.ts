import { getSession } from "@/server/auth/session";
import { orgPrincipalForSession } from "@/server/org-session";
import { requestMeta } from "@/server/request-meta";
import { isSameOrigin, jsonError } from "@/server/http";
import { rateLimiter } from "@/server/auth/rate-limit";
import { log } from "@/server/log";
import { MAX_AUDIO_BYTES, transcribe, TranscribeRefused } from "@/server/ai/transcribe";

export const dynamic = "force-dynamic";

// dictation for the assistant: one short recording in, its text out (nothing is asked of the assistant here)
export async function POST(req: Request, ctx: RouteContext<"/o/[orgSlug]/assistant/transcribe">) {
  if (!isSameOrigin(req)) return jsonError(403, "Cross-site request refused.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES + 64 * 1024) return jsonError(413, "Recordings can be up to 10 MB (about a minute).");
  const { orgSlug } = await ctx.params;
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in first.");
  const { principal, decision } = await orgPrincipalForSession(session, orgSlug);
  if (!principal) return jsonError(404, "Not found.");
  if (!decision.ok) return jsonError(403, "This organization requires a different sign-in method. Reload the page.");
  const limited = await rateLimiter().hit(`ai:transcribe:${principal.orgId}:${principal.userId}`, 20, 60_000);
  if (!limited.allowed) return jsonError(429, "Too many recordings in a minute. Wait a moment and try again.");
  let audio: FormDataEntryValue | null;
  try {
    audio = (await req.formData()).get("audio");
  } catch {
    return jsonError(400, "Invalid request.");
  }
  if (!(audio instanceof File)) return jsonError(400, "Attach the recording as \"audio\".");
  try {
    const text = await transcribe({ principal, meta: await requestMeta() }, audio, { signal: req.signal });
    return Response.json({ text });
  } catch (e) {
    if (e instanceof TranscribeRefused) return jsonError(e.status, e.message);
    log.error("ai.transcribe_failed", { error: e instanceof Error ? e.message : String(e) });
    return jsonError(500, "Something went wrong.");
  }
}
