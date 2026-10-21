import "server-only";
import { z } from "zod";

// validated server environment; fails fast on misconfiguration
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  MAIL_PROVIDER: z.enum(["console", "smtp", "resend", "sendgrid"]).default("console"),
  SMTP_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  // billing (Iteration 10): "mock" is the labelled development provider; production uses Stripe
  BILLING_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // outgoing webhooks may only reach public addresses; local development and tests can allow private ones
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  MAIL_FROM: z.string().default("[YOUR PRODUCT NAME] <no-reply@example.com>"),
  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((v, c) => {
  if (v.MAIL_PROVIDER === "resend" && !v.RESEND_API_KEY) c.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required when MAIL_PROVIDER=resend" });
  if (v.MAIL_PROVIDER === "sendgrid" && !v.SENDGRID_API_KEY) c.addIssue({ code: "custom", path: ["SENDGRID_API_KEY"], message: "required when MAIL_PROVIDER=sendgrid" });
  if (v.BILLING_PROVIDER === "stripe" && (!v.STRIPE_SECRET_KEY || !v.STRIPE_WEBHOOK_SECRET)) c.addIssue({ code: "custom", path: ["STRIPE_SECRET_KEY"], message: "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe" });
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

// lazy so `next build` doesn't need runtime secrets
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProd = () => process.env.NODE_ENV === "production";
