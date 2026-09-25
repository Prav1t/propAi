"use client";
import { useActionState, useState, useTransition } from "react";
import { beginMfaAction, changePasswordAction, confirmMfaAction, disableMfaAction } from "../actions";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { Field, FormAlert, Input } from "@/components/ui/form";
import { Button, SubmitButton } from "@/components/ui/button";

export function PasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initialActionState);
  return (
    <form action={action} className="max-w-md space-y-4 p-4" key={state.ok ? "done" : "form"}>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Current password" name="current" error={state.fieldErrors?.current}>{(p) => <Input {...p} type="password" autoComplete="current-password" required />}</Field>
      <Field label="New password" name="next" error={state.fieldErrors?.next} hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" required />}</Field>
      <Field label="Confirm new password" name="confirm" error={state.fieldErrors?.confirm}>{(p) => <Input {...p} type="password" autoComplete="new-password" required />}</Field>
      <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
    </form>
  );
}

export function MfaSetup() {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const [state, action] = useActionState(confirmMfaAction, initialActionState);
  const codes = (state.data as { recoveryCodes?: string[] } | undefined)?.recoveryCodes;

  if (codes) {
    return (
      <div className="space-y-3 p-4">
        <FormAlert kind="success">Two-factor authentication is on.</FormAlert>
        <p className="text-sm">Save these recovery codes somewhere safe. Each works once if you lose your device. They won&apos;t be shown again.</p>
        <ul className="grid grid-cols-2 gap-1 rounded-[var(--radius-md)] bg-subtle p-3 font-mono text-[13px] sm:max-w-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
    );
  }
  if (!setup) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted">Protect your account with a code from an authenticator app (1Password, Google Authenticator, Authy…).</p>
        <FormAlert>{err}</FormAlert>
        <Button disabled={pending} onClick={() => start(async () => {
          const r: ActionState = await beginMfaAction();
          if (r.ok) setSetup(r.data as { secret: string; qr: string }); else setErr(r.error);
        })}>{pending ? "Preparing…" : "Set up two-factor authentication"}</Button>
      </div>
    );
  }
  return (
    <div className="grid gap-6 p-4 sm:grid-cols-[180px_1fr]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-[var(--radius-md)] border border-border bg-white" />
      <form action={action} className="space-y-4">
        <p className="text-sm">1. Scan the QR code with your authenticator app, or enter this key manually:</p>
        <code className="block break-all rounded bg-subtle px-2 py-1 font-mono text-[13px]">{setup.secret}</code>
        <p className="text-sm">2. Enter the 6-digit code it shows.</p>
        <FormAlert>{state.error}</FormAlert>
        <Field label="Code" name="code">{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="max-w-[140px]" />}</Field>
        <SubmitButton pendingLabel="Verifying…">Turn on</SubmitButton>
      </form>
    </div>
  );
}

export function MfaDisable({ remaining }: { remaining: number }) {
  const [state, action] = useActionState(disableMfaAction, initialActionState);
  return (
    <form action={action} className="max-w-md space-y-4 p-4">
      <p className="text-sm text-muted">Two-factor authentication is on. {remaining} recovery codes remaining.</p>
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <Field label="Confirm with your password" name="password">{(p) => <Input {...p} type="password" autoComplete="current-password" required />}</Field>
      <SubmitButton variant="danger" pendingLabel="Turning off…">Turn off two-factor</SubmitButton>
    </form>
  );
}
