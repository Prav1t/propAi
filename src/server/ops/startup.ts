import { configReport } from "./config-check";
import { log } from "../log";

// Called once when a server or worker process starts. In production an unsafe configuration stops the process with
// every problem listed, instead of running with it. ALLOW_INSECURE_PRODUCTION=true turns the stop into a loud warning:
// it exists so the production build can be smoke-tested on a laptop, and must never be set on a real deployment.
export function assertProductionConfig(e: Record<string, string | undefined> = process.env) {
  if (e.NODE_ENV !== "production") return;
  const { errors, warnings } = configReport(e);
  for (const w of warnings) log.warn("config.warning", { detail: w });
  if (!errors.length) return;
  if (e.ALLOW_INSECURE_PRODUCTION === "true") {
    for (const m of errors) log.error("config.unsafe_allowed", { detail: m });
    log.error("config.unsafe_allowed", { detail: "ALLOW_INSECURE_PRODUCTION=true: running with the problems above. Never use this with real data." });
    return;
  }
  for (const m of errors) log.error("config.unsafe", { detail: m });
  throw new Error(`Unsafe production configuration (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n- ${errors.join("\n- ")}\nFix these, or see docs/deployment.md.`);
}
