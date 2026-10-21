import http from "node:http";
import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openEmailLink, signIn, signOut, unique } from "./helpers";

const ORG = "/o/pacific-properties";

test("billing: a new organization's trial → development checkout → Starter → upgrade to Professional", async ({ page }) => {
  test.setTimeout(150_000);
  const email = unique("billing");
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Casey Billing");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a sturdy passphrase 42");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check")).toBeVisible();
  await openEmailLink(page, email, "/verify-email");
  await signIn(page, email, "a sturdy passphrase 42");
  await page.getByRole("link", { name: "Create an organization" }).click();
  await page.getByLabel("Organization name").fill("Casey Rentals");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/casey-rentals[\w-]*\/dashboard/);

  // a free trial of Professional, no card needed
  await page.getByRole("link", { name: "Billing" }).first().click();
  await expect(page.getByRole("heading", { name: "Plan and billing" })).toBeVisible();
  await expect(page.getByText("Development billing: checkout, invoices and renewals are simulated")).toBeVisible();
  await expect(page.getByText("Free trial", { exact: true })).toBeVisible();
  await expect(page.getByText(/No invoices yet — the trial is free\./)).toBeVisible();

  // choose Starter → the development checkout page → confirm
  const starter = page.getByTestId("plan-starter");
  await starter.getByRole("button", { name: "Choose monthly" }).click();
  await expect(page).toHaveURL(/\/settings\/billing\/checkout\?token=/);
  await expect(page.getByText("Development checkout: no card is needed and nothing is charged.")).toBeVisible();
  await expect(page.getByText("Due today")).toBeVisible();
  await expect(page.getByText("$79").last()).toBeVisible();
  await page.getByRole("button", { name: "Confirm (no charge)" }).click();
  await expect(page).toHaveURL(/\/settings\/billing\?checkout=success/);
  await expect(page.getByText("Thanks — your plan is active.")).toBeVisible();
  await expect(starter.getByText("Current")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Paid" })).toHaveCount(1);

  // upgrade: applies right away, with a credit for the unused Starter period
  const pro = page.getByTestId("plan-professional");
  await pro.getByRole("button", { name: "Choose monthly" }).click();
  await expect(page.getByText("You're now on Professional. The invoice for the new period is below.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: "Paid" })).toHaveCount(2);
  await page.getByRole("row").filter({ hasText: "Paid" }).first().getByText("Lines").click();
  await expect(page.getByText("Unused time on Starter plan")).toBeVisible();
});

test("developers: create an API key and a webhook endpoint, create a work order through the API, receive the signed event", async ({ page, request }) => {
  test.setTimeout(150_000);
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(204); res.end(); });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks`;
  try {
    await signIn(page, "admin@demo.test");
    await page.goto(`${ORG}/settings/developers`);
    await expect(page.getByRole("heading", { name: "Developers" })).toBeVisible();

    // an API key: shown once
    if (!(await page.locator("#key-name").isVisible())) await page.getByText("Create an API key").click();
    await page.locator("#key-name").fill(`E2E sync ${Date.now()}`);
    await page.getByRole("checkbox", { name: "Work orders (create)" }).check();
    await page.getByRole("button", { name: "Create API key" }).click();
    const key = (await page.getByTestId("revealed-secret").textContent())!.trim();
    expect(key).toMatch(/^ak_[a-z0-9]{8}_/);
    await expect(page.getByText("API key — copy it now. It won't be shown again.")).toBeVisible();

    // a webhook endpoint for work order events
    if (!(await page.getByLabel("Endpoint URL").isVisible())) await page.getByText("Add an endpoint").click(); // open when there are none yet
    await page.getByLabel("Endpoint URL").fill(hookUrl);
    await page.getByRole("button", { name: "Add endpoint" }).click();
    await expect(page.getByText("Signing secret — copy it now. It won't be shown again.")).toBeVisible();
    const secret = (await page.getByTestId("revealed-secret").filter({ hasText: /^whsec_/ }).textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);

    // the API, as another system would call it
    const title = `Lobby door won't latch ${Date.now()}`;
    const props = await (await request.get("/api/v1/properties", { headers: { authorization: `Bearer ${key}` } })).json();
    const frt = props.data.find((p: { code: string }) => p.code === "FRT");
    const res = await request.post("/api/v1/work-orders", { headers: { authorization: `Bearer ${key}`, "idempotency-key": `e2e-${Date.now()}` }, data: { property_id: frt.id, title, category: "doors_locks" } });
    expect(res.status()).toBe(201);
    const wo = await res.json();
    expect(wo).toMatchObject({ object: "work_order", source: "api", title });

    // the signed event arrives (delivered right after the response)
    await expect.poll(() => received.find((r) => r.body.includes(title)) ? "yes" : "no", { timeout: 30_000 }).toBe("yes");
    const hit = received.find((r) => r.body.includes(title))!;
    const [t, v1] = String(hit.headers["webhook-signature"]).split(",").map((x) => x.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", secret).update(`${t}.${hit.body}`).digest("hex"));
    expect(JSON.parse(hit.body)).toMatchObject({ type: "work_order.created", data: { object: { id: wo.id, title } } });

    // the delivery log shows it, and a test event goes through
    await page.getByRole("link", { name: "Open the endpoint" }).click();
    // first real visit to this dynamic page on a dev server can include a compile
    await expect(page.getByRole("heading", { name: "Webhook endpoint" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("row").filter({ hasText: "work_order.created" }).getByText("Delivered").first()).toBeVisible();
    await page.getByRole("button", { name: "Send a test event" }).click();
    await expect(page.getByText("Delivered — your endpoint answered 204.")).toBeVisible();

    // and the work order is in the app like any other
    await page.goto(`${ORG}/maintenance/${wo.id}`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("integrations, API reference and the platform console", async ({ page }) => {
  await signIn(page, "admin@demo.test");
  await page.goto(`${ORG}/settings/integrations`);
  const slack = page.getByTestId("integration-slack");
  await expect(slack.getByText("Not connected")).toBeVisible();
  await slack.getByLabel("Incoming webhook URL").fill("https://example.com/not-slack");
  await slack.getByRole("button", { name: "Connect" }).click();
  await expect(slack.getByText("Use the https://hooks.slack.com/… URL Slack gives you.").first()).toBeVisible();
  await expect(page.getByText("Coming later")).toBeVisible();
  await expect(page.getByText("Google Calendar")).toBeVisible();

  await page.goto("/developers/api");
  await expect(page.getByRole("heading", { name: /API v1$/ })).toBeVisible();
  await expect(page.getByText("/api/v1/work-orders/{id}/status")).toBeVisible();
  await page.goto(`${ORG}/dashboard`);
  await signOut(page);

  // org admins can't open the platform console; platform admins see plans, revenue and flags
  await signIn(page, "superadmin@demo.test");
  await page.goto("/admin");
  await expect(page.getByText("Recurring revenue (est.)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Feature flags (all organizations)" })).toBeVisible();
  await page.getByRole("link", { name: "Pacific Properties Management" }).click();
  await expect(page.getByRole("heading", { name: "Billing events" })).toBeVisible();
  await expect(page.getByText("mock.checkout.completed")).toBeVisible();
});
