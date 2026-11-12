import "dotenv/config";
import { configReport } from "../src/server/ops/config-check";

// `npm run config:check` — what a production start would say about the current environment, without starting.
// Exits 1 when the server would refuse to start. Run it in the release pipeline with the production environment.
const { errors, warnings } = configReport({ ...process.env, NODE_ENV: "production" });
for (const w of warnings) console.log(`warning  ${w}`);
for (const e of errors) console.log(`ERROR    ${e}`);
console.log(errors.length ? `\n${errors.length} problem(s) would stop a production start.` : `\nOK: a production start would be accepted${warnings.length ? ` (${warnings.length} warning(s) to review)` : ""}.`);
process.exit(errors.length ? 1 : 0);
