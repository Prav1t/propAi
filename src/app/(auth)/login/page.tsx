import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { FormAlert } from "@/components/ui/form";
import { getSession } from "@/server/auth/session";
import { safeNext } from "@/lib/safe-next";
import { LoginForm } from "./login-form";
import { SSO_ERRORS, type SsoErrorCode } from "@/server/sso/service";

export const metadata = { title: "Sign in" };

const DEMO = [
  ["admin@demo.test", "Org admin"], ["pm@demo.test", "Property manager (2 properties)"],
  ["concierge@demo.test", "Concierge"], ["facility@demo.test", "Facility manager (portfolio)"],
  ["staff@demo.test", "Maintenance staff (1 building)"], ["resident@demo.test", "Resident"], ["owner@demo.test", "Owner (strata-style access)"],
  ["vendor@demo.test", "Vendor"], ["superadmin@demo.test", "Platform admin"],
];

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null) ?? undefined;
  if (await getSession()) redirect(next ?? "/orgs");
  const showDemo = process.env.NODE_ENV !== "production" || process.env.SHOW_DEMO_ACCOUNTS === "true";
  return (
    <AuthCard
      title="Sign in"
      description="Welcome back."
      footer={<>New here? <Link className="text-accent hover:underline" href="/register">Create an account</Link></>}
    >
      <div className="space-y-4">
        {sp.verified ? <FormAlert kind="success">Email verified. You can sign in now.</FormAlert> : null}
        {sp.reset ? <FormAlert kind="success">Password updated. Sign in with your new password.</FormAlert> : null}
        {sp.reason === "mfa" ? <FormAlert kind="info">Your organization now requires two-step verification. Sign in again with your authenticator code.</FormAlert> : null}
        {typeof sp.sso_error === "string" && sp.sso_error in SSO_ERRORS ? <FormAlert>{`Single sign-on didn't complete. ${SSO_ERRORS[sp.sso_error as SsoErrorCode]}`}</FormAlert> : null}
        <LoginForm next={next} />
        <p className="text-center text-[13px] text-muted">
          <Link className="text-accent hover:underline" href={next ? `/sso?next=${encodeURIComponent(next)}` : "/sso"}>Sign in with your organization (SSO)</Link>
        </p>
        {showDemo ? (
          <details className="rounded-[var(--radius-md)] border border-dashed border-border-strong p-3 text-[13px]">
            <summary className="cursor-pointer font-medium text-muted">Demo accounts (development only)</summary>
            <p className="mt-2 text-faint">Password for all: <code className="font-mono text-fg">DemoPass!2026</code></p>
            <ul className="mt-2 space-y-1">
              {DEMO.map(([email, role]) => (
                <li key={email} className="flex justify-between gap-2"><code className="font-mono">{email}</code><span className="text-faint">{role}</span></li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </AuthCard>
  );
}
