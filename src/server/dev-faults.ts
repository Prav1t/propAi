import "server-only";
import { headers } from "next/headers";

// Test hook for the error pages: throws at a named point when the request carries `x-e2e-fault: <name>`. Inert unless
// E2E_FAULTS=true outside production (the E2E dev server sets it); a production build never reads the header.
export async function faultPoint(name: string) {
  if (process.env.NODE_ENV === "production" || process.env.E2E_FAULTS !== "true") return;
  if ((await headers()).get("x-e2e-fault") === name) throw new Error(`Injected test fault at ${name}`);
}
