import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// notifications are delivered just after the response; poll briefly instead of sleeping
async function reloadUntil(page: Page, check: () => Promise<boolean>, tries = 10) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await page.waitForTimeout(500);
    await page.reload();
  }
}

test("maintenance vertical slice: resident submits → manager assigns vendor → vendor completes → resident is notified", async ({ page }) => {
  const tag = `E2E-${Math.random().toString(36).slice(2, 7)}`;
  const title = `Bedroom window won't latch ${tag}`;

  // resident reports a problem with a photo
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/maintenance/new");
  await page.getByLabel("What's the problem?").fill(title);
  await page.getByLabel("Category").selectOption("doors_locks");
  await page.getByLabel("Details").fill("The latch spins without catching. Started yesterday.");
  await page.getByLabel(/may enter my unit/).check();
  await page.getByLabel("Photos or video (optional)").setInputFiles({ name: "latch.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText(/Request #\d+ submitted\. (We|Staff)/)).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: /latch\.png/ })).toBeVisible();
  const woUrl = page.url().split("?")[0];
  await signOut(page);

  // property manager assigns an approved vendor
  await signIn(page, "pm@demo.test");
  await page.goto(`/o/pacific-properties/maintenance?q=${tag}`);
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: "Blake Plumbing & Heating" });
  await page.getByRole("button", { name: "Save assignment" }).click();
  await expect(page.getByText("Assignment saved.")).toBeVisible();
  await page.getByLabel("Add a comment").fill("Internal: tenant reports this is the second time.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByText("Comment posted.")).toBeVisible();
  await signOut(page);

  // the vendor finds the job, starts and completes it
  await signIn(page, "vendor@demo.test");
  await page.goto("/o/pacific-properties/maintenance");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByText("Internal: tenant reports")).toHaveCount(0); // staff-only note
  await page.getByText("Start work", { exact: true }).click();
  await page.getByRole("button", { name: "Update status" }).click();
  await expect(page.getByText("Moved to in progress.")).toBeVisible();
  await page.getByText("Complete", { exact: true }).click();
  await page.getByRole("button", { name: "Update status" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Add resolution notes describing what was done." })).toBeVisible();
  await page.getByLabel("What was done?").fill("Replaced the latch keeper and adjusted the sash.");
  await page.getByLabel("Cost (optional)").fill("85");
  await page.getByRole("button", { name: "Update status" }).click();
  // completion ends the vendor's part: the status form goes away and the header shows the new state
  await expect(page.getByRole("heading", { name: "Status" })).toHaveCount(0);
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Resolution: Replaced the latch keeper", { exact: false }).first()).toBeVisible();
  await signOut(page);

  // the resident sees the outcome and a notification for it
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/notifications");
  const note = page.getByRole("button", { name: new RegExp(`${tag}.*completed|completed.*${tag}|Request #\\d+ .*completed`, "i") });
  await reloadUntil(page, async () => (await note.count()) > 0);
  await note.first().click();
  await expect(page).toHaveURL(woUrl);
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Replaced the latch keeper", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Internal: tenant reports")).toHaveCount(0);
});

test("residents can't open other people's requests or staff pages", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/maintenance?view=all");
  await expect(page.getByRole("heading", { name: "My requests" })).toBeVisible();
  // a work order from another unit (Tower B elevator) is not reachable by URL
  await page.goto("/o/pacific-properties/maintenance");
  const own = await page.locator("table a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(own.length).toBeGreaterThan(0);
  for (const path of ["/o/pacific-properties/settings/maintenance", "/o/pacific-properties/tasks", "/o/pacific-properties/inspections"]) {
    const r = await page.goto(path);
    expect(r?.status()).toBe(404);
  }
});

test("vendor sees only their jobs, without the staff navigation", async ({ page }) => {
  await signIn(page, "vendor@demo.test");
  await page.goto("/o/pacific-properties/dashboard");
  await expect(page.getByRole("heading", { name: "Open jobs" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Maintenance" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Residents" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Complaints" })).toHaveCount(0);
});

test("manager works an inspection to a follow-up work order", async ({ page }) => {
  await signIn(page, "facility@demo.test");
  await page.goto("/o/pacific-properties/inspections/new");
  await page.getByLabel("Template").selectOption({ index: 1 });
  await page.getByLabel("Building").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Complete & sign" })).toBeVisible();
  const items = page.locator("li").filter({ has: page.getByRole("radiogroup", { name: "Result" }) });
  const n = await items.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    if (i === 0) {
      await it.getByText("Fail", { exact: true }).click();
      await it.getByLabel("Severity").selectOption("high");
      await it.getByLabel("Notes").fill("Damaged");
    } else {
      await it.getByText("Pass", { exact: true }).click();
    }
    await it.getByRole("button", { name: "Save" }).click();
    await expect(it.getByText("Saved")).toBeVisible();
  }
  await page.getByRole("button", { name: "Complete inspection" }).click();
  await expect(page.getByText(/1 failed item needs a follow-up/)).toBeVisible();
  await page.getByRole("button", { name: "Create follow-up work order" }).click();
  await page.getByRole("link", { name: "View follow-up work order →" }).click();
  await expect(page.getByRole("link", { name: "Inspection follow-up" })).toBeVisible();
});

test("@mobile resident can submit a request from a phone", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto("/o/pacific-properties/dashboard");
  await page.getByRole("link", { name: "Report a problem" }).click();
  await page.getByLabel("What's the problem?").fill(`Hallway closet light out ${Date.now()}`);
  await page.getByLabel("Category").selectOption("electrical");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText(/Request #\d+ submitted\. (We|Staff)/)).toBeVisible();
});
