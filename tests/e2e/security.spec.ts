import { expect, test, type Page } from "@playwright/test";
import { DEMO_PASSWORD, signIn, signOut } from "./helpers";
import { closeOwnerPool, ownerQuery } from "./db";
import { startMockIdp, type MockIdp } from "../support/mock-oidc";

const ORG = "/o/pacific-properties";

// collects CSP violations and script errors while a page is used
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test.afterAll(async () => {
  await closeOwnerPool();
});

test("security headers: strict nonce-based CSP, and the app runs under it without violations", async ({ page, request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  const csp = h["content-security-policy"];
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["permissions-policy"]).toContain("geolocation=()");
  // every script tag carries this response's nonce, and nonces differ per response
  const nonce = csp.match(/'nonce-([^']+)'/)![1];
  const html = await res.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`);
  const again = (await request.get("/login")).headers()["content-security-policy"];
  expect(again.match(/'nonce-([^']+)'/)![1]).not.toBe(nonce);

  const problems = watchConsole(page);
  await signIn(page, "admin@demo.test");
  for (const path of ["/dashboard", "/maintenance", "/analytics", "/assistant", "/calendar"]) {
    await page.goto(`${ORG}${path}`);
    await expect(page.locator("main")).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test("cross-site writes are refused before they reach the app; bearer-token API calls aren't affected", async ({ request }) => {
  const forged = await request.post("/login", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, data: "email=a%40b.c" });
  expect(forged.status()).toBe(403);
  const sameSite = await request.post("/login", { headers: { "sec-fetch-site": "same-site" }, data: "x=1" });
  expect(sameSite.status()).toBe(403); // a sibling subdomain isn't us either
  const api = await request.get("/api/v1/me", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  expect(api.status()).toBe(401); // reached the API (no key), not the proxy's refusal
});

test("sign-in never redirects off-site", async ({ page }) => {
  await page.goto("/login?next=//evil.example/steal");
  await page.getByLabel("Email").fill("pm@demo.test");
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/login/);
  expect(new URL(page.url()).host).toBe("localhost:3000");
});

test("a sensitive change after the re-confirmation window asks for the password, then goes back", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await ownerQuery("update sessions set reauth_at = now() - interval '1 hour' where user_id = (select id from users where email = 'admin@demo.test')");
  await page.goto(`${ORG}/settings/developers`);
  if (!(await page.locator("#key-name").isVisible())) await page.getByText("Create an API key").click();
  await page.locator("#key-name").fill(`Reauth ${Date.now()}`);
  await page.getByRole("button", { name: "Create API key" }).click();
  await expect(page).toHaveURL(/\/account\/confirm\?next=/);
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await page.getByLabel("Password").fill("not the password at all");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("That password isn't right.")).toBeVisible();
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(new RegExp(`${ORG}/settings/developers`));
  if (!(await page.locator("#key-name").isVisible())) await page.getByText("Create an API key").click();
  await page.locator("#key-name").fill(`Reauth ${Date.now()}`);
  await page.getByRole("button", { name: "Create API key" }).click();
  await expect(page.getByText("API key — copy it now. It won't be shown again.")).toBeVisible();
});

test("single sign-on: an admin connects an OpenID Connect provider, staff sign in through it, and the org can require it", async ({ page }) => {
  test.setTimeout(150_000);
  const idp: MockIdp = await startMockIdp();
  try {
    await signIn(page, "admin@demo.test");
    await page.goto(`${ORG}/settings/security`);
    const conn = page.getByTestId("sso-connection");
    await conn.getByLabel("Provider").selectOption("oidc");
    await conn.getByLabel("Tenant ID, Okta domain or issuer URL").fill(idp.issuer);
    await conn.getByLabel("Client ID").fill(idp.clientId);
    await conn.getByLabel("Client secret").fill(idp.clientSecret);
    await conn.getByRole("button", { name: "Set up single sign-on" }).click();
    await expect(conn.getByText("Single sign-on saved.")).toBeVisible();
    await expect(conn.getByText("On", { exact: true })).toBeVisible();
    // proving domain ownership needs real DNS; the domain is marked verified directly for this test
    await page.getByTestId("sso-domains").getByLabel("Domain").fill("demo.test");
    await page.getByTestId("sso-domains").getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByText(/_sso-verification\.demo\.test/)).toBeVisible();
    await ownerQuery("update sso_domains set verified_at = now() where domain = 'demo.test'");
    await signOut(page);

    // a property manager signs in with SSO
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: true });
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in with your organization (SSO)" }).click();
    await page.getByLabel("Work email").fill("pm@demo.test");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(new RegExp(`${ORG}/dashboard`), { timeout: 30_000 });
    await signOut(page);

    // the organization requires SSO for staff: a password sign-in is sent through the provider
    await ownerQuery("insert into org_security_policies (org_id, require_sso) select id, true from organizations where slug = 'pacific-properties' on conflict (org_id) do update set require_sso = true");
    await page.goto(`/login?next=${encodeURIComponent(`${ORG}/maintenance`)}`);
    await page.getByLabel("Email").fill("pm@demo.test");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    // the password session can't open the organization, so the browser goes through the provider and lands where it was going
    await expect(page).toHaveURL(new RegExp(`${ORG}/maintenance`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Maintenance" })).toBeVisible();
    expect((await ownerQuery<{ amr: string[] }>("select amr from sessions where user_id = (select id from users where email = 'pm@demo.test') order by created_at desc limit 1"))[0].amr).toEqual(["sso"]);
  } finally {
    await ownerQuery("update org_security_policies set require_sso = false where org_id = (select id from organizations where slug = 'pacific-properties')");
    await ownerQuery("delete from sso_domains where domain = 'demo.test'");
    await ownerQuery("delete from sso_connections where org_id = (select id from organizations where slug = 'pacific-properties')");
    await idp.close();
  }
});

test("privacy and audit: export a resident's data, and verify the audit log", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/privacy?q=Tremblay`);
  const person = page.getByTestId("privacy-people").locator("li").filter({ hasText: "Emma" }).first();
  await person.getByRole("button", { name: "Export their data" }).click();
  await expect(person.getByText(/Export ready/)).toBeVisible();
  const link = page.getByTestId("privacy-requests").getByRole("link", { name: "Download" }).first();
  const href = (await link.getAttribute("href"))!;
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename="personal-data-emma-tremblay-/);
  const doc = await res.json();
  expect(doc.profile.firstName).toBe("Emma");
  expect(doc.workOrders.length).toBeGreaterThan(0);

  await page.goto(`${ORG}/settings/audit`);
  await page.getByTestId("audit-integrity").getByRole("button", { name: "Verify the audit log" }).click();
  await expect(page.getByText(/All \d+ entries check out/)).toBeVisible();
  await expect(page.getByText("privacy.exported").first()).toBeVisible();
});
