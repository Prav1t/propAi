import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 12: what people see when something fails or is missing, and changes that show before the server answers.
// Failures are injected with the dev server's fault hook (src/server/dev-faults.ts, E2E_FAULTS=true; inert in production).

const ORG = "/o/pacific-properties";

// adds the fault header to page requests for the dashboard (the document and its server-component fetches)
async function injectFault(page: Page, name: string) {
  await page.route(/\/o\/pacific-properties\/dashboard/, (route) => route.continue({ headers: { ...route.request().headers(), "x-e2e-fault": name } }));
}

test("a page that fails shows what happened, a reference for support, and recovers on retry", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await injectFault(page, "dashboard");
  const res = await page.goto(`${ORG}/dashboard`);
  expect(res?.status()).toBe(500);
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeFocused(); // keyboard users land on the explanation
  await expect(page.getByText(/Reference: \d+/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible(); // the app shell still works
  // the problem clears; "Try again" refetches the page without a reload
  await page.unrouteAll();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
});

test("one failing dashboard section doesn't take the rest of the page with it", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await injectFault(page, "dashboard.attention");
  await page.goto(`${ORG}/dashboard`);
  await expect(page.getByText("Approvals and insights couldn't load.")).toBeVisible();
  await expect(page.getByText(/Reference: \d+/)).toBeVisible();
  await expect(page.getByText("Open work orders")).toBeVisible(); // other sections still load
  await expect(page.getByRole("heading", { name: "Properties" })).toBeVisible();
});

test("missing records and pages keep a real 404 and offer a way back", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  const res = await page.goto(`${ORG}/maintenance/00000000-0000-4000-8000-000000000000`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "We couldn't find that" })).toBeVisible();
  await page.getByRole("link", { name: "Go to dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`${ORG}/dashboard$`));

  const missing = await page.goto("/this-page-does-not-exist");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("ticking a checklist item shows at once and is saved", async ({ page }) => {
  await signIn(page, "staff@demo.test");
  await page.goto(`${ORG}/tasks?view=all&q=${encodeURIComponent("Weekly generator test")}`);
  await page.getByRole("link", { name: "Weekly generator test" }).first().click();
  const first = page.getByRole("checkbox").first();
  const count = page.getByText(/\d of 3 done/);
  const before = Number((await count.textContent())!.split(" ")[0]);
  const wasChecked = await first.isChecked();
  await first.setChecked(!wasChecked);
  // shown before the server answers, then saved ("Saving…" goes away)
  await expect(count).toContainText(`${before + (wasChecked ? -1 : 1)} of 3 done`);
  await expect(count).toHaveText(`${before + (wasChecked ? -1 : 1)} of 3 done`);
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: !wasChecked });
  await page.getByRole("checkbox").first().setChecked(wasChecked); // leave the seed as it was
  await expect(page.getByText(/\d of 3 done/)).toHaveText(`${before} of 3 done`);
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked({ checked: wasChecked });
});

test("mark all read clears unread markers at once and sticks", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/notifications`);
  const markAll = page.getByRole("button", { name: "Mark all read" });
  if (await markAll.isVisible()) {
    await markAll.click();
    await expect(page.getByText("All read")).toBeVisible();
    await expect(page.getByText("(unread)")).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByText("All read")).toBeVisible();
  await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible(); // header bell has no unread count now
});
