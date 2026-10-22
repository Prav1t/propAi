// Single sign-on (OpenID Connect) shared definitions (Iteration 11)
export const SSO_PROVIDERS = {
  google: { name: "Google Workspace", issuer: () => "https://accounts.google.com", needs: null },
  microsoft: { name: "Microsoft Entra ID", issuer: (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`, needs: "Directory (tenant) ID" },
  okta: { name: "Okta", issuer: (domain: string) => `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`, needs: "Okta domain" },
  oidc: { name: "Other OpenID Connect provider", issuer: (url: string) => url.trim().replace(/\/+$/, ""), needs: "Issuer URL" },
} as const;
export type SsoProvider = keyof typeof SSO_PROVIDERS;
export const SSO_PROVIDER_KEYS = Object.keys(SSO_PROVIDERS) as SsoProvider[];

// TXT record an organization publishes to prove it controls a domain
export const DOMAIN_RECORD_PREFIX = "_sso-verification";
export const domainRecordName = (domain: string) => `${DOMAIN_RECORD_PREFIX}.${domain}`;
export const domainRecordValue = (token: string) => `sso-verification=${token}`;

// shared mailbox providers can't be claimed by one organization
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.ca", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "yandex.com", "zoho.com",
  "fastmail.com", "hey.com", "shaw.ca", "telus.net", "rogers.com", "sympatico.ca", "bell.net",
]);

export function normalizeDomain(raw: string): { domain: string } | { error: string } {
  const d = raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return { error: "Enter a domain like example.com." };
  if (PUBLIC_DOMAINS.has(d)) return { error: `${d} is a shared email provider, so it can't be claimed by one organization.` };
  return { domain: d };
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// identity providers report methods in the ID token's "amr" claim (RFC 8176); any of these means more than a password
const MFA_AMR = new Set(["mfa", "otp", "hwk", "swk", "fpt", "face", "iris", "retina", "vbm", "sms", "tel", "pop", "sc"]);
export const reportsMfa = (amr: unknown) => Array.isArray(amr) && amr.some((m) => typeof m === "string" && MFA_AMR.has(m));
