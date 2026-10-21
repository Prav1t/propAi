import { chromium, type FullConfig } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DEMO_PASSWORD } from "./helpers";

// The development server compiles each route the first time it's visited — several seconds per route on a small
// machine, more while the browser competes for the CPU. The first test to reach a route used to spend most of its
// timeout waiting for that compile. This visits every page once, signed in as the organization admin, before any
// test runs, so compile time stays out of the tests' timeouts. Routes with an id get a placeholder id: the page
// answers 404, but it has been compiled. On a warm server each visit takes well under a second.
// Skipped against a production build (E2E_BASE_URL) or with E2E_SKIP_WARMUP=1; E2E_WARMUP_ONLY narrows it.

const ORG = "pacific-properties";
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

function pageRoutes(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) {
      if (name === "page.tsx") out.push(base || "/");
      if (name === "route.ts") out.push(`route:${base || "/"}`); // route handlers (assistant stream, API, CSV): a GET compiles them
      continue;
    }
    if (name.startsWith("_") || name.startsWith("@")) continue;
    const segment = name.startsWith("(") ? "" // route groups don't appear in the URL
      : name === "[orgSlug]" ? `/${ORG}`
      : name === "[report]" ? "/maintenance"
      : name === "[token]" ? "/warmup"
      : name.startsWith("[...") ? `/${name}` // kept for route handlers; replaced when requested
      : name.startsWith("[") ? `/${PLACEHOLDER_ID}`
      : `/${name}`;
    out.push(...pageRoutes(full, base + segment));
  }
  return out;
}

export default async function globalSetup(config: FullConfig) {
  if (process.env.E2E_BASE_URL || process.env.E2E_SKIP_WARMUP) return;
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3000";
  const root = config.configFile ? path.dirname(config.configFile) : process.cwd();
  // E2E_WARMUP_ONLY=analytics,brief,…: warm only routes containing one of these fragments (plus sign-in and the
  // dashboard). Used when a memory-limited machine runs the suite in batches with a fresh dev server each.
  const only = process.env.E2E_WARMUP_ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
  const routes = pageRoutes(path.join(root, "src/app")).sort()
    .filter((r) => !only?.length || ["login", "dashboard", ...only].some((f) => r.includes(`/${f}`))); // "/properties" ≠ "/o/pacific-properties"
  const started = Date.now();
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  try {
    const page = await (await browser.newContext({ baseURL })).newPage();
    await page.goto("/login", { timeout: 120_000 });
    await page.getByLabel("Email").fill("admin@demo.test");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 });
    let slow = 0;
    for (const route of routes) {
      const t = Date.now();
      if (route.startsWith("route:")) {
        // a 401/404/405 still compiles the handler; [...path] catch-alls get one segment
        await page.request.get(route.slice(6).replace(/\/\[\.\.\.[^\]]+\]/, "/me"), { timeout: 120_000, maxRedirects: 0 }).catch(() => {});
        if (Date.now() - t > 3_000) slow++;
        continue;
      }
      await page.goto(route, { waitUntil: "load", timeout: 120_000 }).catch(() => {}); // a 404 or redirect still compiles the route
      if (Date.now() - t > 3_000) slow++;
    }
    console.log(`[warm-up] visited ${routes.length} routes (${slow} compiled) in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await browser.close();
  }
}
