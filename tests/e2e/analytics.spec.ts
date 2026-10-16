import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const ORG = "/o/pacific-properties";

test("analytics: a manager filters the dashboard, reads a chart as a table, opens a health breakdown and downloads a report", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/analytics`);
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText("Requests created", { exact: true }).first()).toBeVisible();
  // a property manager only sees their properties
  await expect(page.getByRole("cell", { name: "Pacific Heights" })).toHaveCount(0);

  await page.getByLabel("Period").selectOption("7d");
  await expect(page).toHaveURL(/period=7d/);
  await expect(page.getByText(/^Last 7 days \(/)).toBeVisible();

  const chart = page.locator("figure").first();
  await chart.getByText("Show as table").click();
  await expect(chart.getByRole("columnheader", { name: "Created" })).toBeVisible();
  await expect(chart.getByRole("columnheader", { name: "Completed" })).toBeVisible();

  await page.getByRole("link", { name: "How it's calculated" }).first().click();
  await expect(page.getByRole("heading", { name: /— health$/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Resolved within SLA/ })).toBeVisible();
  await expect(page.getByText("Score = the percentage met.").first()).toBeVisible();

  await page.goto(`${ORG}/analytics/reports/maintenance?period=30d`);
  await expect(page.getByRole("heading", { name: "Maintenance requests" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^maintenance-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("daily brief: the manager opens today's brief and residents can't see analytics", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/brief`);
  await expect(page.getByRole("heading", { name: "Daily brief" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for your approval" })).toBeVisible(); // the seeded elevator emergency
  await page.goto(`${ORG}/assistant`);
  const box = page.getByLabel(/^Ask /);
  await box.fill("How much did maintenance spending change this quarter?");
  await box.press("Enter");
  await expect(page.locator("article").last().getByText(/^Maintenance spend: \$[\d,.]+ from \d{4}-10-01 to/)).toBeVisible({ timeout: 20_000 });
});

test("@mobile manager: analytics on a phone without horizontal scrolling", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/analytics`);
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requests created and completed" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("residents can't open analytics or the brief", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  expect((await page.goto(`${ORG}/analytics`))?.status()).toBe(404);
  expect((await page.goto(`${ORG}/brief`))?.status()).toBe(404);
});
