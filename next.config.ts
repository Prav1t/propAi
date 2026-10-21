import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// baseline CSP; nonce-based strict CSP is planned for the security-hardening iteration
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // unpdf (pdf.js) and mammoth are large; loading them from node_modules keeps them out of every route bundle
  serverExternalPackages: ["@node-rs/argon2", "pg", "unpdf", "mammoth"],
  experimental: {
    // photo/video uploads on requests, incidents and inspections (per-file limits enforced server-side)
    serverActions: { bodySizeLimit: "30mb" },
    // small dev machines / CI containers: DEV_FS_CACHE=off turns off Turbopack's persistent dev cache, whose
    // background snapshots can take several GB on this project (the E2E container has a ~6 GB memory limit)
    ...(process.env.DEV_FS_CACHE === "off" ? { turbopackFileSystemCacheForDev: false } : {}),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
