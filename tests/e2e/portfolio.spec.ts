import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const code = () => `E${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

test("admin builds a property: property → building → units → resident → search", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  const c = code();
  await page.goto("/o/pacific-properties/properties/new");
  await page.getByLabel("Property name").fill(`E2E Plaza ${c}`);
  await page.getByLabel("Code", { exact: true }).fill(c);
  await page.getByLabel("City").fill("Richmond");
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: `E2E Plaza ${c}` })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("North Tower");
  await page.getByLabel("Code", { exact: true }).fill("N");
  await page.getByLabel("Floors above ground").fill("3");
  await page.getByRole("button", { name: "Add building" }).click();
  await expect(page.getByRole("heading", { name: "North Tower" })).toBeVisible();

  await page.getByLabel("From level").fill("1");
  await page.getByLabel("To level").fill("3");
  await page.getByLabel("Units per floor").fill("4");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("Created 12 units.")).toBeVisible();
  await page.getByRole("link", { name: "204", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unit 204" })).toBeVisible();

  await page.getByRole("link", { name: "Add resident" }).click();
  const last = `Zephyr${c}`;
  await page.getByLabel("First name").fill("Quinn");
  await page.getByLabel("Last name").fill(last);
  await page.getByLabel("Email").fill(`quinn-${c.toLowerCase()}@example.test`);
  await page.getByRole("button", { name: "Add resident" }).click();
  await expect(page.getByRole("heading", { name: `Quinn ${last}` })).toBeVisible();
  await expect(page.getByText("Unit 204", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Search and commands" }).click();
  await page.getByRole("combobox", { name: "Search everything" }).fill(last);
  await expect(page.getByRole("option", { name: new RegExp(`Quinn ${last}`) })).toBeVisible();
  await page.getByRole("option", { name: new RegExp(`Quinn ${last}`) }).click();
  await expect(page).toHaveURL(/\/residents\//);
});

test("Ctrl+K opens the palette and navigates", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto("/o/pacific-properties/dashboard", { waitUntil: "networkidle" }); // shortcut binds after hydration
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox", { name: "Search everything" });
  await expect(box).toBeFocused();
  await box.fill("vendors");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/vendors$/);
});

test("property manager is scoped in lists and cannot create properties", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto("/o/pacific-properties/properties");
  await expect(page.getByRole("link", { name: "Harbour Centre" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pacific Heights" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New property" })).toHaveCount(0);
  expect((await page.goto("/o/pacific-properties/properties/new"))?.status()).toBe(404);
  await page.goto("/o/pacific-properties/units");
  await expect(page.getByLabel("Property")).not.toContainText("Pacific Heights");
});

test("resident sees only their home and finds only their unit @mobile", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/units");
  await expect(page.getByRole("heading", { name: "My home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "1204" })).toBeVisible();
  await expect(page.getByText("1 result")).toBeVisible();
  for (const path of ["residents", "vendors", "properties", "staff"]) {
    expect((await page.goto(`/o/pacific-properties/${path}`))?.status()).toBe(404);
  }
});
