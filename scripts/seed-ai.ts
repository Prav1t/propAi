import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import { runAssistantTurn } from "../src/server/ai/orchestrator";
import { setChatModelForTests } from "../src/server/ai/providers";
import { DemoModel } from "../src/server/ai/providers/demo";

// Real assistant conversations for the demo users, produced by running the actual orchestrator and tools against the
// freshly seeded data (always with the demo model, so seeding never calls an external AI provider).
export async function seedAi(): Promise<{ conversations: number; toolCalls: number }> {
  setChatModelForTests(new DemoModel());
  let conversations = 0;
  let toolCalls = 0;
  const ask = async (email: string, orgSlug: string, questions: string[]) => {
    const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
    const principal = u ? await loadPrincipal(u.id, orgSlug) : null;
    if (!principal) throw new Error(`seed-ai: ${email} is not in ${orgSlug}`);
    let conversationId: string | null = null;
    for (const message of questions) {
      for await (const ev of runAssistantTurn({ principal, meta: null }, { conversationId, message })) {
        if (ev.type === "start") conversationId = ev.conversationId;
        if (ev.type === "tool_end") toolCalls++;
        if (ev.type === "error") throw new Error(`seed-ai: ${ev.message}`);
      }
    }
    conversations++;
  };
  try {
    await ask("pm@demo.test", "pacific-properties", ["Show me all overdue maintenance requests across my properties", "Which vendor has been the slowest this month?"]);
    await ask("facility@demo.test", "pacific-properties", ["Find recurring equipment problems"]);
    await ask("resident@demo.test", "pacific-properties", ["Do I have any packages?"]);
    await ask("admin@northshore.test", "northshore-strata", ["Summarize today's incidents"]);
  } finally {
    setChatModelForTests(undefined);
    await closeDb();
  }
  return { conversations, toolCalls };
}
