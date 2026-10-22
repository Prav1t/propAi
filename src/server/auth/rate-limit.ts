import Redis from "ioredis";

// limiter behind an interface: in-process fixed windows for one instance; with REDIS_URL, a sliding window shared by
// every instance (Iteration 11) so limits hold across a horizontally scaled deployment
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
  reset(key: string): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowMs: number) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 50_000) this.sweep(t); // bound memory
    return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
  }

  async reset(key: string) {
    this.buckets.delete(key);
  }

  private sweep(t: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= t) this.buckets.delete(k);
  }
}

// sliding window over two fixed buckets: the previous bucket counts in proportion to how much of it the window still
// covers. One atomic script per hit; keys expire on their own.
const SLIDING = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1] * 2) end
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
return { cur, prev }`;

export class RedisRateLimiter implements RateLimiter {
  private warned = 0;
  constructor(private redis: Redis, private fallback: RateLimiter = new MemoryRateLimiter(), private now: () => number = Date.now, private prefix = "rl:") {}

  private keys(key: string, windowMs: number, t: number) {
    const bucket = Math.floor(t / windowMs);
    return { cur: `${this.prefix}${key}:${windowMs}:${bucket}`, prev: `${this.prefix}${key}:${windowMs}:${bucket - 1}`, start: bucket * windowMs };
  }

  async hit(key: string, limit: number, windowMs: number) {
    const t = this.now();
    const k = this.keys(key, windowMs, t);
    try {
      const [cur, prev] = (await this.redis.eval(SLIDING, 2, k.cur, k.prev, windowMs)) as [number, number];
      const weighted = prev * ((windowMs - (t - k.start)) / windowMs) + cur;
      return { allowed: weighted <= limit, remaining: Math.max(0, Math.floor(limit - weighted)), resetAt: k.start + windowMs };
    } catch (e) {
      // Redis down: keep limiting per instance rather than not at all (and don't lock everyone out)
      if (t - this.warned > 60_000) {
        this.warned = t;
        console.warn(`[rate-limit] Redis unavailable, using per-instance limits: ${(e as Error).message}`);
      }
      return this.fallback.hit(key, limit, windowMs);
    }
  }

  async reset(key: string) {
    // every window size this key is used with lives under the same prefix; the scan is bounded to that key
    try {
      const stream = this.redis.scanStream({ match: `${this.prefix}${key}:*`, count: 100 });
      for await (const batch of stream as AsyncIterable<string[]>) if (batch.length) await this.redis.del(...batch);
    } catch {
      /* fallback below */
    }
    await this.fallback.reset(key);
  }
}

// E2E suites sign in many times from one loopback IP; RATE_LIMITS=relaxed raises limits 100x (never in production)
class ScaledLimiter implements RateLimiter {
  constructor(private inner: RateLimiter, private factor: number) {}
  hit(key: string, limit: number, windowMs: number) {
    return this.inner.hit(key, limit * this.factor, windowMs);
  }
  reset(key: string) {
    return this.inner.reset(key);
  }
}

const relaxed = () => process.env.RATE_LIMITS === "relaxed" && process.env.NODE_ENV !== "production";

const g = globalThis as unknown as { __rateLimiter?: RateLimiter };
function baseLimiter(): RateLimiter {
  const url = process.env.REDIS_URL;
  if (!url) return new MemoryRateLimiter();
  // short timeouts: a slow Redis must not hold up sign-in; commands fail fast and the fallback takes over
  const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 1_000, enableOfflineQueue: false });
  redis.on("error", () => {}); // reported by RedisRateLimiter when a hit actually fails
  return new RedisRateLimiter(redis);
}
export const rateLimiter = (): RateLimiter =>
  (g.__rateLimiter ??= relaxed() ? new ScaledLimiter(baseLimiter(), 100) : baseLimiter());

// named policies used across auth flows
export const LIMITS = {
  loginPerIp: { limit: 20, windowMs: 15 * 60_000 },
  loginPerEmail: { limit: 5, windowMs: 15 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  resetRequest: { limit: 5, windowMs: 60 * 60_000 },
  mfa: { limit: 10, windowMs: 15 * 60_000 },
  invite: { limit: 50, windowMs: 60 * 60_000 },
} as const;
