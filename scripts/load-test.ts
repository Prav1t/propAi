import { chromium } from "@playwright/test";

// Small closed-loop load test: N virtual users each request the listed pages one after another for a fixed time.
//   LOAD_BASE=http://localhost:3200 LOAD_USERS=10 LOAD_SECONDS=30 tsx scripts/load-test.ts
// Signs in once through the real sign-in page (LOAD_EMAIL / LOAD_PASSWORD, default the demo property manager), then
// reuses that session. Reports requests/s, error count and p50 / p95 / p99 per page. It measures the server only
// (HTML responses), not rendering in a browser. Point it at a copy of production-sized data, never at production.
const BASE = process.env.LOAD_BASE ?? "http://localhost:3000";
const USERS = Number(process.env.LOAD_USERS) || 10;
const SECONDS = Number(process.env.LOAD_SECONDS) || 30;
const ORG = process.env.LOAD_ORG ?? "pacific-properties";
const PAGES = (process.env.LOAD_PAGES ?? "dashboard,maintenance,maintenance?view=overdue,maintenance?q=leak,maintenance?view=all&page=40,tasks,analytics,residents,search?q=elevator,calendar")
  .split(",").map((p) => `/o/${ORG}/${p.trim()}`);

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function main() {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(process.env.LOAD_EMAIL ?? "pm@demo.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.LOAD_PASSWORD ?? "DemoPass!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await browser.close();

  const times = new Map<string, number[]>(PAGES.map((p) => [p, []]));
  const errors = new Map<string, number>();
  const end = Date.now() + SECONDS * 1000;
  let done = 0;
  const user = async (i: number) => {
    for (let k = i; Date.now() < end; k++) {
      const p = PAGES[k % PAGES.length];
      const t = performance.now();
      try {
        const res = await fetch(`${BASE}${p}`, { headers: { cookie }, redirect: "manual" });
        await res.arrayBuffer(); // the whole streamed page
        if (res.status !== 200) errors.set(`${p} → ${res.status}`, (errors.get(`${p} → ${res.status}`) ?? 0) + 1);
        else times.get(p)!.push(performance.now() - t);
      } catch (e) {
        errors.set(`${p} → ${(e as Error).message}`, (errors.get(`${p} → ${(e as Error).message}`) ?? 0) + 1);
      }
      done++;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
  const secs = (Date.now() - started) / 1000;

  console.log(`${USERS} users for ${secs.toFixed(0)}s against ${BASE}: ${done} requests, ${(done / secs).toFixed(1)}/s, ${[...errors.values()].reduce((a, b) => a + b, 0)} errors\n`);
  console.log("page".padEnd(52) + "n".padStart(6) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "p99 ms".padStart(9));
  for (const [p, list] of times) {
    const s = [...list].sort((a, b) => a - b);
    console.log(p.replace(`/o/${ORG}`, "").padEnd(52) + String(s.length).padStart(6) + pct(s, 50).toFixed(0).padStart(9) + pct(s, 95).toFixed(0).padStart(9) + pct(s, 99).toFixed(0).padStart(9));
  }
  for (const [k, v] of errors) console.log(`error ${k}: ${v}`);
  process.exit(errors.size ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
