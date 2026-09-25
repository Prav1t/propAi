// fixed-window limiter behind an interface; swap for Redis when running more than one instance
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
export const rateLimiter = (): RateLimiter =>
  (g.__rateLimiter ??= relaxed() ? new ScaledLimiter(new MemoryRateLimiter(), 100) : new MemoryRateLimiter());

// named policies used across auth flows
export const LIMITS = {
  loginPerIp: { limit: 20, windowMs: 15 * 60_000 },
  loginPerEmail: { limit: 5, windowMs: 15 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  resetRequest: { limit: 5, windowMs: 60 * 60_000 },
  mfa: { limit: 10, windowMs: 15 * 60_000 },
  invite: { limit: 50, windowMs: 60 * 60_000 },
} as const;
