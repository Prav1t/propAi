"use server";
import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { requireSession } from "@/server/auth/session";
import {
  beginMfaEnrollment, changePassword, confirmMfaEnrollment, disableMfa, revokeMySession, revokeOtherSessions, updateProfile,
} from "@/server/auth/service";
import { requestMeta } from "@/server/request-meta";
import { str, toActionError, type ActionState } from "@/server/actions";

export async function updateProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession();
  const out = await updateProfile(s.user.id, str(fd, "name"), await requestMeta());
  if (!out.ok) return { fieldErrors: { name: out.message } };
  revalidatePath("/", "layout");
  return { ok: true, message: "Profile saved." };
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession();
  if (str(fd, "next") !== str(fd, "confirm")) return { fieldErrors: { confirm: "Passwords don't match." } };
  const out = await changePassword(s.user.id, str(fd, "current"), str(fd, "next"), s.sessionId, await requestMeta());
  if (!out.ok) return out.code === "invalid_password" ? { fieldErrors: { current: out.message } } : { fieldErrors: { next: out.message } };
  return { ok: true, message: "Password changed. Other devices have been signed out." };
}

export async function beginMfaAction(): Promise<ActionState> {
  const s = await requireSession();
  try {
    const { secret, uri } = await beginMfaEnrollment(s.user.id);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 180 });
    return { ok: true, data: { secret, qr } };
  } catch (e) {
    return toActionError(e);
  }
}

export async function confirmMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession();
  const out = await confirmMfaEnrollment(s.user.id, str(fd, "code"), await requestMeta());
  if (!out.ok) return { error: out.message };
  revalidatePath("/account/security");
  return { ok: true, data: { recoveryCodes: out.recoveryCodes } };
}

export async function disableMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession();
  const out = await disableMfa(s.user.id, str(fd, "password"), await requestMeta());
  if (!out.ok) return { error: out.message };
  revalidatePath("/account/security");
  return { ok: true, message: "Two-factor authentication turned off." };
}

export async function revokeSessionAction(fd: FormData): Promise<void> {
  const s = await requireSession();
  const id = str(fd, "sessionId");
  if (id && id !== s.sessionId) await revokeMySession(s.user.id, id);
  revalidatePath("/account/security");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const s = await requireSession();
  await revokeOtherSessions(s.user.id, s.sessionId);
  revalidatePath("/account/security");
}
