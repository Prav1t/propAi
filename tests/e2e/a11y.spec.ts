import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 12 accessibility checks: axe (WCAG 2.2 A/AA rules) on each role's main pages with zero serious or critical
// violations, and the main flows by keyboard alone. The full page-by-page audit for every role is in
// docs/accessibility.md; this keeps the pages people use most from regressing.

const ORG = "/o/pacific-properties";

async function expectAccessible(page: Page, url: string) {
  const res = await page.goto(url);
  expect(res?.status(), url).toBe(200);
  await page.waitForLoadState("networkidle");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious, url).toEqual([]);
}

// the first link on the page whose path matches, so detail pages are checked with records this role can open
async function firstDetail(page: Page, list: string, pattern: RegExp) {
  await page.goto(list);
  const hrefs = await page.locator("a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  const href = hrefs.find((h) => pattern.test(h));
  if (!href) throw new Error(`no link matching ${pattern} on ${list}`);
  return href;
}

const PAGES: Record<string, string[]> = {
  "pm@demo.test": ["/dashboard", "/maintenance", "/maintenance/new", "/tasks", "/inspections", "/incidents", "/complaints", "/analytics", "/automations", "/amenities/bookings", "/packages", "/residents", "/vendors", "/calendar", "/notifications", "/assistant", "/search?q=fraser"],
  "resident@demo.test": ["/dashboard", "/maintenance", "/maintenance/new", "/amenities", "/packages", "/messages", "/documents", "/visitors", "/parking", "/announcements", "/assistant"],
  "concierge@demo.test": ["/dashboard", "/desk", "/packages", "/visitors", "/visitors/new", "/parking", "/shifts", "/incidents/new"],
  "facility@demo.test": ["/dashboard", "/assets", "/inspections", "/shifts", "/calendar"],
  "vendor@demo.test": ["/dashboard", "/maintenance"],
  "admin@demo.test": ["/settings", "/settings/members", "/settings/roles", "/settings/security", "/settings/privacy", "/settings/audit", "/settings/billing", "/settings/developers", "/knowledge"],
};

for (const [who, pages] of Object.entries(PAGES)) {
  test(`no serious accessibility violations on ${who.split("@")[0]}'s main pages`, async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, who);
    for (const p of pages) await expectAccessible(page, `${ORG}${p}`);
  });
}

test("no serious accessibility violations on detail pages", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "pm@demo.test");
  for (const [list, re] of [["/maintenance", /\/maintenance\/[0-9a-f-]{36}$/], ["/tasks?view=all", /\/tasks\/[0-9a-f-]{36}$/], ["/inspections?view=all", /\/inspections\/[0-9a-f-]{36}$/],
    ["/incidents", /\/incidents\/[0-9a-f-]{36}$/], ["/residents", /\/residents\/[0-9a-f-]{36}$/], ["/vendors", /\/vendors\/[0-9a-f-]{36}$/]] as const) {
    await expectAccessible(page, await firstDetail(page, `${ORG}${list}`, re));
  }
});

test("signed-out pages are accessible too", async ({ page }) => {
  for (const p of ["/login", "/register", "/forgot-password", "/sso"]) await expectAccessible(page, p);
});

test("the command palette and account menu work by keyboard alone, keeping and returning focus", async ({ page }) => {
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/dashboard`);
  const trigger = page.getByRole("button", { name: "Search and commands" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("combobox", { name: "Search everything" });
  await expect(input).toBeFocused();
  // Tab cycles inside the dialog instead of escaping to the page behind it
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // open with the shortcut, type, pick a result with the arrow keys
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  await page.keyboard.type("overdue");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/maintenance\?view=overdue/);

  const account = page.getByRole("button", { name: "Account menu" });
  await account.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Account settings" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Switch organization" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("ArrowDown"); // wraps
  await expect(page.getByRole("menuitem", { name: "Account settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(account).toBeFocused();
});

test("the skip link takes keyboard users past the navigation", async ({ page }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  // the next Tab lands inside the page content, not in the sidebar
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
});

test("a resident can report a problem using only the keyboard", async ({ page }) => {
  const title = `Keyboard-only report ${Math.random().toString(36).slice(2, 7)}`;
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/maintenance/new`);
  const tabTo = async (target: ReturnType<Page["getByLabel"]>, max = 25) => {
    for (let i = 0; i < max && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
  };
  // the form's first field has focus when the page opens
  const field = page.getByLabel("What's the problem?");
  await expect(field).toBeFocused();
  await page.keyboard.type(title);
  // category: a native select changes with the arrow keys
  await tabTo(page.getByLabel("Category"));
  await page.keyboard.press("ArrowDown");
  await tabTo(page.getByLabel("Details"));
  await page.keyboard.type("Dripping under the bathroom sink, reported with the keyboard only.");
  await tabTo(page.getByLabel(/may enter my unit/));
  await page.keyboard.press("Space");
  await expect(page.getByLabel(/may enter my unit/)).toBeChecked();
  const submit = page.getByRole("button", { name: "Submit request" });
  await tabTo(submit as unknown as ReturnType<Page["getByLabel"]>);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("@mobile the navigation drawer keeps focus inside and returns it when closed", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone layout only");
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/dashboard`);
  const open = page.getByRole("button", { name: "Open navigation" });
  await open.click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("@mobile resident pages are accessible on a phone", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone layout only");
  test.setTimeout(120_000);
  await signIn(page, "resident@demo.test");
  for (const p of ["/dashboard", "/maintenance", "/maintenance/new", "/amenities", "/packages", "/messages"]) await expectAccessible(page, `${ORG}${p}`);
});
