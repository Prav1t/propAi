import { ownerDb } from "./lib";
import { keyring } from "../src/server/keyring";
import { keyUsage, resealAll } from "../src/server/keyring-rotation";

// npm run keys:status — which key protects how many secrets; npm run keys:rotate — re-seal everything with the current key
async function main() {
  const { pool } = ownerDb();
  const ring = keyring();
  try {
    if (process.argv.includes("--rotate")) {
      const { resealed, failed } = await resealAll(pool, ring);
      console.log(`✓ re-sealed ${resealed} value(s) with key "${ring.currentId}"`);
      if (failed.length) {
        console.error(`✗ ${failed.length} value(s) couldn't be read — is their old key in APP_ENCRYPTION_OLD_KEYS?\n  ${failed.join("\n  ")}`);
        process.exitCode = 1;
      }
    }
    console.log(`current key: ${ring.currentId}; configured: ${[...ring.keys.keys()].join(", ")}`);
    for (const [col, counts] of Object.entries(await keyUsage(pool))) {
      console.log(`  ${col}: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(", ") || "empty"}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
