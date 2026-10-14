import { expect, test, type Page } from "@playwright/test";
import { reloadUntil, signIn } from "./helpers";

const ORG = "/o/pacific-properties";

async function ask(page: Page, text: string) {
  const box = page.getByLabel(/^Ask /);
  await box.fill(text);
  await box.press("Enter");
}

test("knowledge: a resident gets the party room rules quoted from the documents, with a working citation", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, "What are the rules for booking the party room?");
  await expect(page.locator("article").last().getByText("Searching your documents").first()).toBeVisible({ timeout: 20_000 });
  const answer = page.locator("article").last();
  await expect(answer.getByText(/refundable damage deposit is \$250/)).toBeVisible();
  const cite = answer.getByRole("link", { name: "Party room booking rules · § Approval, fee and deposit" });
  await expect(cite).toBeVisible();
  await cite.click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Party room booking rules" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0); // read-only for residents
});

test("knowledge: a resident never gets a staff-only procedure, and can't open the knowledge base", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, "Where are the Tower B riser valves?");
  await expect(page.locator("article").last().getByText("Searching your documents").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("article").last().getByText(/west wall/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Knowledge base" })).toHaveCount(0);
  const res = await page.goto(`${ORG}/knowledge`);
  expect(res?.status()).toBe(404);
});

test("knowledge: a manager teaches the assistant a new rule, tests it, then disables it", async ({ page }) => {
  const word = `lockerz${Date.now().toString(36)}`;
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/knowledge`);
  await page.getByRole("link", { name: "New entry" }).click();
  await page.getByLabel("Title").fill(`Storage lockers (${word})`);
  await page.getByLabel("Category").selectOption("rules");
  await page.getByLabel("Property", { exact: true }).selectOption({ label: "Fraser Towers" });
  await page.getByLabel("Content").fill(`## Assignment\nStorage lockers are assigned by the office in order of request. The ${word} waitlist is kept at the front desk.\n\n## Fees\nA locker costs $15 a month.`);
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}\?created=1$/);
  const entryUrl = page.url().replace(/\?.*$/, "");
  // indexed right after saving (the worker would pick it up too)
  await reloadUntil(page, async () => (await page.getByText("Indexed", { exact: true }).count()) > 0);
  await expect(page.getByText(/2 passages · version 1/)).toBeVisible();

  await page.goto(`${ORG}/knowledge?test=${encodeURIComponent(`${word} waitlist`)}`);
  const found = page.getByRole("list", { name: "Passages found" });
  await expect(found.getByRole("link", { name: `[1] Storage lockers (${word}) · § Assignment` })).toBeVisible();

  await page.goto(entryUrl);
  await page.getByRole("button", { name: "Disable…" }).click();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByText("Disabled", { exact: true }).first()).toBeVisible();
  await page.goto(`${ORG}/knowledge?test=${encodeURIComponent(`${word} waitlist`)}`);
  await expect(page.getByText(`Storage lockers (${word})`, { exact: false }).first()).toBeVisible(); // still listed for managers
  await expect(page.getByRole("list", { name: "Passages found" })).toHaveCount(0);
});

test("knowledge: a document shows its assistant index status", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/documents`);
  await page.getByRole("link", { name: "Fraser Towers house rules" }).first().click();
  await expect(page.getByRole("heading", { name: "Assistant index" })).toBeVisible();
  await expect(page.getByText("Indexed", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 passage · version 1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-index" })).toBeVisible();
});

test("@mobile resident: ask a rules question on a phone and get a cited answer", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, "Can I have a barbecue on my balcony?");
  const answer = page.locator("article").last();
  await expect(answer.getByText("Barbecues: propane only, rooftop terrace only.")).toBeVisible({ timeout: 20_000 });
  await expect(answer.getByRole("link", { name: "Fraser Towers house rules · p. 1" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
