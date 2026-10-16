import { and, eq, isNull, sql } from "drizzle-orm";
import { db, withContext } from "../src/server/db/client";
import { dailyBriefs, outboxEvents, properties, users, workflows } from "../src/server/db/schema";
import { buildBrief } from "../src/server/analytics/brief";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import { saveRule } from "../src/server/automation/service";
import { processAutomationEvents, runDueSchedules } from "../src/server/automation/engine";
import { drainOutbox } from "../src/server/modules/notifications/service";
import { createWorkOrder, createWoSchema } from "../src/server/modules/maintenance/service";
import { TEMPLATES } from "../src/lib/automation-templates";
import type { TenantCtx } from "../src/server/modules/context";

// Automation rules a property-management company would plausibly run (Iteration 9), saved through the real service,
// plus real runs produced by the engine: a scheduled report that ran, and an elevator emergency waiting for the
// property manager's approval. History created earlier in the seed isn't replayed through the new rules.
export async function seedAutomation(): Promise<{ rules: number; runs: number }> {
  const ctxFor = async (email: string): Promise<TenantCtx> => {
    const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
    const p = u ? await loadPrincipal(u.id, "pacific-properties") : null;
    if (!p) throw new Error(`seed-automation: ${email} missing`);
    return { principal: p, meta: null };
  };
  const [admin, pm, emma] = await Promise.all([ctxFor("admin@demo.test"), ctxFor("pm@demo.test"), ctxFor("resident@demo.test")]);
  const orgId = admin.principal.orgId;

  // everything seeded so far counts as already evaluated
  const orgs = await withContext({ system: true }, (tx) => tx.selectDistinct({ orgId: outboxEvents.orgId }).from(outboxEvents).where(isNull(outboxEvents.automationAt)));
  for (const o of orgs) await withContext({ orgId: o.orgId, system: true }, (tx) => tx.update(outboxEvents).set({ automationAt: new Date() }).where(and(eq(outboxEvents.orgId, o.orgId), isNull(outboxEvents.automationAt))));

  const [frt] = await withContext({ orgId, system: true }, (tx) => tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, orgId), eq(properties.code, "FRT"))));
  const tpl = (key: string) => TEMPLATES.find((t) => t.key === key)!.rule;
  await saveRule(admin, null, { ...tpl("elevator_emergency"), name: "Elevator emergencies — Fraser Towers", propertyId: frt.id }, true);
  await saveRule(admin, null, { ...tpl("sla_warning"), propertyId: null }, true);
  await saveRule(admin, null, { ...tpl("urgent_complaint"), propertyId: null }, true);
  const weekly = await saveRule(pm, null, { ...tpl("weekly_report"), name: "Weekly maintenance report — Fraser Towers", propertyId: frt.id }, true);
  await saveRule(pm, null, { ...tpl("perishable"), propertyId: frt.id }, true);
  await saveRule(admin, null, { ...tpl("serious_incident"), propertyId: null }, false);

  // the weekly report's slot comes due now
  await withContext({ orgId, system: true }, (tx) => tx.update(workflows).set({ nextRunAt: sql`now() - interval '1 minute'` }).where(eq(workflows.id, weekly.id)));
  let runs = await runDueSchedules();

  // a resident reports an elevator emergency: the rule runs up to the approval step and waits for Marcus
  await createWorkOrder(emma, createWoSchema.parse({
    title: "Elevator stopped between floors — doors won't open", category: "elevator", isEmergency: "on", unitId: [...emma.principal.unitIds][0],
    description: "Car 2 in our tower stopped between 11 and 12. Nobody is inside now, but the doors stay shut and the car isn't moving.",
  }));
  await drainOutbox();
  for (let i = 0; i < 4; i++) { const n = await processAutomationEvents(); runs += n; if (!n) break; }
  await drainOutbox();

  // this morning's brief for the property manager, as delivered (the worker delivers the rest at the org's brief time)
  const brief = await buildBrief(pm);
  await withContext({ orgId, system: true }, (tx) => tx.insert(dailyBriefs).values({ orgId, userId: pm.principal.userId, briefDate: brief.date, content: brief }).onConflictDoNothing());
  return { rules: 6, runs };
}
