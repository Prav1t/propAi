import { ownerDb } from "./lib";

// drops and recreates the schema (development only)
async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
  const { pool } = ownerDb();
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.end();
  console.log("✓ database reset");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
