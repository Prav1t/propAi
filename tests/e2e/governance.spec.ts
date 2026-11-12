import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 13: strata meetings (agenda, motions, votes, minutes) and leases with rent tracking, as people use them.

const ORG = "/o/pacific-properties";
const tag = () => Math.random().toString(36).slice(2, 7);

test("a council member runs a meeting: agenda, a motion voted and carried, minutes approved and locked", async ({ page }) => {
  const title = `Special council meeting ${tag()}`;
  await signIn(page, "council@demo.test");
  await page.goto(`${ORG}/meetings`);
  // the seeded meeting has motions waiting for votes
  await expect(page.getByTestId("open-motions")).toContainText("2027 operating budget");
  await page.getByRole("link", { name: "Schedule a meeting" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Date and time").fill("2027-01-12T19:00");
  await page.getByLabel("Agenda (one item per line)").fill("Call to order\nRoof repair quote");
  await page.getByRole("button", { name: "Schedule meeting" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("2. Roof repair quote").first()).toBeVisible();

  await page.getByLabel("New motion").fill("That the council accept the roof repair quote from Apex Roofing.");
  await page.getByLabel("Votes needed").selectOption("three_quarters");
  await page.getByRole("button", { name: "Add motion" }).click();
  const motion = page.getByTestId("motion");
  await expect(motion).toContainText("Needs: three-quarters of votes cast.");
  await motion.getByRole("button", { name: "For", exact: true }).click();
  await expect(motion.getByText(/You voted for\./)).toBeVisible();
  await expect(motion).toContainText("1 vote cast so far.");

  // minutes can't be approved while a motion is open or before the meeting is held
  await page.getByRole("button", { name: "Mark as held" }).click();
  await expect(page.getByText("Held", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve the minutes" }).click();
  await page.getByRole("button", { name: "Approve and close the record" }).click();
  await expect(page.getByText(/1 motion is still open/)).toBeVisible();

  await motion.getByText("Record the result of motion 1").click();
  await motion.getByLabel("For", { exact: true }).fill("5");
  await motion.getByLabel("Against").fill("1");
  await motion.getByRole("button", { name: "Record result" }).click();
  await expect(motion.getByText("Carried", { exact: true })).toBeVisible();
  await expect(motion).toContainText("Result: 5 for, 1 against.");

  await page.getByLabel("Present").fill("H. Gill, S. Park, R. Mehta");
  await page.getByLabel("2. Roof repair quote").fill("Two quotes compared. Motion 1 carried.");
  await page.getByRole("button", { name: "Save minutes" }).click();
  await expect(page.getByText("Minutes saved.")).toBeVisible();
  await page.getByRole("button", { name: "Approve and close the record" }).click();
  await expect(page.getByText("Minutes approved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("item-minutes")).toHaveText("Two quotes compared. Motion 1 carried.");
  // the record is closed: nothing left to edit
  await expect(page.getByRole("button", { name: "Add motion" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save minutes" })).toHaveCount(0);
  await expect(page.getByText(/The record no longer changes/)).toBeVisible();
});

test("meetings stay inside their property: a manager of other buildings and a resident can't open them", async ({ page }) => {
  await signIn(page, "council@demo.test");
  await page.goto(`${ORG}/meetings`);
  await page.getByRole("link", { name: "Council meeting, this month" }).click();
  await expect(page.getByRole("heading", { name: "Council meeting, this month" })).toBeVisible();
  const url = page.url();
  await page.context().clearCookies();
  await signIn(page, "pm@demo.test");
  expect((await page.goto(url))?.status()).toBe(404);
  await page.goto(`${ORG}/meetings?view=all`);
  await expect(page.getByText("Council meeting, this month")).toHaveCount(0);
  await page.context().clearCookies();
  await signIn(page, "resident@demo.test");
  expect((await page.goto(`${ORG}/meetings`))?.status()).toBe(404);
  expect((await page.goto(`${ORG}/leases`))?.status()).toBe(404);
});

test("rent: the overdue list leads to a lease where a payment is recorded and the balance follows", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/leases`);
  const summary = page.getByTestId("lease-summary");
  await expect(summary).toContainText("Leases in force");
  await expect(summary).toContainText("Monthly rent roll");
  await page.getByRole("link", { name: /Rent overdue/ }).first().click();
  await expect(page).toHaveURL(/view=overdue/);
  await page.locator("tbody a").first().click();
  await expect(page.getByRole("heading", { name: /^Unit \d+, / })).toBeVisible();
  const row = page.getByTestId("rent-row").filter({ hasText: "Overdue" }).first();
  const month = (await row.locator("td").first().innerText()).split("\n")[0];
  await row.getByText("Record payment").click();
  await row.getByLabel("Amount received ($)").fill("500");
  await row.getByLabel("Note (optional)").fill("e-transfer");
  await row.getByRole("button", { name: "Record" }).click();
  const same = page.getByTestId("rent-row").filter({ hasText: month });
  await expect(same).toContainText("$500");
  await expect(same).toContainText("e-transfer");
  await expect(same).toContainText("Overdue"); // part paid, still past due
  // paying more than is owing is refused with the amount left
  await page.reload();
  await same.getByText("Record payment").click();
  await expect(same.getByLabel("Amount received ($)")).not.toHaveValue("500"); // offers what is left
  await same.getByLabel("Amount received ($)").fill("999999");
  await same.getByRole("button", { name: "Record" }).click();
  await expect(same.getByText(/more than the .* still owing/).first()).toBeVisible();
  // the audit log has it
  await page.goto(`${ORG}/settings/audit`);
  await expect(page.getByText("recorded a rent payment").first()).toBeVisible();
});

test("a new lease: pick a unit without one, name the tenant living there, and rent is charged from the start month", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/leases/new`);
  await page.getByLabel("Property", { exact: true }).selectOption({ label: "Kingsway Residences" });
  await page.getByRole("button", { name: "Show units" }).click();
  // units with nobody recorded as living there are listed, and say so; pick one that has a tenant
  await expect(page.getByLabel("Unit", { exact: true })).toBeEnabled();
  const options = await page.getByLabel("Unit", { exact: true }).locator("option").allInnerTexts();
  expect(options.some((o) => o.includes("nobody recorded"))).toBe(true);
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: options.find((o) => /^\d/.test(o) && !o.includes("nobody recorded"))! });
  await page.getByRole("button", { name: "Use this unit" }).click();
  await expect(page.getByLabel(/^Tenant/)).toBeVisible();
  await page.getByLabel("Monthly rent ($)").fill("abc");
  await page.getByRole("button", { name: "Create lease" }).click();
  await expect(page.getByText("Use a number like 1850 or 1850.50.")).toBeVisible();
  await page.getByLabel("Monthly rent ($)").fill("1925");
  await page.getByLabel("Deposit held ($)").fill("962.50");
  await page.getByRole("button", { name: "Create lease" }).click();
  await expect(page.getByRole("heading", { name: /^Unit \d+, / })).toBeVisible();
  await expect(page.getByText("Month to month", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$962.50")).toBeVisible();
  await expect(page.getByTestId("rent-row")).toHaveCount(1); // this month
  await expect(page.getByTestId("rent-row")).toContainText("$1,925");
  // notice, then the lease shows in "Ending in 60 days"
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("Move-out date").fill(soon);
  await page.getByRole("button", { name: "Record notice" }).click();
  await expect(page.getByText("Notice recorded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change the move-out date" })).toBeVisible();
  const unit = (await page.getByRole("heading", { level: 1 }).innerText()).split(",")[0];
  await page.goto(`${ORG}/leases?view=ending`);
  await expect(page.getByRole("link", { name: new RegExp(`^${unit},`) })).toBeVisible();
});
