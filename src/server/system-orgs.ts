import "server-only";
import { eq } from "drizzle-orm";
import { withContext } from "./db/client";
import { organizations } from "./db/schema";

// background jobs that work per organization (SLA warnings, daily briefs) list the active ones here.
// The platform-admin context is used only to enumerate organizations; each job then works inside one org's context.
export function activeOrgs() {
  return withContext({ platformAdmin: true }, (tx) => tx.select({ id: organizations.id, slug: organizations.slug, timezone: organizations.timezone, settings: organizations.settings })
    .from(organizations).where(eq(organizations.status, "active")));
}
