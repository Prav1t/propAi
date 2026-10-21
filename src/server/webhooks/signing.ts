import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Webhook signatures (Iteration 10). Each delivery carries:
//   Webhook-Id: <delivery id>   (stable across retries: use it to ignore duplicates)
//   Webhook-Timestamp: <unix seconds>
//   Webhook-Signature: t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" keyed with the endpoint secret>
// Receivers should recompute v1 over the raw body, compare in constant time and reject timestamps older than 5 minutes.

export const SIGNATURE_TOLERANCE_S = 300;

export const generateWebhookSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyWebhook(secret: string, header: string | null, body: string, now = Date.now(), toleranceS = SIGNATURE_TOLERANCE_S): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(Math.floor(now / 1000) - t) > toleranceS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const got = Buffer.from(parts.v1);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// retry schedule after a failed attempt (seconds); attempt n waits RETRY_DELAYS[n-1] ± 10%
export const RETRY_DELAYS_S = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;

export function nextAttemptDelayMs(attemptsSoFar: number, rand = Math.random): number | null {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_S[Math.min(attemptsSoFar, RETRY_DELAYS_S.length) - 1] ?? RETRY_DELAYS_S[0];
  return Math.round(base * 1000 * (0.9 + rand() * 0.2));
}
