import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { generateWebhookSecret, MAX_ATTEMPTS, nextAttemptDelayMs, signWebhook, verifyWebhook } from "./signing";

describe("webhook signatures", () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: "evt", type: "work_order.created" });
  const now = Date.parse("2026-10-18T12:00:00Z");
  const ts = Math.floor(now / 1000);

  it("is HMAC-SHA256 of 'timestamp.body' — what a receiver computes from the docs", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(signWebhook(secret, ts, body)).toBe(`t=${ts},v1=${expected}`);
  });
  it("verifies, and rejects tampering, other secrets and old timestamps", () => {
    const h = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, h, body, now)).toBe(true);
    expect(verifyWebhook(secret, h, body.replace("created", "deleted"), now)).toBe(false);
    expect(verifyWebhook(generateWebhookSecret(), h, body, now)).toBe(false);
    expect(verifyWebhook(secret, h, body, now + 6 * 60_000)).toBe(false);
    expect(verifyWebhook(secret, null, body, now)).toBe(false);
    expect(verifyWebhook(secret, "t=abc,v1=00", body, now)).toBe(false);
  });
  it("backs off between retries and stops after the last attempt", () => {
    const mid = () => 0.5; // no jitter
    expect(nextAttemptDelayMs(1, mid)).toBe(60_000);
    expect(nextAttemptDelayMs(2, mid)).toBe(300_000);
    expect(nextAttemptDelayMs(7, mid)).toBe(86_400_000);
    expect(nextAttemptDelayMs(MAX_ATTEMPTS, mid)).toBeNull();
    const low = nextAttemptDelayMs(1, () => 0)!;
    const high = nextAttemptDelayMs(1, () => 1)!;
    expect(low).toBe(54_000);
    expect(high).toBe(66_000);
  });
});
