import "server-only";
import { loadPrincipal } from "./modules/organizations/principal";
import type { ValidSession } from "./auth/service";
import { decidePolicy, type PolicyDecision } from "@/lib/security-policy";

// a session's principal in an organization, with the organization's MFA/SSO policy applied (Iteration 11).
// Checked on every request, so a policy change applies at once to sessions that are already open.
export async function orgPrincipalForSession(session: ValidSession, orgSlug: string) {
  const principal = await loadPrincipal(session.user.id, orgSlug);
  if (!principal) return { principal: null, decision: null } as const;
  const decision: PolicyDecision = decidePolicy(
    principal.security,
    { category: principal.role.category, roleKey: principal.role.key },
    { amr: session.amr, ssoConnectionId: session.ssoConnectionId, mfaEnabled: session.user.mfaEnabled },
  );
  return { principal, decision };
}
