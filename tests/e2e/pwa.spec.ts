import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Iteration 12: the installable app. These tests let the service worker run (the other specs block it so that
// page.route() sees every request).
test.use({ serviceWorkers: "allow" });

const ORG = "/o/pacific-properties";

test("the app is installable: manifest with icons, and a service worker", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/orgs", scope: "/" });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  for (const icon of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/offline.html", "/sw.js"]) expect((await request.get(icon)).status(), icon).toBe(200);
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/dashboard`);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});

test("pages opened without a connection show the offline page instead of a browser error", async ({ page, context }) => {
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/dashboard`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // now controlled by the worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.goto(`${ORG}/packages`).catch(() => {});
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).not.toHaveURL(/offline/);
});

test("a request written while offline is kept on the device and sent when the connection returns", async ({ page, context }) => {
  const title = `Offline report ${Math.random().toString(36).slice(2, 7)}`;
  await signIn(page, "resident@demo.test");
  await page.goto(`${ORG}/maintenance/new`);
  await page.getByLabel("What's the problem?").fill(title);
  await page.getByLabel("Details").fill("Written in the elevator with no signal.");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText(/You're offline, so this request is saved on this device/)).toBeVisible();
  const banner = page.getByTestId("draft-sync");
  await expect(banner).toContainText("1 request saved on this device");
  await context.setOffline(false); // the "online" event sends it
  await expect(banner).toContainText(new RegExp(`Sent “${title}” as request #\\d+`), { timeout: 20_000 });
  await banner.getByRole("link", { name: "View" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  // exactly one request, even though the form was submitted once offline and the draft once online
  await page.goto(`${ORG}/maintenance?view=all&q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: title })).toHaveCount(1);
});

test("push notifications can be turned on per device from notification settings", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await signIn(page, "pm@demo.test");
  await page.goto(`${ORG}/notifications?tab=settings`);
  const push = page.getByTestId("push-settings");
  await expect(push).toBeVisible();
  // VAPID keys are configured, so push is offered (subscribing itself needs the browser vendor's push service, which a
  // test machine can't reach; delivery is covered by the integration tests against a local receiver)
  await expect(push.getByText(/aren't set up/)).toHaveCount(0);
  // what's shown follows the browser's real permission state: headless Chromium reports notifications as denied even
  // when granted, and then the page says how to allow them instead of offering a button that can't work
  const permission = await page.evaluate(() => Notification.permission);
  if (permission === "denied") await expect(push.getByText(/Notifications are blocked for this site/)).toBeVisible();
  else await expect(push.getByRole("button", { name: "Turn on for this device" })).toBeVisible();
  // the per-kind Push column appears once this person has a subscribed device (delivery honouring it: ux.test.ts)
  await expect(page.getByRole("columnheader", { name: "Push" })).toHaveCount(0);
});
