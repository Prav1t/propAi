import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// Fails when a tracked file contains something that looks like a real credential. Complements gitleaks in CI;
// runs anywhere with `npm run security:secrets`. Known development-only values are allow-listed below by exact
// content, so a new real key can't hide behind an allow-listed file.
const PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/],
  ["Stripe test key", /\bsk_test_[0-9a-zA-Z]{20,}\b/],
  ["Stripe webhook secret", /\bwhsec_[0-9a-zA-Z]{24,}\b/],
  ["Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
  ["Slack webhook", /hooks\.slack\.com\/services\/T[0-9A-Z]{6,}\/B[0-9A-Z]{6,}\/[0-9A-Za-z]{16,}/],
  ["GitHub token", /\bgh[pousr]_[0-9A-Za-z]{30,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Twilio key", /\bSK[0-9a-f]{32}\b/],
  ["SendGrid key", /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}\b/],
  ["Resend key", /\bre_[0-9A-Za-z]{8,}_[0-9A-Za-z]{16,}\b/],
  ["Anthropic/OpenAI key", /\bsk-(?:ant-)?[0-9A-Za-z_-]{32,}\b/],
  ["platform API key", /\bak_[a-z0-9]{8}_[A-Za-z0-9_-]{43}\b/],
  ["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@(?!localhost|127\.0\.0\.1|postgres:|db:)[^\s/]+/i],
];

// development-only values that are meant to be public (documented as such where they appear)
const ALLOWED = new Set([
  "ak_demokey1_DEVELOPMENT-ONLY-demo-api-key-do-not-use-00", // seeded demo key, refused in production
]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|zip|woff2?|mp4|mov)$/i.test(f) && !f.startsWith("drizzle/meta/") && f !== "package-lock.json");

const findings: string[] = [];
for (const f of files) {
  let text: string;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      const m = line.match(re);
      if (m && !ALLOWED.has(m[0])) findings.push(`${f}:${i + 1}: ${name}: ${m[0].slice(0, 12)}…`);
    }
  });
}

if (findings.length) {
  console.error(`✗ ${findings.length} possible secret(s) in tracked files:\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ no secrets found in ${files.length} tracked files`);
