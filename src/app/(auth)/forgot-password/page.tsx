"use client";
import Link from "next/link";
import { useActionState } from "react";
import { forgotPasswordAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { AuthCard } from "@/components/auth-card";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export default function ForgotPasswordPage() {
  const [state, action] = useActionState(forgotPasswordAction, initialActionState);
  return (
    <AuthCard title="Reset your password" description="We'll email you a link to choose a new one." footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}>
      {state.ok ? (
        <FormAlert kind="success">{state.message}</FormAlert>
      ) : (
        <form action={action} className="space-y-4" noValidate>
          <Field label="Email" name="email" error={state.fieldErrors?.email}>
            {(p) => <Input {...p} type="email" autoComplete="email" required autoFocus />}
          </Field>
          <SubmitButton className="w-full" pendingLabel="Sending…">Send reset link</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
