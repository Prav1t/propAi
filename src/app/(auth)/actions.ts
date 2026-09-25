"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  login, loginSchema, register, registerSchema, requestPasswordReset, resendVerification, resetPassword,
  revokeSession, verifyMfaLogin, emailSchema,
} from "@/server/auth/service";
import { clearSessionCookie, getSession, MFA_COOKIE, setMfaCookie, setSessionCookie } from "@/server/auth/session";
import { requestMeta } from "@/server/request-meta";
import { formValues, str, toActionError, zodFieldErrors, type ActionState } from "@/server/actions";
import { safeNext } from "@/lib/safe-next";

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const values = formValues(fd, ["email"]);
  const parsed = loginSchema.safeParse({ email: str(fd, "email"), password: str(fd, "password") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  const next = safeNext(str(fd, "next"));
  try {
    const out = await login(parsed.data, await requestMeta());
    if (!out.ok) return { error: out.message, values, data: { code: out.code } };
    if (out.kind === "mfa") {
      await setMfaCookie(out.challengeToken);
      redirect(`/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}`);
    }
    await setSessionCookie(out.token);
  } catch (e) {
    return toActionError(e, values);
  }
  redirect(next ?? "/orgs");
}

export async function mfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const jar = await cookies();
  const challenge = jar.get(MFA_COOKIE)?.value;
  if (!challenge) return { error: "Your sign-in attempt expired. Sign in again." };
  const next = safeNext(str(fd, "next"));
  try {
    const out = await verifyMfaLogin(challenge, str(fd, "code"), await requestMeta());
    if (!out.ok) return { error: out.message };
    if (out.kind !== "session") return { error: "Unexpected state. Sign in again." };
    jar.delete(MFA_COOKIE);
    await setSessionCookie(out.token);
  } catch (e) {
    return toActionError(e);
  }
  redirect(next ?? "/orgs");
}

export async function registerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const values = formValues(fd, ["name", "email"]);
  const parsed = registerSchema.safeParse({ name: str(fd, "name"), email: str(fd, "email"), password: str(fd, "password") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  try {
    const out = await register(parsed.data, await requestMeta());
    if (!out.ok) return { error: out.message, values };
    return { ok: true, values: { email: parsed.data.email } };
  } catch (e) {
    return toActionError(e, values);
  }
}

export async function resendVerificationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = emailSchema.safeParse(str(fd, "email"));
  if (!email.success) return { error: "Enter a valid email address." };
  await resendVerification(email.data, await requestMeta());
  return { ok: true, message: "If that account needs verification, we've sent a new link." };
}

export async function forgotPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = emailSchema.safeParse(str(fd, "email"));
  if (!email.success) return { fieldErrors: { email: "Enter a valid email address." } };
  await requestPasswordReset(email.data, await requestMeta());
  return { ok: true, message: "If an account exists for that email, we've sent a reset link. It expires in 1 hour." };
}

const resetSchema = z.object({ token: z.string().min(10), password: z.string(), confirm: z.string() });

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const p = resetSchema.safeParse({ token: str(fd, "token"), password: str(fd, "password"), confirm: str(fd, "confirm") });
  if (!p.success) return { error: "This reset link is invalid." };
  if (p.data.password !== p.data.confirm) return { fieldErrors: { confirm: "Passwords don't match." } };
  const out = await resetPassword(p.data.token, p.data.password, await requestMeta());
  if (!out.ok) return out.code === "weak_password" ? { fieldErrors: { password: out.message } } : { error: out.message };
  redirect("/login?reset=1");
}

export async function logoutAction(): Promise<void> {
  const s = await getSession();
  if (s) await revokeSession(s.sessionId);
  await clearSessionCookie();
  redirect("/login");
}
