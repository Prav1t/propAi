// Shared rate limits on Redis (Iteration 11). Needs a Redis server: REDIS_TEST_URL=redis://127.0.0.1:6379/15
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRateLimiter, RedisRateLimiter } from "@/server/auth/rate-limit";

const url = process.env.REDIS_TEST_URL;

describe.skipIf(!url)("Redis rate limiter", () => {
  let a: Redis, b: Redis;
  let t = Date.UTC(2026, 9, 22, 10, 0, 0);
  const clock = () => t;
  beforeAll(async () => {
    a = new Redis(url!);
    b = new Redis(url!);
    await a.flushdb();
  });
  afterAll(async () => {
    await a.flushdb();
    a.disconnect();
    b.disconnect();
  });

  it("two app instances share one limit (an attacker can't spread attempts across instances)", async () => {
    const one = new RedisRateLimiter(a, new MemoryRateLimiter(clock), clock);
    const two = new RedisRateLimiter(b, new MemoryRateLimiter(clock), clock);
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await (i % 2 ? two : one).hit("login:email:x@demo.test", 5, 15 * 60_000)).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("the window slides: attempts from the previous window still count in proportion", async () => {
    const rl = new RedisRateLimiter(a, new MemoryRateLimiter(clock), clock);
    const w = 60_000;
    t = Math.floor(t / w) * w + w - 1; // last millisecond of a window
    for (let i = 0; i < 10; i++) await rl.hit("slide", 10, w);
    expect((await rl.hit("slide", 10, w)).allowed).toBe(false);
    t += w / 2 + 1; // halfway into the next window: half of the previous 11 still count
    const r = await rl.hit("slide", 10, w);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeLessThan(5);
    t += 2 * w; // two windows later nothing from before counts
    expect((await rl.hit("slide", 10, w)).remaining).toBe(9);
  });

  it("reset clears a key everywhere", async () => {
    const rl = new RedisRateLimiter(a, new MemoryRateLimiter(clock), clock);
    for (let i = 0; i < 3; i++) await rl.hit("reset-me", 3, 60_000);
    expect((await rl.hit("reset-me", 3, 60_000)).allowed).toBe(false);
    await rl.reset("reset-me");
    expect((await new RedisRateLimiter(b, new MemoryRateLimiter(clock), clock).hit("reset-me", 3, 60_000)).allowed).toBe(true);
  });

  it("when Redis is unreachable it keeps limiting per instance instead of failing open", async () => {
    const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => {});
    const rl = new RedisRateLimiter(dead, new MemoryRateLimiter(clock), clock);
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await rl.hit("down", 3, 60_000)).allowed);
    expect(out).toEqual([true, true, true, false]);
    dead.disconnect();
  });
});
