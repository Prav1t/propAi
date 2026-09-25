"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction, resendVerificationAction } from "../actions";
import { initialActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginAction, initialActionState);
  const [resend, resendAction] = useActionState(resendVerificationAction, initialActionState);
  const unverified = (state.data as { code?: string } | undefined)?.code === "unverified";
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4" noValidate>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <FormAlert>{state.error}</FormAlert>
        <Field label="Email" name="email" error={state.fieldErrors?.email}>
          {(p) => <Input {...p} type="email" autoComplete="email" required defaultValue={state.values?.email} autoFocus />}
        </Field>
        <Field label="Password" name="password" error={state.fieldErrors?.password}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" required />}
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-[13px] text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
        <SubmitButton className="w-full" pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
      </form>
      {unverified ? (
        <form action={resendAction} className="space-y-2">
          <input type="hidden" name="email" value={state.values?.email ?? ""} />
          <FormAlert kind="info">{resend.message}</FormAlert>
          <SubmitButton variant="secondary" className="w-full" pendingLabel="Sending…">
            Resend verification email
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
