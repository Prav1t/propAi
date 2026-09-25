import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("org admin sees the whole portfolio and admin navigation", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto("/o/pacific-properties/dashboard");
  const table = page.getByRole("table");
  for (const name of ["Harbour Centre", "Pacific Heights", "Fraser Towers", "Kingsway Residences"]) await expect(table.getByText(name)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const item of ["General", "Members", "Roles", "Audit log"]) await expect(nav.getByRole("link", { name: item })).toBeVisible();
});

test("property manager sees only assigned properties and no admin pages", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto("/o/pacific-properties/dashboard");
  const table = page.getByRole("table");
  await expect(table.getByText("Harbour Centre")).toBeVisible();
  await expect(table.getByText("Fraser Towers")).toBeVisible();
  await expect(table.getByText("Pacific Heights")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "General" })).toHaveCount(0);
  // server enforces it too: direct URLs 404
  for (const path of ["/o/pacific-properties/settings", "/o/pacific-properties/settings/audit"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
  }
});

test("cross-tenant URLs return 404", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  const res = await page.goto("/o/northshore-strata/dashboard");
  expect(res?.status()).toBe(404);
});

test("platform admin console is invisible to org admins", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
});

test("resident sees only their home on mobile @mobile", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/dashboard");
  await expect(page.getByText("Unit 1204")).toBeVisible();
  await expect(page.getByText("Tower B · Fraser Towers")).toBeVisible();
  const res = await page.goto("/o/pacific-properties/settings/members");
  expect(res?.status()).toBe(404);
});
