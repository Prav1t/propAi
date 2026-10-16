import { expect, test } from "@playwright/test";
import { reloadUntil, signIn, signOut } from "./helpers";

const ORG = "/o/pacific-properties";

test("automation: an admin builds a rule from a template, a resident's emergency pauses for the manager, who approves", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = Math.random().toString(36).slice(2, 7);
  const ruleName = `Elevator emergencies ${tag}`;

  // the admin starts from the template, scopes it to Fraser Towers, tests it and turns it on
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/automations`);
  await page.getByRole("link", { name: /^Elevator emergencies Raise to urgent/ }).click();
  await expect(page.getByRole("heading", { name: "New rule: Elevator emergencies" })).toBeVisible();
  await page.getByLabel("Name").fill(ruleName);
  await page.getByLabel("Property", { exact: true }).selectOption({ label: "Fraser Towers" });
  await expect(page.getByText("When a maintenance request is created at Fraser Towers, if it's marked emergency and category is Elevator:")).toBeVisible();
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByText(/^(This would have|It wouldn't run)/)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Turn on when saved").check();
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("Saved and on.")).toBeVisible();
  await expect(page.getByText("Runs as")).toBeVisible();
  await expect(page.getByText("Priya Sandhu")).toBeVisible();
  await signOut(page);

  // a resident reports a stuck elevator
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/maintenance/new`);
  await page.getByLabel("What's the problem?").fill(`Elevator stuck with doors shut ${tag}`);
  await page.getByLabel("Category").selectOption("elevator");
  await page.getByLabel(/This is an emergency/).check();
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText(/Request #\d+ submitted\. (We|Staff)/)).toBeVisible();
  const ref = (await page.getByText(/Request #\d+ submitted\. (We|Staff)/).textContent())!.match(/#(\d+)/)![1];
  await signOut(page);

  // the property manager finds it waiting for approval, sees what already ran, and approves
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/automations?tab=approvals`);
  await reloadUntil(page, async () => (await page.getByRole("link", { name: ruleName }).count()) > 0);
  await page.getByRole("link", { name: ruleName }).click();
  await expect(page.getByRole("heading", { name: `WO-${ref} Elevator stuck with doors shut ${tag}` })).toBeVisible();
  await expect(page.getByText("Your approval is needed")).toBeVisible();
  await expect(page.getByText(/^Notified .*Marcus Chen/)).toBeVisible();
  await expect(page.getByText("Waiting for Marcus Chen.")).toBeVisible();
  await page.getByLabel("Note (optional)").fill("Summit is on the way");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved — the remaining steps ran.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Approved by Marcus Chen: “Summit is on the way”")).toBeVisible();
  await expect(page.getByText("Notified Emma Tremblay.")).toBeVisible();
  await signOut(page);

  // the resident was told only after the approval, and the analytics page counts the run
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/notifications`);
  await reloadUntil(page, async () => (await page.getByText(`A technician is on the way for WO-${ref}`).count()) > 0);
  await expect(page.getByText(`A technician is on the way for WO-${ref}`).first()).toBeVisible();
  await signOut(page);
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/analytics?period=7d`);
  const completed = page.locator("section", { has: page.getByRole("heading", { name: "Automation" }) }).getByRole("link", { name: /^Completed \d+/ });
  await expect(completed).toBeVisible();
  expect(Number((await completed.textContent())!.match(/Completed\s*(\d+)/)![1])).toBeGreaterThanOrEqual(1);
});

test("automation: a manager can't see another property's rules as editable, and residents can't open automations", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/automations`);
  await expect(page.getByRole("link", { name: "Due-soon warning" })).toBeVisible();
  await expect(page.getByText("Every property · runs as Priya Sandhu · read-only for you").first()).toBeVisible();
  await page.getByRole("link", { name: "Due-soon warning" }).click();
  await expect(page.getByText("Read-only for you", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await signOut(page);
  await signIn(page, "resident@demo.test");
  const res = await page.goto(`${ORG}/automations`);
  expect(res?.status()).toBe(404);
});
