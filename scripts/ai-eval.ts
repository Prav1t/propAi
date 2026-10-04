import "dotenv/config";
import { closeDb } from "../src/server/db/client";
import { EVAL_CASES } from "../src/server/ai/eval/cases";
import { checkEvalCase, runEvalCase } from "../src/server/ai/eval/run";
import { providerStatus } from "../src/server/ai/providers";
import { setAiConfigForTests, aiConfig } from "../src/server/ai/config";

// Runs the assistant evaluation suite against the configured provider (or the demo model when none is set):
//   npm run ai:eval            all cases
//   npm run ai:eval -- briefing resident-packages   only these ids
// Exits non-zero when any case fails, so it can gate a model or prompt change in CI.
async function main() {
  setAiConfigForTests({ ...aiConfig(), requestsPerMinute: 1000 });
  const only = process.argv.slice(2);
  const cases = only.length ? EVAL_CASES.filter((c) => only.includes(c.id)) : EVAL_CASES;
  const s = providerStatus();
  console.log(`Evaluating ${cases.length} cases with ${s.provider}/${s.model}${s.demo ? ` (demo mode: ${s.reason})` : ""}\n`);
  let failed = 0;
  for (const c of cases) {
    const run = await runEvalCase(c);
    const problems = checkEvalCase(c, run);
    if (problems.length) failed++;
    console.log(`${problems.length ? "✗" : "✓"} ${c.id.padEnd(26)} ${String(run.ms).padStart(6)} ms  ${run.calls.map((x) => `${x.tool}[${x.outcome}]`).join(" ") || "—"}`);
    for (const p of problems) console.log(`    · ${p}`);
    if (problems.length) console.log(`    answer: ${run.answer.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  return failed;
}

main().then(async (failed) => {
  await closeDb();
  process.exit(failed ? 1 : 0);
}, async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
