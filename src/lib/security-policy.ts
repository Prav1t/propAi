// Organization security policy (Iteration 11), decided per request from the session and the member's role.
// - requireMfa "staff" | "everyone": the session must have been established with a second factor. Signing in through
//   the organization's SSO counts: the identity provider owns multi-factor for those accounts.
// - requireSso: staff must sign in through the organization's SSO connection. Organization admins are exempt so a
//   broken identity provider can't lock everyone out ("break-glass"), but they must then use MFA.
// Residents and vendors are never forced onto staff SSO.
export const MFA_REQUIREMENTS = ["off", "staff", "everyone"] as const;
export type MfaRequirement = (typeof MFA_REQUIREMENTS)[number];
export type SecurityPolicy = { requireMfa: MfaRequirement; requireSso: boolean; ssoConnectionId: string | null };
export const DEFAULT_POLICY: SecurityPolicy = { requireMfa: "off", requireSso: false, ssoConnectionId: null };

export type PolicyDecision =
  | { ok: true }
  | { ok: false; reason: "sso_required" } // sign in again through the organization's identity provider
  | { ok: false; reason: "mfa_setup_required" } // turn on two-step verification, then sign in again
  | { ok: false; reason: "mfa_signin_required" }; // two-step is on, but this session was opened without it

const SECOND_FACTOR = new Set(["otp", "recovery", "sso", "sso_mfa"]);

export function decidePolicy(
  policy: SecurityPolicy,
  member: { category: string; roleKey: string },
  session: { amr: readonly string[]; ssoConnectionId: string | null; mfaEnabled: boolean },
): PolicyDecision {
  const staff = member.category === "staff";
  const admin = member.roleKey === "org_admin";
  const viaOrgSso = session.amr.includes("sso") && !!policy.ssoConnectionId && session.ssoConnectionId === policy.ssoConnectionId;
  if (policy.requireSso && staff && !admin && !viaOrgSso) return { ok: false, reason: "sso_required" };
  const needsMfa = policy.requireMfa === "everyone" || (policy.requireMfa === "staff" && staff) || (policy.requireSso && admin);
  if (needsMfa && !session.amr.some((m) => SECOND_FACTOR.has(m))) {
    return { ok: false, reason: session.mfaEnabled ? "mfa_signin_required" : "mfa_setup_required" };
  }
  return { ok: true };
}

export const POLICY_MESSAGES: Record<Exclude<PolicyDecision, { ok: true }>["reason"], string> = {
  sso_required: "This organization requires staff to sign in with its single sign-on.",
  mfa_setup_required: "This organization requires two-step verification. Turn it on, then open the organization again.",
  mfa_signin_required: "This organization requires two-step verification. Sign in again with your authenticator code.",
};
