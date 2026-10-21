import { describe, expect, it } from "vitest";
import { envFlag, resolveFlags } from "./flags";

const ORG = "11111111-1111-1111-1111-111111111111";

describe("feature flags", () => {
  it("resolves organization override → global override → environment → default", () => {
    expect(resolveFlags([], ORG, {}).public_api).toBe(true); // default
    expect(resolveFlags([], ORG, { FLAG_PUBLIC_API: "false" }).public_api).toBe(false); // environment
    expect(resolveFlags([{ key: "public_api", orgId: null, enabled: true }], ORG, { FLAG_PUBLIC_API: "false" }).public_api).toBe(true); // global beats env
    const both = [{ key: "public_api", orgId: null, enabled: true }, { key: "public_api", orgId: ORG, enabled: false }];
    expect(resolveFlags(both, ORG, {}).public_api).toBe(false); // organization beats global
    expect(resolveFlags(both, "22222222-2222-2222-2222-222222222222", {}).public_api).toBe(true); // other orgs keep the global value
  });
  it("reads common spellings from the environment and ignores junk", () => {
    expect(envFlag("webhooks", { FLAG_WEBHOOKS: "0" })).toBe(false);
    expect(envFlag("webhooks", { FLAG_WEBHOOKS: "on" })).toBe(true);
    expect(envFlag("webhooks", { FLAG_WEBHOOKS: "maybe" })).toBe(true); // default
  });
});
