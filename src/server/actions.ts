import "server-only";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError } from "./authz/authorize";
import { ConflictError, ValidationError } from "./modules/context";
import { log } from "./log";

import type { ActionState } from "@/lib/action-state";
export type { ActionState };

export function zodFieldErrors(e: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    const k = String(issue.path[0] ?? "_");
    out[k] ??= issue.message;
  }
  return out;
}

// echo non-secret fields back so forms keep user input after an error
export function formValues(fd: FormData, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, String(fd.get(k) ?? "")]));
}

// maps domain errors to friendly form state; rethrows redirects and unknown errors are logged
export function toActionError(e: unknown, values?: Record<string, string>): ActionState {
  unstable_rethrow(e); // let redirect()/notFound() propagate
  if (e instanceof ZodError) return { error: "Check the highlighted fields.", fieldErrors: zodFieldErrors(e), values };
  if (e instanceof ValidationError) return { error: e.message, fieldErrors: e.field ? { [e.field]: e.message } : undefined, values };
  if (e instanceof ForbiddenError || e instanceof ConflictError) return { error: e.message, values };
  if (e instanceof NotFoundError) return { error: "That item no longer exists.", values };
  log.error("action.failed", { err: e });
  return { error: "Something went wrong. Please try again.", values };
}

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};
