import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 12 phone passes (Pixel 7 in the "mobile" project; tagged @mobile).

const ORG = "/o/pacific-properties";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "phone layout only"));

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("@mobile front desk staff get their own tab bar", async ({ page }) => {
  await signIn(page, "concierge@demo.test");
  const tabs = page.getByRole("navigation", { name: "Tab bar" });
  await expect(tabs.getByRole("link", { name: "Desk" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Packages" })).toBeVisible();
  await tabs.getByRole("link", { name: "Visitors" }).click();
  await expect(page).toHaveURL(/\/visitors$/);
  await expect(tabs.getByRole("link", { name: "Visitors" })).toHaveAttribute("aria-current", "page");
});

test("@mobile maintenance staff tabs lead to their own jobs and tasks", async ({ page }) => {
  await signIn(page, "staff@demo.test");
  const tabs = page.getByRole("navigation", { name: "Tab bar" });
  await tabs.getByRole("link", { name: "My jobs" }).click();
  await expect(page).toHaveURL(/maintenance\?view=mine/);
  await tabs.getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/tasks\?view=mine/);
});

test("@mobile lists become cards with labelled values, with nothing scrolling sideways", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  for (const path of ["/maintenance", "/tasks?view=all", "/packages", "/residents", "/vendors", "/incidents"]) {
    await page.goto(`${ORG}${path}`);
    await expect(page.locator("table.table-cards").first()).toBeVisible();
    expect(await noSideScroll(page), path).toBeLessThanOrEqual(0);
    // column headings are only for screen readers; each value carries its label instead
    const head = await page.locator("table.table-cards thead").first().boundingBox();
    expect(head?.height ?? 0, path).toBeLessThanOrEqual(1);
  }
  await page.goto(`${ORG}/maintenance`);
  const status = page.locator("table.table-cards td[data-label='Status']").first();
  const before = await status.evaluate((el) => getComputedStyle(el, "::before").content);
  expect(before).toBe('"Status"');
});

test("@mobile buttons and fields are big enough to tap", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/maintenance/new`);
  for (const target of [page.getByRole("button", { name: "Submit request" }), page.getByLabel("What's the problem?"), page.getByLabel("Category")]) {
    const box = await target.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test("@mobile residents can add several photos, see them, and remove one before sending", async ({ page }) => {
  const title = `Photo check ${Math.random().toString(36).slice(2, 7)}`;
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/maintenance/new`);
  await page.getByLabel("What's the problem?").fill(title);
  await expect(page.getByRole("button", { name: "Take photo" })).toBeVisible(); // touch screen
  const files = page.getByLabel("Photos or video (optional)");
  await files.setInputFiles([{ name: "first.png", mimeType: "image/png", buffer: PNG }]);
  await files.setInputFiles([{ name: "second.png", mimeType: "image/png", buffer: PNG }]); // adds, doesn't replace
  await expect(page.getByRole("img", { name: "first.png" })).toBeVisible();
  await expect(page.getByRole("img", { name: "second.png" })).toBeVisible();
  await page.getByRole("button", { name: "Remove first.png" }).click();
  await expect(page.getByRole("img", { name: "first.png" })).toHaveCount(0);
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: /second\.png/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /first\.png/ })).toHaveCount(0);
});
