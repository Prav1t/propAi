import { expect, test } from "@playwright/test";
import { reloadUntil, signIn, signOut } from "./helpers";

const ORG = "/o/pacific-properties";

test("guest pass: resident invites → guest opens the pass → desk scans and checks in → resident is told", async ({ page, browser }) => {
  const guest = `Pat Guest ${Math.random().toString(36).slice(2, 6)}`;
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/visitors/new`);
  await page.getByLabel("Visitor's name").fill(guest);
  await page.getByRole("button", { name: "Create guest pass" }).click();
  const card = page.getByLabel("Guest pass");
  await expect(card.getByRole("img", { name: "QR code for the guest pass" })).toBeVisible();
  const passUrl = await page.getByLabel("Pass link").inputValue();
  expect(passUrl).toMatch(/\/pass\/[A-Za-z0-9_-]{32}$/);
  await signOut(page);

  // the guest's phone: no account needed, minimal details
  const phone = await browser.newContext();
  const guestPage = await phone.newPage();
  await guestPage.goto(new URL(passUrl).pathname);
  await expect(guestPage.getByRole("heading", { name: `${guest.split(" ")[0]} ${guest.split(" ").at(-1)![0]}.` })).toBeVisible();
  await expect(guestPage.getByText("Valid", { exact: true })).toBeVisible();
  await expect(guestPage.getByText("Tower B · Fraser Towers")).toBeVisible();
  await expect(guestPage.getByText(/1204|Emma/)).toHaveCount(0);
  await phone.close();

  // the desk scans the pass (a handheld scanner types the link)
  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/desk`);
  await page.getByLabel("Guest pass").fill(passUrl);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Pass scanned.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: guest })).toBeVisible();
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/Checked in/).first()).toBeVisible();
  await page.goto(`${ORG}/desk`);
  await expect(page.getByRole("link", { name: guest })).toBeVisible();
  await signOut(page);

  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/notifications`);
  const note = page.getByRole("button", { name: new RegExp(`${guest} has arrived`) });
  await reloadUntil(page, async () => (await note.count()) > 0);
  await expect(note.first()).toBeVisible();
});

test("parking: a report is reviewed before the owner gets a notice", async ({ page }) => {
  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/parking/violations/new?plate=WLM805`);
  await expect(page.getByLabel("Licence plate")).toHaveValue("WLM805");
  await page.getByLabel("What's wrong").selectOption({ label: "Wrong space" });
  await page.getByLabel("Space (optional)").fill("P1-020");
  await page.getByLabel("Details").fill("Parked in P1-020, which is assigned to another unit.");
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("heading", { name: /Wrong space · WLM 805/ })).toBeVisible();
  await expect(page.getByText("Registered to")).toBeVisible();
  const reportUrl = page.url();
  await signOut(page);

  await signIn(page, "pm@demo.test");
  await page.goto(reportUrl);
  await page.getByLabel("Decision").selectOption("confirm");
  await page.getByRole("button", { name: "Save review" }).click();
  // the review form gives way to the notice form once confirmed
  await expect(page.getByRole("heading", { name: "Issue a notice" })).toBeVisible();
  await page.getByRole("button", { name: "Issue notice" }).click();
  await expect(page.getByText("Notice issued").first()).toBeVisible();
  await signOut(page);

  await signIn(page, "owner@demo.test");
  await page.goto(`${ORG}/parking`);
  await expect(page.getByRole("heading", { name: "My parking" })).toBeVisible();
  await page.getByRole("link", { name: /Notice #\d+ · WLM 805 · Wrong space/ }).first().click();
  await expect(page.getByRole("heading", { name: "Parking notice for WLM 805" })).toBeVisible();
  await expect(page.getByText("Evidence")).toHaveCount(0);
});

test("facility: preventive maintenance on demand and an outage with downtime", async ({ page }) => {
  await signIn(page, "facility@demo.test");
  await page.goto(`${ORG}/assets?q=generator`);
  await page.getByRole("link", { name: "Emergency generator" }).click();
  await expect(page.getByRole("heading", { name: "Emergency generator" })).toBeVisible();
  await expect(page.getByText("Monthly generator load test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create now" }).click();
  await expect(page).toHaveURL(/\/maintenance\//);
  await expect(page.getByRole("heading", { name: /Monthly generator load test — Emergency generator/ })).toBeVisible();
  await expect(page.getByText("Preventive maintenance schedule", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Emergency generator" }).click();
  await page.getByLabel("Status").selectOption("down");
  await page.getByLabel("What's wrong / note").fill("Fails to start on test");
  await page.getByRole("button", { name: "Update status" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Out of service since" })).toBeVisible();
  await page.getByLabel("Status").selectOption("operational");
  await page.getByRole("button", { name: "Update status" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Out of service since" })).toHaveCount(0);
  await expect(page.getByText("Fails to start on test").first()).toBeVisible(); // kept in the downtime history
});

test("shift handoff: the desk writes it, the manager acknowledges it", async ({ page }) => {
  const note = `Handoff ${Math.random().toString(36).slice(2, 7)}: courier for 1204 returns at 9.`;
  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/shifts/handoff`);
  await expect(page.getByText("Packages waiting").first()).toBeVisible();
  await page.getByLabel("Notes for the next shift").fill(note);
  await page.getByRole("button", { name: "Save handoff" }).click();
  await expect(page.getByText("Handoff saved.", { exact: false })).toBeVisible();
  await expect(page.getByText(note)).toBeVisible();
  await signOut(page);

  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/shifts/handoff`);
  const item = page.locator("li").filter({ hasText: note });
  await item.getByRole("button", { name: "Acknowledge" }).click();
  await expect(item.getByText(/Read by Marcus Chen/)).toBeVisible();
});

test("@mobile resident: invite a guest and see parking on a phone", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.getByRole("link", { name: "Invite a guest" }).click();
  await page.getByLabel("Visitor's name").fill(`Phone Guest ${Date.now() % 10000}`);
  await page.getByRole("button", { name: "Create guest pass" }).click();
  await expect(page.getByRole("img", { name: "QR code for the guest pass" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.goto(`${ORG}/parking`);
  await expect(page.getByText("Space P2-014", { exact: true })).toBeVisible();
  await expect(page.getByText("KX7 42M").first()).toBeVisible();
});
