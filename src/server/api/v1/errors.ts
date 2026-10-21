import "server-only";
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError } from "../../authz/authorize";
import { ConflictError, ValidationError } from "../../modules/context";
import { FeatureUnavailableError, LimitReachedError, ReadOnlyError } from "../../billing/entitlements";
import { ApiAuthError } from "../keys";
import { log } from "../../log";

// One error shape for every API response (Iteration 10):
// { "error": { "type": "...", "message": "...", "details"?: [{ "field", "message" }], "request_id": "..." } }
export type ApiErrorType =
  | "invalid_request" | "authentication_failed" | "permission_denied" | "not_found" | "conflict" | "idempotency_conflict"
  | "rate_limited" | "subscription_inactive" | "feature_unavailable" | "limit_reached" | "server_error";

export class ApiError extends Error {
  constructor(readonly status: number, readonly type: ApiErrorType, message: string, readonly details?: { field: string; message: string }[]) {
    super(message);
  }
}

export const ERROR_TYPES: Record<ApiErrorType, { status: number; description: string }> = {
  invalid_request: { status: 400, description: "The request is malformed or a field is invalid (see details)." },
  authentication_failed: { status: 401, description: "Missing, invalid, expired or revoked API key." },
  permission_denied: { status: 403, description: "The key (or the person who created it) isn't allowed to do this." },
  not_found: { status: 404, description: "No such record, or it's outside what the key can reach." },
  conflict: { status: 409, description: "The change conflicts with the record's current state." },
  idempotency_conflict: { status: 409, description: "The Idempotency-Key was used for a different request, or that request is still running." },
  limit_reached: { status: 403, description: "The plan's limit would be exceeded." },
  feature_unavailable: { status: 403, description: "The plan doesn't include this feature, or it's switched off." },
  subscription_inactive: { status: 402, description: "The subscription has lapsed; the organization is read-only." },
  rate_limited: { status: 429, description: "Too many requests for this key; retry after the Retry-After header." },
  server_error: { status: 500, description: "Something went wrong on our side." },
};

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ApiAuthError) return new ApiError(e.status, e.status === 401 ? "authentication_failed" : "permission_denied", e.message);
  if (e instanceof ZodError) {
    return new ApiError(400, "invalid_request", "Some fields are invalid.", e.issues.slice(0, 20).map((i) => ({ field: i.path.join(".") || "body", message: i.message })));
  }
  if (e instanceof ValidationError) return new ApiError(400, "invalid_request", e.message, e.field ? [{ field: e.field, message: e.message }] : undefined);
  if (e instanceof ReadOnlyError) return new ApiError(402, "subscription_inactive", e.message);
  if (e instanceof FeatureUnavailableError) return new ApiError(403, "feature_unavailable", e.message);
  if (e instanceof LimitReachedError) return new ApiError(403, "limit_reached", e.message);
  if (e instanceof NotFoundError) return new ApiError(404, "not_found", "Not found.");
  if (e instanceof ForbiddenError) return new ApiError(403, "permission_denied", e.message);
  if (e instanceof ConflictError) return new ApiError(409, "conflict", e.message);
  log.error("api.failed", { err: e });
  return new ApiError(500, "server_error", "Something went wrong. Try again; if it keeps happening, contact support with the request id.");
}
