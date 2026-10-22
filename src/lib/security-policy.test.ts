import { describe, expect, it } from "vitest";
import { decidePolicy, type SecurityPolicy } from "./security-policy";
import { emailDomain, normalizeDomain, reportsMfa, SSO_PROVIDERS } from "./sso";

const staff = { category: "staff", roleKey: "property_manager" };
const admin = { category: "staff", roleKey: "org_admin" };
const resident = { category: "resident", roleKey: "resident" };
const pwd = { amr: ["pwd"], ssoConnectionId: null, mfaEnabled: false };
const pwdOtp = { amr: ["pwd", "otp"], ssoConnectionId: null, mfaEnabled: true };
const sso = (id: string) => ({ amr: ["sso"], ssoConnectionId: id, mfaEnabled: false });
const policy = (p: Partial<SecurityPolicy>): SecurityPolicy => ({ requireMfa: "off", requireSso: false, ssoConnectionId: "c1", ...p });

describe("organization security policy", () => {
  it("allows everything when nothing is required", () => {
    expect(decidePolicy(policy({}), staff, pwd)).toEqual({ ok: true });
  });

  it("MFA for staff: password-only staff must set it up; residents aren't affected; SSO counts", () => {
    const p = policy({ requireMfa: "staff" });
    expect(decidePolicy(p, staff, pwd)).toEqual({ ok: false, reason: "mfa_setup_required" });
    expect(decidePolicy(p, staff, { ...pwd, mfaEnabled: true })).toEqual({ ok: false, reason: "mfa_signin_required" });
    expect(decidePolicy(p, staff, pwdOtp)).toEqual({ ok: true });
    expect(decidePolicy(p, staff, sso("c1"))).toEqual({ ok: true });
    expect(decidePolicy(p, resident, pwd)).toEqual({ ok: true });
    expect(decidePolicy(policy({ requireMfa: "everyone" }), resident, pwd)).toEqual({ ok: false, reason: "mfa_setup_required" });
  });

  it("SSO for staff: only this organization's connection counts; another organization's SSO doesn't", () => {
    const p = policy({ requireSso: true });
    expect(decidePolicy(p, staff, pwdOtp)).toEqual({ ok: false, reason: "sso_required" });
    expect(decidePolicy(p, staff, sso("other-org-connection"))).toEqual({ ok: false, reason: "sso_required" });
    expect(decidePolicy(p, staff, sso("c1"))).toEqual({ ok: true });
    expect(decidePolicy(p, resident, pwd)).toEqual({ ok: true });
  });

  it("admins are the break-glass exception to SSO, but then need MFA", () => {
    const p = policy({ requireSso: true });
    expect(decidePolicy(p, admin, pwd)).toEqual({ ok: false, reason: "mfa_setup_required" });
    expect(decidePolicy(p, admin, pwdOtp)).toEqual({ ok: true });
    expect(decidePolicy(p, admin, sso("c1"))).toEqual({ ok: true });
  });
});

describe("SSO helpers", () => {
  it("normalizes domains and refuses shared mailbox providers", () => {
    expect(normalizeDomain(" @Pacific-Properties.CA. ")).toEqual({ domain: "pacific-properties.ca" });
    expect(normalizeDomain("gmail.com")).toHaveProperty("error");
    expect(normalizeDomain("not a domain")).toHaveProperty("error");
    expect(normalizeDomain("localhost")).toHaveProperty("error");
    expect(emailDomain("Ana@Pacific.CA")).toBe("pacific.ca");
  });

  it("builds issuers for each provider", () => {
    expect(SSO_PROVIDERS.microsoft.issuer("1111-2222")).toBe("https://login.microsoftonline.com/1111-2222/v2.0");
    expect(SSO_PROVIDERS.okta.issuer("https://acme.okta.com/")).toBe("https://acme.okta.com");
    expect(SSO_PROVIDERS.google.issuer()).toBe("https://accounts.google.com");
  });

  it("recognizes multi-factor in the amr claim", () => {
    expect(reportsMfa(["pwd", "mfa"])).toBe(true);
    expect(reportsMfa(["pwd"])).toBe(false);
    expect(reportsMfa("mfa")).toBe(false);
  });
});
