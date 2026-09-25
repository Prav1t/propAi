import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { FormAlert } from "@/components/ui/form";
import { verifyEmail } from "@/server/auth/service";

export const metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { token } = await searchParams;
  if (typeof token === "string" && token) {
    const out = await verifyEmail(token);
    if (out.ok) redirect("/login?verified=1");
  }
  return (
    <AuthCard title="Verification link expired" footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}>
      <FormAlert>This verification link is invalid or has already been used. Try signing in — you can request a new link from there.</FormAlert>
    </AuthCard>
  );
}
