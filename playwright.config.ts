import { defineConfig, devices } from "@playwright/test";

// E2E runs against the dev server + the seeded development database (npm run db:reset first for a clean slate)
export default defineConfig({
  testDir: "tests/e2e",
  // compiles every route on the dev server before the tests (see the file)
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  // the dev server compiles a route on first visit, which can take a few seconds
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: "npm run dev",
    // local webhook receivers in the API → webhook test listen on 127.0.0.1 (never allowed in production);
    // DEV_FS_CACHE=off keeps the dev server inside small CI memory limits (see next.config.ts)
    // OIDC_ALLOW_HTTP_ISSUERS: the SSO test runs a local OpenID Connect provider on http://127.0.0.1 (refused in production)
    env: { RATE_LIMITS: "relaxed", WEBHOOK_ALLOW_PRIVATE_TARGETS: "true", DEV_FS_CACHE: "off", OIDC_ALLOW_HTTP_ISSUERS: "true" },
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
