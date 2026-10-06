import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

const ORG = "/o/pacific-properties";

async function ask(page: Page, text: string) {
  const box = page.getByLabel(/^Ask /);
  await box.fill(text);
  await box.press("Enter");
}
const plan = (page: Page) => page.getByRole("region", { name: "Prepared changes" }).last();

test("assistant actions: a manager approves a prepared work order and it's created, assigned and linked", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator");
  const card = plan(page);
  await expect(card.getByText("Waiting for your approval")).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText("Create work order “Broken elevator”")).toBeVisible();
  await expect(card.getByText("Assigned to Summit Elevator Services, who is notified")).toBeVisible();
  // the duplicate check ran first and its records are shown
  await expect(page.getByText(/already (a similar open request|\d+ similar open requests)/)).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/Created WO-\d+ “Broken elevator” and assigned it to Summit Elevator Services\./)).toBeVisible();
  await expect(card.getByText(/^Checked: WO-\d+ is on file/)).toBeVisible();
  await expect(card.getByText(/Approved by Marcus Chen/)).toBeVisible();
  await card.getByRole("link", { name: /^Open WO-\d+$/ }).click();
  await expect(page).toHaveURL(/\/maintenance\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Broken elevator" })).toBeVisible();
  await expect(page.getByText("Summit Elevator Services").first()).toBeVisible();
});

test("assistant actions: edit a prepared step, then cancel the plan — nothing is created", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  const title = `Lobby door sticks ${Date.now().toString(36)}`;
  await ask(page, "Create a work order for the broken lobby door at Harbour Centre");
  const card = plan(page);
  await expect(card.getByText("Create work order “Broken lobby door”")).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Edit step 1" }).click();
  await card.getByLabel("Title").fill(title);
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.getByText(`Create work order “${title}”`)).toBeVisible();
  await card.getByRole("button", { name: "Cancel plan" }).click();
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.goto(`${ORG}/maintenance?q=${encodeURIComponent(title)}`);
  await expect(page.getByText(title)).toHaveCount(0);
});

test("assistant actions: plans waiting for approval are listed and open from the sidebar", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  const pending = page.getByRole("region", { name: /Waiting for your approval/ });
  await expect(pending).toBeVisible();
  await pending.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/assistant\?c=/);
  await expect(page.getByRole("region", { name: "Prepared changes" }).filter({ hasText: "Waiting for your approval" }).first()).toBeVisible();
});

test("assistant actions: the organization lets internal tasks run without asking", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  const task = `Restock first-aid kit ${Date.now().toString(36)}`;
  await ask(page, `Create a task to ${task.toLowerCase()} at Harbour Centre by Friday`);
  await expect(page.getByText(/Done \(your organization lets .* do this without asking\): Created the task/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Prepared changes" })).toHaveCount(0);
  await page.locator("article").getByRole("link", { name: new RegExp(task, "i") }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
});

test("assistant actions: a drafted announcement is sent only on approval, and residents see it", async ({ page }) => {
  const about = `the gym will be closed tomorrow for floor repairs ${Date.now().toString(36)}`;
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, `Send residents of Fraser Towers a notice saying ${about}`);
  const card = plan(page);
  await expect(card.getByText("Contacts people")).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/^Hello residents,/)).toBeVisible(); // the full draft is on the card
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText(/^Published “The gym will be closed tomorrow/)).toBeVisible({ timeout: 20_000 });
  await signOut(page);
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/announcements`);
  await expect(page.getByText(new RegExp(about.split(" ").pop()!)).first()).toBeVisible();
});

test("@mobile resident: book the gym from the assistant on a phone", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/assistant`);
  await ask(page, "Book the gym the day after tomorrow at 7 PM");
  const card = plan(page);
  await expect(card.getByText(/^Book Fitness Centre for/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText("Unit 1204 · Tower B · Fraser Towers")).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText(/^Booked #\d+: confirmed\./)).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("assistant settings: an admin sets what the assistant may do", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/ai`);
  await expect(page.getByRole("heading", { name: "What the assistant may do" })).toBeVisible();
  const incidents = page.getByLabel("Report incidents — whole organization");
  await incidents.selectOption("deny");
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Report incidents — whole organization")).toHaveValue("deny");
  // contacting residents can't be set to run on its own
  await expect(page.getByLabel("Send announcements and messages — whole organization").locator("option[value=auto]")).toBeDisabled();
  await page.getByLabel("Report incidents — whole organization").selectOption("default");
  await expect(page.getByText("Saved").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent plans" })).toBeVisible();
});
