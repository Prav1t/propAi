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
  // security hardening (Iteration 11)
  // reverse proxies in front of the app that append to X-Forwarded-For (see client-ip.ts); or a header the proxy sets
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),
  CLIENT_IP_HEADER: z.string().optional(),
  // shared rate limits across instances; without it limits are per process (fine for one instance)
  REDIS_URL: z.string().url().optional(),
  // encryption keyring: APP_ENCRYPTION_KEY is the current key, named by APP_ENCRYPTION_KEY_ID; retired keys stay
  // readable during a rotation as APP_ENCRYPTION_OLD_KEYS="id:base64key,id2:base64key"
  APP_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/, "letters and digits, at most 16").default("k1"),
  APP_ENCRYPTION_OLD_KEYS: z.string().optional(),
  // sessions slide while used, but never outlive this many days from sign-in
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // single sign-on: http:// issuers are only for local test identity providers (never production)
  OIDC_ALLOW_HTTP_ISSUERS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
}).superRefine((v, c) => {
  if (v.MAIL_PROVIDER === "resend" && !v.RESEND_API_KEY) c.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required when MAIL_PROVIDER=resend" });
  if (v.MAIL_PROVIDER === "sendgrid" && !v.SENDGRID_API_KEY) c.addIssue({ code: "custom", path: ["SENDGRID_API_KEY"], message: "required when MAIL_PROVIDER=sendgrid" });
  if (v.BILLING_PROVIDER === "stripe" && (!v.STRIPE_SECRET_KEY || !v.STRIPE_WEBHOOK_SECRET)) c.addIssue({ code: "custom", path: ["STRIPE_SECRET_KEY"], message: "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe" });
  if (v.NODE_ENV === "production" && v.OIDC_ALLOW_HTTP_ISSUERS) c.addIssue({ code: "custom", path: ["OIDC_ALLOW_HTTP_ISSUERS"], message: "not allowed in production" });
  for (const entry of (v.APP_ENCRYPTION_OLD_KEYS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [id, key] = entry.split(":");
    if (!id || !/^[a-z0-9]{1,16}$/.test(id) || !key || Buffer.from(key, "base64").length !== 32) {
      c.addIssue({ code: "custom", path: ["APP_ENCRYPTION_OLD_KEYS"], message: "use id:base64key pairs (32-byte keys), comma-separated" });
    } else if (id === v.APP_ENCRYPTION_KEY_ID) c.addIssue({ code: "custom", path: ["APP_ENCRYPTION_OLD_KEYS"], message: `"${id}" is the current key id` });
  }
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
    if (cached.NODE_ENV === "production" && cached.TRUSTED_PROXY_HOPS === undefined && !cached.CLIENT_IP_HEADER && process.env.TRUST_PROXY !== "true") {
      // without this, per-IP rate limits and audit IPs rely on a header the client can write (see client-ip.ts)
      console.warn("[config] TRUSTED_PROXY_HOPS is not set: client addresses can't be trusted. Set it to the number of reverse proxies in front of the app.");
    }
  }
  return cached;
}

export const isProd = () => process.env.NODE_ENV === "production";
