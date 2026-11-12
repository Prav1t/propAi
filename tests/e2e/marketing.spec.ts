import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 13: the public landing page. Its previews are interactive and labelled as sample data; its prices come
// from the same plan configuration the product bills with.

test("the landing page explains the product and its building preview responds to clicks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Say what happened.");
  const plan = page.getByTestId("demo-plan");
  await expect(plan).toContainText("The elevator in Tower B is down");
  await expect(page.getByText("A preview with sample data.")).toBeVisible();

  // a spot on the building switches the plan
  await page.getByRole("button", { name: "Leak in 1204: Unit 1204" }).click();
  await expect(plan).toContainText("My kitchen sink is leaking badly");
  await expect(plan).toBeInViewport();
  await expect(plan.getByText("Asks first", { exact: true })).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "Run the plan" })).toBeVisible();

  // a plan with a step that reaches residents waits for approval, then runs step by step
  await page.getByRole("group", { name: "Pick something happening in the building" }).getByRole("button", { name: "Elevator" }).click();
  await expect(plan.getByText("Asks first", { exact: true })).toHaveCount(1);
  await plan.getByRole("button", { name: "Approve the plan" }).click();
  await expect(plan.getByRole("status")).toContainText("Work order #1042 is with the contractor", { timeout: 10_000 });
  await expect(plan.getByText("(done)")).toHaveCount(4);
  await plan.getByRole("button", { name: "Run it again" }).click();
  await expect(plan.getByRole("button", { name: "Approve the plan" })).toBeVisible();
});

test("example requests, roles and questions open by click and by keyboard", async ({ page }) => {
  await page.goto("/");
  const ask = page.getByTestId("ask-panel");
  await expect(ask).toContainText("Answers straight away");
  await page.getByRole("tab", { name: /pool will be closed tomorrow/ }).click();
  await expect(ask).toContainText("Waits for your approval");
  await expect(ask).toContainText("Shows who will receive it");

  const role = page.getByTestId("role-panel");
  await page.getByRole("tab", { name: "Front desk" }).focus();
  await page.keyboard.press("Enter");
  await expect(role).toContainText("Guest passes with QR codes");

  const faq = page.getByText("Does the assistant act on its own?");
  await faq.click();
  await expect(page.getByText(/written to the audit log/)).toBeVisible();
});

test("prices follow the unit count and billing period, using the product's own plan maths", async ({ page }) => {
  await page.goto("/#pricing");
  // 180 units: Starter is base $79 + 130 units above the 50 included at $1 = $209
  await expect(page.getByTestId("unit-count")).toHaveText("180");
  await expect(page.getByTestId("price-starter")).toHaveText("$209");
  await expect(page.getByTestId("price-professional")).toHaveText("$299");
  await expect(page.getByTestId("plan-starter")).toContainText("Fits 180 units");
  // 1,000 units: Starter can't hold it; Professional is $299 + 750 × $0.80 = $899
  await page.getByLabel("How many units do you manage?").fill("1000");
  await expect(page.getByTestId("plan-starter")).toContainText("Holds up to 300 units");
  await expect(page.getByTestId("price-professional")).toHaveText("$899");
  await expect(page.getByTestId("plan-professional")).toContainText("Fits 1,000 units");
  // yearly charges ten months: $8,990 a year, about $749.17 a month
  await page.getByRole("button", { name: "Yearly, 2 months free" }).click();
  await expect(page.getByTestId("price-professional")).toHaveText("$749.17");
  await expect(page.getByTestId("plan-professional")).toContainText("billed $8,990 a year");
});

test("the landing page has no serious accessibility findings, fits a phone, and sends signed-in people to their workspace", async ({ page, browser }) => {
  await page.goto("/");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  await p.goto("/");
  expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(p.getByRole("button", { name: "Party room: Amenity level" })).toBeVisible();
  const dark = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(dark.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
  await phone.close();

  await signIn(page, "pm@demo.test");
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/$/);
});
