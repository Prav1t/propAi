import { expect, test } from "@playwright/test";
import { authenticator } from "otplib";
import { openEmailLink, signIn, signOut, unique } from "./helpers";

test("protected pages redirect to sign-in and return afterwards", async ({ page }) => {
  await page.goto("/o/pacific-properties/settings/members");
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill("admin@demo.test");
  await page.getByLabel("Password", { exact: true }).fill("DemoPass!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/o\/pacific-properties\/settings\/members$/);
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@demo.test");
  await page.getByLabel("Password", { exact: true }).fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect" })).toHaveText("Incorrect email or password.");
});

test("new user: register → verify → sign in → create org → invite teammate", async ({ page }) => {
  const email = unique("owner");
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Riley Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a sturdy passphrase 42");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check")).toBeVisible();

  // unverified sign-in is refused
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a sturdy passphrase 42");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Verify your email" })).toBeVisible();

  await openEmailLink(page, email, "/verify-email");
  await expect(page).toHaveURL(/\/login\?verified=1/);
  await signIn(page, email, "a sturdy passphrase 42");
  await expect(page.getByText("You're not part of an organization yet")).toBeVisible();

  await page.getByRole("link", { name: "Create an organization" }).click();
  await page.getByLabel("Organization name").fill("Riley Strata Corp");
  await page.getByLabel("Type").selectOption("strata");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/riley-strata-corp[\w-]*\/dashboard/);
  await expect(page.getByText("No properties yet")).toBeVisible();

  await page.getByRole("link", { name: "Members" }).first().click();
  const invitee = unique("mate");
  await page.getByLabel("Email").fill(invitee);
  await page.getByLabel("Role").selectOption({ label: "Accountant" });
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
  await expect(page.getByText(invitee).last()).toBeVisible();

  // invitee accepts as a new user and lands in the org
  await signOut(page);
  await openEmailLink(page, invitee, "/invite/");
  await page.getByLabel("Full name").fill("Mate Accountant");
  await page.getByLabel("Password").fill("another passphrase 77");
  await page.getByRole("button", { name: "Create account and join" }).click();
  await expect(page).toHaveURL(/\/o\/riley-strata-corp[\w-]*\/dashboard/);
  await expect(page.getByText("Accountant")).toBeVisible();
});

test("two-factor: enroll, then sign in with a TOTP code", async ({ page }) => {
  const email = unique("mfa");
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Morgan MFA");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a sturdy passphrase 42");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("for a verification link")).toBeVisible(); // wait for the action to finish
  await openEmailLink(page, email, "/verify-email");
  await signIn(page, email, "a sturdy passphrase 42");

  await page.goto("/account/security");
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const secret = (await page.locator("code").first().textContent())!.trim();
  await page.getByLabel("Code").fill(authenticator.generate(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Two-factor authentication is on.")).toBeVisible();

  await signOut(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a sturdy passphrase 42");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByLabel("Authentication code").fill(authenticator.generate(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/orgs/);
});
