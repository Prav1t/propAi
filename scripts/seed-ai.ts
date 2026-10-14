import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import { runAssistantTurn } from "../src/server/ai/orchestrator";
import { setChatModelForTests } from "../src/server/ai/providers";
import { DemoModel } from "../src/server/ai/providers/demo";
import { setPolicy } from "../src/server/ai/policies";
import { approvePlan } from "../src/server/ai/approvals";
import type { Principal } from "../src/server/authz/authorize";

// Real assistant conversations for the demo users, produced by running the actual orchestrator and tools against the
// freshly seeded data (always with the demo model, so seeding never calls an external AI provider).
// Iteration 7: organization rules for what the assistant may do on its own, plus plans in every state —
// one left waiting for the property manager to approve, one approved and carried out, one run by policy.
export async function seedAi(): Promise<{ conversations: number; toolCalls: number; plans: number }> {
  setChatModelForTests(new DemoModel());
  let conversations = 0;
  let toolCalls = 0;
  let plans = 0;
  const as = async (email: string, orgSlug: string): Promise<Principal> => {
    const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
    const principal = u ? await loadPrincipal(u.id, orgSlug) : null;
    if (!principal) throw new Error(`seed-ai: ${email} is not in ${orgSlug}`);
    return principal;
  };
  // returns the id of the plan the last question prepared, if any
  const ask = async (email: string, orgSlug: string, questions: string[]): Promise<string | null> => {
    const principal = await as(email, orgSlug);
    let conversationId: string | null = null;
    let planId: string | null = null;
    for (const message of questions) {
      planId = null;
      for await (const ev of runAssistantTurn({ principal, meta: null }, { conversationId, message })) {
        if (ev.type === "start") conversationId = ev.conversationId;
        if (ev.type === "tool_end") toolCalls++;
        if (ev.type === "plan") {
          planId = ev.plan.id;
          plans++;
        }
        if (ev.type === "error") throw new Error(`seed-ai: ${ev.message}`);
      }
    }
    conversations++;
    return planId;
  };
  try {
    // rules: Pacific lets the assistant create internal tasks without asking; Northshore keeps package logging manual
    const pacAdmin = { principal: await as("admin@demo.test", "pacific-properties"), meta: null };
    await setPolicy(pacAdmin, { action: "task.create", propertyId: null, mode: "auto" });
    const nsAdmin = { principal: await as("admin@northshore.test", "northshore-strata"), meta: null };
    await setPolicy(nsAdmin, { action: "package.log", propertyId: null, mode: "deny" });

    // a plan carried out by policy, one approved by the person who asked, and one still waiting
    await ask("pm@demo.test", "pacific-properties", ["Create a task to replace the burnt-out lobby light bulbs at Harbour Centre by Friday"]);
    const logged = await ask("concierge@demo.test", "pacific-properties", ["A package arrived for unit 1204 in Tower A from Amazon"]);
    if (!logged) throw new Error("seed-ai: the package plan wasn't prepared");
    await approvePlan({ principal: await as("concierge@demo.test", "pacific-properties"), meta: null }, logged);
    if (!(await ask("pm@demo.test", "pacific-properties", ["Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator"]))) throw new Error("seed-ai: the work-order plan wasn't prepared");
    if (!(await ask("admin@northshore.test", "northshore-strata", ["Create a task to check the roof drains at Lonsdale Quay Lofts by Friday"]))) throw new Error("seed-ai: the Northshore plan wasn't prepared");

    await ask("pm@demo.test", "pacific-properties", ["Show me all overdue maintenance requests across my properties", "Which vendor has been the slowest this month?"]);
    await ask("facility@demo.test", "pacific-properties", ["Find recurring equipment problems"]);
    await ask("resident@demo.test", "pacific-properties", ["Do I have any packages?", "What are the rules for booking the party room?"]);
    await ask("admin@northshore.test", "northshore-strata", ["Summarize today's incidents"]);
  } finally {
    setChatModelForTests(undefined);
    await closeDb();
  }
  return { conversations, toolCalls, plans };
}
