import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { safeNext } from "@/lib/safe-next";
import { MfaForm } from "./mfa-form";

export const metadata = { title: "Two-factor authentication" };

export default async function MfaPage({ searchParams }: PageProps<"/login/mfa">) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null) ?? undefined;
  return (
    <AuthCard title="Two-factor authentication" description="Enter the code from your authenticator app." footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}>
      <MfaForm next={next} />
    </AuthCard>
  );
}
