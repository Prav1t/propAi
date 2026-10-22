import "server-only";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { orgSecurityPolicies, ssoConnections } from "../db/schema";
import { DEFAULT_POLICY, type SecurityPolicy } from "@/lib/security-policy";

// the organization's MFA/SSO requirements; SSO can only be required while a connection is active
export async function loadSecurityPolicy(tx: Tx, orgId: string): Promise<SecurityPolicy> {
  const [p] = await tx.select().from(orgSecurityPolicies).where(eq(orgSecurityPolicies.orgId, orgId));
  const [c] = await tx.select({ id: ssoConnections.id }).from(ssoConnections).where(and(eq(ssoConnections.orgId, orgId), eq(ssoConnections.status, "active")));
  if (!p) return { ...DEFAULT_POLICY, ssoConnectionId: c?.id ?? null };
  return { requireMfa: p.requireMfa as SecurityPolicy["requireMfa"], requireSso: p.requireSso && !!c, ssoConnectionId: c?.id ?? null };
}
