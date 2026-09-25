import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "./rate-limit";

describe("MemoryRateLimiter", () => {
  it("allows up to the limit within a window, then blocks, then resets", async () => {
    let now = 0;
    const rl = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 5; i++) expect((await rl.hit("k", 5, 1000)).allowed).toBe(true);
    expect((await rl.hit("k", 5, 1000)).allowed).toBe(false);
    now = 1001;
    expect((await rl.hit("k", 5, 1000)).allowed).toBe(true);
  });
  it("keys are independent and reset() clears", async () => {
    const rl = new MemoryRateLimiter(() => 0);
    await rl.hit("a", 1, 1000);
    expect((await rl.hit("a", 1, 1000)).allowed).toBe(false);
    expect((await rl.hit("b", 1, 1000)).allowed).toBe(true);
    await rl.reset("a");
    expect((await rl.hit("a", 1, 1000)).allowed).toBe(true);
  });
});

describe("rateLimiter() in production", () => {
  it("ignores RATE_LIMITS=relaxed when NODE_ENV=production", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = { r: env.RATE_LIMITS, n: env.NODE_ENV };
    env.RATE_LIMITS = "relaxed";
    env.NODE_ENV = "production";
    (globalThis as { __rateLimiter?: unknown }).__rateLimiter = undefined;
    const { rateLimiter } = await import("./rate-limit");
    const rl = rateLimiter();
    await rl.hit("p", 1, 1000);
    expect((await rl.hit("p", 1, 1000)).allowed).toBe(false);
    env.RATE_LIMITS = prev.r;
    env.NODE_ENV = prev.n;
    (globalThis as { __rateLimiter?: unknown }).__rateLimiter = undefined;
  });
});
