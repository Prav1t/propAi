import { expect, test } from "@playwright/test";
import { demoDate, reloadUntil, signIn, signOut } from "./helpers";

const ORG = "/o/pacific-properties";

test("amenity booking: resident requests the party room → manager approves → resident is notified and cancels", async ({ page }) => {
  // a far-out date keeps reruns away from seeded bookings and the per-unit limit window
  const date = demoDate(45 + Math.floor(Math.random() * 40));
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/amenities`);
  await page.getByRole("link", { name: /Party Room/ }).click();
  await page.getByLabel("Date").fill(date);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${date}`));
  await page.getByLabel("Start").selectOption({ index: 2 + Math.floor(Math.random() * 10) });
  await page.getByLabel("Length").selectOption({ label: "2 h" });
  await page.getByLabel(/People/).fill("12");
  await page.getByLabel("Purpose (optional)").fill("Book club");
  await page.getByRole("button", { name: "Request booking" }).click();
  await expect(page.getByText(/Request sent/)).toBeVisible();
  await expect(page.getByText("Awaiting approval").first()).toBeVisible();
  const bookingUrl = page.url().split("?")[0];
  await signOut(page);

  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/amenities/bookings?view=pending`);
  await page.goto(bookingUrl);
  await page.getByLabel("Note to the resident").fill("Approved — please collect the key from the front desk.");
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByText("Confirmed").first()).toBeVisible();
  await signOut(page);

  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/notifications`);
  const note = page.getByRole("button", { name: /Party Room booking was approved/ }).first();
  await reloadUntil(page, async () => (await note.count()) > 0);
  await note.click();
  await expect(page).toHaveURL(bookingUrl);
  await expect(page.getByText("collect the key").first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel booking…" }).click();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.getByText("Cancelled").first()).toBeVisible();
});

test("packages: the front desk logs a delivery, the resident sees the pickup code, the desk releases it with that code", async ({ page }) => {
  const tracking = `1Z${Array.from({ length: 16 }, () => "0123456789ABCDEFGHJK"[Math.floor(Math.random() * 20)]).join("")}`;
  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/packages`);
  // the intake form sits next to the list's filter bar, which has its own Building select
  const intake = page.locator("form").filter({ has: page.getByRole("button", { name: "Log package" }) });
  await intake.getByLabel("Building").selectOption({ label: "Fraser Towers · Tower B" });
  await intake.getByLabel("Unit", { exact: true }).fill("1204");
  await intake.getByLabel("Tracking number").fill(tracking);
  await expect(intake.getByLabel("Carrier")).toHaveValue("UPS");
  await intake.getByLabel("Shelf / location").fill("E2E");
  await intake.getByRole("button", { name: "Log package" }).click();
  await expect(page.getByText(/Logged for Unit 1204, Tower B. The resident has been notified./)).toBeVisible();
  await signOut(page);

  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/packages`);
  const row = page.locator("li", { hasText: "UPS" }).first();
  await expect(row).toBeVisible();
  const code = (await row.locator("p.font-mono").textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  const href = await row.getByRole("link").first().getAttribute("href");
  await signOut(page);

  await signIn(page, "concierge@demo.test");
  await page.goto(href!);
  await page.getByLabel("Pickup code (optional)").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Release package" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "doesn't match" })).toBeVisible();
  await page.getByLabel("Pickup code (optional)").fill(code);
  await page.getByRole("button", { name: "Release package" }).click();
  await expect(page.getByText("Picked up").first()).toBeVisible();
  await signOut(page);

  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/notifications`);
  await reloadUntil(page, async () => (await page.getByRole("button", { name: /Your package was picked up/ }).count()) > 0);
  await expect(page.getByRole("button", { name: /Your package was picked up/ }).first()).toBeVisible();
});

test("messaging: resident writes, the desk replies with a template, the resident reads the reply; internal notes stay hidden", async ({ page }) => {
  const subject = `Storage locker ${Math.random().toString(36).slice(2, 6)}`;
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/messages/new`);
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Message", { exact: true }).fill("Is there a storage locker available for rent?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  const url = page.url();
  await signOut(page);

  await signIn(page, "concierge@demo.test");
  await page.goto(`${ORG}/messages?view=awaiting`);
  await page.getByRole("link", { name: new RegExp(subject) }).click();
  await page.getByLabel("Message", { exact: true }).fill("INTERNAL: check the locker waitlist");
  await page.getByLabel(/Internal note/).check();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Internal note added.")).toBeVisible();
  await page.getByLabel("Template").selectOption({ label: "Request received" });
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Hi Emma,/);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Sent.")).toBeVisible();
  await signOut(page);

  await signIn(page, "resident@demo.test");
  await page.goto(url);
  await expect(page.getByText(/Thanks for your message/)).toBeVisible();
  await expect(page.getByText("INTERNAL: check the locker waitlist")).toHaveCount(0);
});

test("announcements and documents respect audience", async ({ page }) => {
  const title = `Lobby repaint ${Math.random().toString(36).slice(2, 6)}`;
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/announcements/new`);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Message", { exact: true }).fill("The {{property}} lobby will be repainted on Tuesday.");
  await page.getByLabel("Property").selectOption({ label: "Fraser Towers" });
  await page.getByLabel(/Tower A/).check();
  await page.getByRole("button", { name: "Save announcement" }).click();
  await expect(page.getByText("The Fraser Towers lobby will be repainted on Tuesday.").first()).toBeVisible();
  await signOut(page);

  // Tower A owner sees it and the owners-only bylaws
  await signIn(page, "owner@demo.test");
  await page.goto(`${ORG}/announcements`);
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await page.goto(`${ORG}/documents`);
  await expect(page.getByRole("link", { name: "Strata bylaws (consolidated)" })).toBeVisible();
  await signOut(page);

  // Tower B resident sees neither; can download the house rules PDF
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/announcements`);
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  await page.goto(`${ORG}/documents`);
  await expect(page.getByRole("link", { name: "Strata bylaws (consolidated)" })).toHaveCount(0);
  await page.getByRole("link", { name: "Fraser Towers house rules" }).click();
  const href = await page.getByRole("link", { name: /Download PDF/ }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
});

test("@mobile resident home: package banner and bottom tabs", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await expect(page.getByText(/waiting at the front desk/)).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Tab bar" });
  if (await tabs.isVisible()) {
    await tabs.getByRole("link", { name: /Packages/ }).click();
    await expect(page.getByRole("heading", { name: "My packages" })).toBeVisible();
    // no horizontal scrolling on a phone
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
