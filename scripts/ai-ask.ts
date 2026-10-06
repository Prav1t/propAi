import "dotenv/config";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import { runAssistantTurn } from "../src/server/ai/orchestrator";
import { approvePlan } from "../src/server/ai/approvals";
import { providerStatus } from "../src/server/ai/providers";

// Ask the assistant from the command line, as a given user, through the same orchestrator the app uses:
//   npm run ai:ask -- --as pm@demo.test [--org pacific-properties] [--mode facility] "Which vendor has been the slowest this month?"
// Add --verbose to print tool arguments and results, and --approve to approve the plan it prepares (as the same user).
async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const email = opt("as") ?? "pm@demo.test";
  const org = opt("org") ?? "pacific-properties";
  const mode = opt("mode");
  const verbose = args.includes("--verbose");
  const approve = args.includes("--approve");
  const question = args.filter((a) => a !== "--verbose" && a !== "--approve").join(" ").trim();
  if (!question) throw new Error('Usage: npm run ai:ask -- --as <email> "question"');
  const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!u) throw new Error(`No user ${email}`);
  const principal = await loadPrincipal(u.id, org);
  if (!principal) throw new Error(`${email} is not a member of ${org}`);
  const s = providerStatus();
  console.log(`· ${email} (${principal.role.name}) · ${s.provider}/${s.model}${s.demo ? ` — demo mode: ${s.reason}` : ""}\n`);
  let planId: string | null = null;
  for await (const ev of runAssistantTurn({ principal, meta: null }, { message: question, mode })) {
    if (ev.type === "text") process.stdout.write(ev.delta);
    else if (ev.type === "tool_start") process.stdout.write(`  → ${ev.title}…\n`);
    else if (ev.type === "tool_end") {
      process.stdout.write(`  ✓ ${ev.tool} [${ev.outcome}] ${ev.summary ?? ""}\n`);
      if (verbose && ev.display) process.stdout.write(`${JSON.stringify(ev.display, null, 2)}\n`);
    } else if (ev.type === "plan") {
      planId = ev.plan.id;
      process.stdout.write(`\n\n┌ Plan (${ev.plan.confirm} to approve, expires ${ev.plan.expiresAt.toISOString()})\n`);
      for (const st of ev.plan.steps) {
        process.stdout.write(`│ ${st.id}. ${st.title}  [${st.riskLabel}]\n`);
        for (const d of st.details) process.stdout.write(`│    · ${d}\n`);
        for (const e of st.effects) process.stdout.write(`│    → ${e}\n`);
        if (st.draft) process.stdout.write(`│    ┄ ${st.draft.title ?? ""}\n│    ${st.draft.body.replace(/\n/g, "\n│    ")}\n`);
      }
      process.stdout.write("└\n");
    } else if (ev.type === "notice" || ev.type === "error") process.stdout.write(`\n! ${ev.message}\n`);
    else if (ev.type === "done") process.stdout.write(`\n\n· outcome: ${ev.outcome}\n`);
  }
  if (approve && planId) {
    const view = await approvePlan({ principal, meta: null }, planId, { acknowledge: true });
    process.stdout.write(`\n✔ approved → ${view.status}\n`);
    for (const st of view.steps) process.stdout.write(`  ${st.id}. [${st.result?.status}] ${st.result?.summary ?? ""}${st.result?.check ? ` (verified: ${st.result.verified} — ${st.result.check})` : ""}\n`);
  }
}

main().then(() => closeDb(), async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await closeDb();
  process.exit(1);
});
