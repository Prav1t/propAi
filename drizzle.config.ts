import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// migrations run as the schema owner (never the least-privilege app role)
export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL! },
  strict: true,
});
