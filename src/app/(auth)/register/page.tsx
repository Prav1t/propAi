import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create account" };

export default function RegisterPage() {
  const devMailbox = process.env.NODE_ENV !== "production" && (process.env.MAIL_PROVIDER ?? "console") === "console";
  return (
    <AuthCard
      title="Create your account"
      description="Set up your organization in a couple of minutes."
      footer={<>Already have an account? <Link className="text-accent hover:underline" href="/login">Sign in</Link></>}
    >
      <RegisterForm devMailbox={devMailbox} />
    </AuthCard>
  );
}
