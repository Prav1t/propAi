import { defineConfig, devices } from "@playwright/test";

// E2E runs against the dev server + the seeded development database (npm run db:reset first for a clean slate)
export default defineConfig({
  testDir: "tests/e2e",
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
    env: { RATE_LIMITS: "relaxed" },
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
