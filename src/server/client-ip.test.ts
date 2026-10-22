import { describe, expect, it } from "vitest";
import { clientIpConfig, clientIpFrom, forwardedHost, normalizeIp } from "./client-ip";

const bag = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("client IP (F-01: forged X-Forwarded-For)", () => {
  it("behind one proxy, takes the entry the proxy appended — never the client-written leftmost one", () => {
    const h = bag({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }); // client sent 6.6.6.6, the proxy appended its peer
    expect(clientIpFrom(h, { hops: 1, header: null })).toBe("203.0.113.7");
  });

  it("behind two proxies (CDN + load balancer), takes the second entry from the right", () => {
    const h = bag({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 198.51.100.2" });
    expect(clientIpFrom(h, { hops: 2, header: null })).toBe("203.0.113.7");
  });

  it("rotating forged prefixes doesn't change the address used for rate limits", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => clientIpFrom(bag({ "x-forwarded-for": `10.0.0.${i}, 1.1.1.${i}, 203.0.113.7` }), { hops: 1, header: null })));
    expect([...seen]).toEqual(["203.0.113.7"]);
  });

  it("ignores X-Real-IP unless the deployment names it as the client header", () => {
    const h = bag({ "x-real-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.7" });
    expect(clientIpFrom(h, { hops: 1, header: null })).toBe("203.0.113.7");
    expect(clientIpFrom(bag({ "cf-connecting-ip": "203.0.113.9" }), { hops: 0, header: "cf-connecting-ip" })).toBe("203.0.113.9");
  });

  it("without a proxy uses the socket address Next.js recorded", () => {
    expect(clientIpFrom(bag({ "x-forwarded-for": "::ffff:127.0.0.1" }), { hops: 0, header: null })).toBe("127.0.0.1");
    expect(clientIpFrom(bag({}), { hops: 0, header: null })).toBeNull();
  });

  it("rejects values that aren't IP addresses", () => {
    expect(clientIpFrom(bag({ "x-forwarded-for": "evil<script>, not-an-ip" }), { hops: 1, header: null })).toBeNull();
    expect(normalizeIp("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("999.1.1.1")).toBeNull();
  });

  it("reads the configuration (old TRUST_PROXY=true still means one proxy)", () => {
    expect(clientIpConfig({ TRUSTED_PROXY_HOPS: "2" })).toEqual({ hops: 2, header: null });
    expect(clientIpConfig({ TRUST_PROXY: "true" }).hops).toBe(1);
    expect(clientIpConfig({ TRUSTED_PROXY_HOPS: "-3" }).hops).toBe(0);
    expect(clientIpConfig({ CLIENT_IP_HEADER: " CF-Connecting-IP " }).header).toBe("cf-connecting-ip");
  });

  it("trusts X-Forwarded-Host only behind a configured proxy", () => {
    const h = bag({ "x-forwarded-host": "evil.example" });
    expect(forwardedHost(h, { hops: 0, header: null })).toBeNull();
    expect(forwardedHost(h, { hops: 1, header: null })).toBe("evil.example");
  });
});
