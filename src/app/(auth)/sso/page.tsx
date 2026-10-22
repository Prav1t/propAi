import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { safeNext } from "@/lib/safe-next";
import { SsoForm } from "./sso-form";

export const metadata = { title: "Single sign-on" };

export default async function SsoPage({ searchParams }: PageProps<"/sso">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null) ?? undefined;
  return (
    <AuthCard
      title="Sign in with SSO"
      description="Use your work email. If your organization has set up single sign-on, we'll send you to its sign-in page."
      footer={<Link className="text-accent hover:underline" href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>Sign in with a password instead</Link>}
    >
      <SsoForm next={next} />
    </AuthCard>
  );
}
