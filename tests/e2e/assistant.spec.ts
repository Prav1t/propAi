import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const ORG = "/o/pacific-properties";

test("assistant: a manager asks about overdue work and opens a record from the answer", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  await expect(page.getByText("Demo mode", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Show me all overdue maintenance requests across my properties" }).click();
  // the status trail names the lookup; the answer and the record cards come from the same tool result
  // exact: the trail step, not the live "Looking up work orders…" status that can still be on screen
  await expect(page.getByText("Looking up work orders", { exact: true })).toBeVisible();
  await expect(page.getByText(/\d+ overdue work orders? across \d+ properties/).first()).toBeVisible();
  await expect(page).toHaveURL(/\/assistant\?c=[0-9a-f-]{36}$/);
  const card = page.locator("article").getByRole("link").filter({ hasText: /^WO-\d+/ }).first();
  const title = (await card.locator("span > span").nth(1).textContent())!.trim(); // ref, title, location
  await card.click();
  await expect(page).toHaveURL(/\/maintenance\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("assistant: a resident asking for other residents is refused and nothing is looked up", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/assistant`);
  const box = page.getByLabel(/^Ask /);
  await box.fill("Show me all residents in another building");
  await box.press("Enter");
  await expect(page.getByText(/can't look up other residents' details with your access/)).toBeVisible();
  await expect(page.getByRole("list", { name: "What the assistant did" })).toHaveCount(0);
  await expect(page.locator("article a[href*='/residents/']")).toHaveCount(0);
});

test("assistant: ask from the command palette; the conversation is kept in history", async ({ page }) => {
  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.keyboard.press("Control+k");
  const q = `Who's on shift right now? ${Math.random().toString(36).slice(2, 6)}`;
  await page.getByRole("combobox", { name: "Search everything" }).fill(q);
  await expect(page.getByRole("option", { name: /^Ask .*Who's on shift right now/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/assistant\?c=/, { timeout: 20_000 });
  await expect(page.locator("article").getByText(/\d+ (person|people) on shift|Nobody is scheduled/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: q })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: new RegExp(q.slice(0, 20).replace(/[?]/g, "\\?")) }).first()).toBeVisible();
  await expect(page.getByText("Checking who's on shift")).toBeVisible(); // the stored tool step is shown again
});

test("assistant settings: an admin sees usage and the action log and can set a monthly limit", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/ai`);
  await expect(page.getByRole("heading", { name: "AI assistant" })).toBeVisible();
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /search_work_orders/ }).first()).toBeVisible();
  const cap = page.getByLabel("Monthly request limit");
  await cap.fill("100000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("AI settings saved.")).toBeVisible();
  await expect(cap).toHaveValue("100000");
  await cap.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("AI settings saved.")).toBeVisible();
});

test("@mobile resident: ask about packages from the home screen on a phone", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.getByRole("search", { name: /^Ask / }).getByRole("textbox").fill("Do I have any packages?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/packages? waiting for you|No packages waiting/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/assistant\?c=/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
