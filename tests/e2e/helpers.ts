import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "DemoPass!2026";

export async function signIn(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

export async function signOut(page: Page) {
  // a click that lands before hydration (or during a post-action refresh) doesn't open the menu, so retry
  await expect(async () => {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
}

// follows the newest link emailed to `to` via the development mailbox
export async function openEmailLink(page: Page, to: string, pathPart: string) {
  await page.goto("/dev/mailbox");
  const item = page.locator("li", { hasText: to }).filter({ has: page.locator(`a[href*="${pathPart}"]`) }).first();
  const href = await item.locator(`a[href*="${pathPart}"]`).first().getAttribute("href");
  if (!href) throw new Error(`no ${pathPart} link for ${to}`);
  await page.goto(href);
}

export const unique = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;

// notifications are delivered just after the response; poll briefly instead of sleeping
export async function reloadUntil(page: Page, check: () => Promise<boolean>, tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await page.waitForTimeout(500);
    await page.reload();
  }
}

// YYYY-MM-DD `days` from today in the demo time zone
export function demoDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}
