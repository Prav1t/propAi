import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 12: saved views, bulk changes, recently viewed records, keyboard shortcuts, the rule flow view, custom
// roles, signed-in members and assistant follow-ups, as people use them.

const ORG = "/o/pacific-properties";
const tag = () => `UX${Math.random().toString(36).slice(2, 7)}`;

async function createWorkOrder(page: Page, title: string) {
  await page.goto(`${ORG}/maintenance/new`);
  await page.getByLabel("Building").selectOption({ index: 1 });
  await page.getByLabel("What's the problem?").fill(title);
  await page.getByLabel("Category").selectOption("cleaning");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("a manager saves the filters they use as a view and comes back to it in one click", async ({ page }) => {
  const name = `Overdue electrical ${tag()}`;
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/maintenance?view=overdue&category=electrical`);
  await page.getByRole("button", { name: /Saved views/ }).click();
  await page.getByLabel("Save the current filters as").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("View saved.")).toBeVisible();
  // from the unfiltered list, the view applies its filters
  await page.goto(`${ORG}/maintenance`);
  await page.getByRole("button", { name: /Saved views/ }).click();
  await page.getByRole("link", { name }).click();
  await expect(page).toHaveURL(/category=electrical/);
  await expect(page).toHaveURL(/view=overdue/);
  await expect(page.getByRole("button", { name: `View: ${name}` })).toBeVisible();
  // and it can be deleted
  await page.getByRole("button", { name: `View: ${name}` }).click();
  await page.getByRole("button", { name: `Delete view ${name}` }).click();
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("a manager changes several work orders at once and sees what happened to each", async ({ page }) => {
  const t = tag();
  await signIn(page, "pm@demo.test");
  await createWorkOrder(page, `Bulk lobby glass ${t}`);
  await createWorkOrder(page, `Bulk stairwell glass ${t}`);
  await page.goto(`${ORG}/maintenance?view=open&q=${t}`);
  await expect(page.getByRole("checkbox", { name: /^Select #\d+/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Select all on this page" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  const bar = page.getByRole("form", { name: "Change selected work orders" });
  await bar.getByLabel("Change", { exact: true }).selectOption("priority");
  await bar.getByLabel("Priority", { exact: true }).selectOption("urgent");
  await bar.getByRole("button", { name: "Apply to 2" }).click();
  await expect(page.getByText("Updated 2 work orders.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: t }).getByText("Urgent")).toHaveCount(2);
  // each change is in that request's own history
  await page.getByRole("link", { name: `Bulk lobby glass ${t}` }).click();
  await expect(page.getByText(/Priority \w+ → urgent\./)).toBeVisible();
});

test("records you opened come back first in the command palette", async ({ page }) => {
  const title = `Recent leak ${tag()}`;
  await signIn(page, "pm@demo.test");
  await createWorkOrder(page, title); // opening it records it
  await page.goto(`${ORG}/dashboard`);
  // a key pressed before the page has hydrated does nothing, so retry until the palette opens
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const option = page.getByRole("option", { name: new RegExp(title) });
  await expect(option).toBeVisible();
  await expect(option).toContainText("Recent · Work order");
  await option.click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("keyboard shortcuts: ? lists them, g + letter goes places", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys go to the page, not a field
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(async () => {
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(dialog.getByText("Go to Tasks")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(new RegExp(`${ORG}/tasks$`));
  // typing in a field never triggers them
  await page.goto(`${ORG}/maintenance`);
  await page.getByRole("searchbox").fill("gt");
  await expect(page).toHaveURL(/maintenance/);
});

test("automation rules read as a flow: what starts them, the checks, each step", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/automations`);
  await page.getByRole("link", { name: /Elevator emergencies/ }).first().click();
  const flow = page.getByTestId("rule-flow");
  await expect(flow).toBeVisible();
  await expect(flow.getByText("When", { exact: true })).toBeVisible();
  await expect(flow.getByText(/Then/).first()).toBeVisible();
  await expect(flow.getByText("Pause for approval")).toBeVisible();
  await expect(flow.getByText("after approval").first()).toBeVisible(); // steps behind the gate
});

test("an admin defines a custom role, edits it and deletes it", async ({ page }) => {
  const name = `Leasing ${tag()}`;
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/roles`);
  await page.getByRole("link", { name: "New role" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Start from (optional)").selectOption({ label: "Concierge" });
  await expect(page.getByText(/\(\d+ chosen\)/)).not.toHaveText("(0 chosen)");
  await page.getByRole("checkbox", { name: "View residents and occupancies" }).check();
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByText("Role saved.")).toBeVisible();
  const role = page.getByTestId("custom-role").filter({ hasText: name });
  await expect(role).toBeVisible();
  await role.locator("summary").click();
  await role.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: `Edit role: ${name}` })).toBeVisible();
  await page.getByRole("checkbox", { name: "View residents and occupancies" }).uncheck();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Role saved.")).toBeVisible();
  await role.locator("summary").click();
  await role.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete role" }).click();
  await expect(page.getByText("Role deleted.")).toBeVisible();
  await expect(page.getByTestId("custom-role").filter({ hasText: name })).toHaveCount(0);
  // the audit log shows it
  await page.goto(`${ORG}/settings/audit`);
  await expect(page.getByText("created a custom role").first()).toBeVisible();
});

test("admins see who is signed in, on which devices", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/security`);
  const panel = page.getByTestId("member-sessions");
  await expect(panel.getByRole("heading", { name: "Signed-in members" })).toBeVisible();
  await expect(panel.getByText("You", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Chrome on Linux · password/).first()).toBeVisible();
});

test("the assistant suggests what to ask next, from what it just looked up", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  const box = page.getByLabel(/^Ask /);
  await box.fill("Show overdue work orders");
  await box.press("Enter");
  const next = page.getByRole("group", { name: "Suggested follow-ups" });
  await expect(next).toBeVisible({ timeout: 20_000 });
  const first = next.getByRole("button").first();
  const q = (await first.textContent())!;
  expect(q).not.toBe("Show overdue work orders"); // never repeats what was asked
  await first.click();
  await expect(page.getByText(q, { exact: true }).first()).toBeVisible();
  // "/" puts the cursor in the question box
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
});
