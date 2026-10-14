import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { z } from "zod";
import { getOrgContext } from "./org-context";
import { toActionError, zodFieldErrors, type ActionState } from "./actions";
import type { TenantCtx } from "./modules/context";

// every string field except secrets, echoed back so the form keeps input on error
function echo(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !/password|confirm|token|signature/i.test(k) && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}

// parse → resolve org principal from the session → run the service → revalidate/redirect
export async function runOrgForm<S extends z.ZodType, R>(opts: {
  orgSlug: string;
  fd: FormData;
  schema: S;
  run: (ctx: TenantCtx, data: z.output<S>) => Promise<R>;
  done: (result: R) => { redirectTo?: string; revalidate?: string[]; message?: string; data?: unknown };
}): Promise<ActionState> {
  const values = echo(opts.fd);
  const parsed = opts.schema.safeParse(Object.fromEntries(Object.entries(values)));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values, error: "Check the highlighted fields." };
  let result: R;
  try {
    const { ctx } = await getOrgContext(opts.orgSlug);
    result = await opts.run(ctx, parsed.data);
  } catch (e) {
    return toActionError(e, values);
  }
  // deliver notifications for whatever this change emitted, without delaying the response
  after(async () => {
    const { drainOutbox } = await import("./modules/notifications/service");
    await drainOutbox().catch(() => {});
    // documents and knowledge entries queued for the assistant's index are processed right away (the worker also polls)
    const { processIndexQueue } = await import("./kb/indexer");
    await processIndexQueue().catch(() => {});
  });
  const d = opts.done(result);
  for (const p of d.revalidate ?? [`/o/${opts.orgSlug}`]) revalidatePath(p, "layout");
  if (d.redirectTo) redirect(d.redirectTo);
  return { ok: true, message: d.message ?? "Saved.", ...(d.data !== undefined ? { data: d.data } : {}) };
}
