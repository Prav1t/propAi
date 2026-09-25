import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { FormAlert } from "@/components/ui/form";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Choose a new password" description="Signing in again will be required on all devices." footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}>
      {typeof token === "string" && token ? <ResetForm token={token} /> : <FormAlert>This reset link is invalid.</FormAlert>}
    </AuthCard>
  );
}
