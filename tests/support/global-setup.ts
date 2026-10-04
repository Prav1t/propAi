import { execFileSync } from "node:child_process";
import { TEST_ENV } from "./test-env";

// fresh schema → migrate from empty → seed twice (proves seed is repeatable)
export default function setup() {
  const env = { ...process.env, ...TEST_ENV, DOTENV_CONFIG_PATH: "/dev/null" };
  const run = (script: string) => execFileSync("npx", ["tsx", "--conditions=react-server", script], { env, stdio: "pipe" });
  run("scripts/reset.ts");
  run("scripts/migrate.ts");
  run("scripts/seed.ts");
  run("scripts/seed.ts");
}
