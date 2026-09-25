"use server";
import { revalidatePath } from "next/cache";
import { getOrgContext } from "@/server/org-context";
import { orgSettingsSchema, updateOrganizationSettings } from "@/server/modules/organizations/service";
import {
  changeMemberRole, changeRoleSchema, inviteMember, inviteSchema, revokeInvitation, setMemberStatus,
} from "@/server/modules/members/service";
import { formValues, str, toActionError, zodFieldErrors, type ActionState } from "@/server/actions";

// every action re-resolves the principal from the session; the slug alone grants nothing
export async function updateOrgSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  const values = formValues(fd, ["name", "timezone"]);
  const parsed = orgSettingsSchema.safeParse({ name: str(fd, "name"), timezone: str(fd, "timezone") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  try {
    const { ctx } = await getOrgContext(slug);
    await updateOrganizationSettings(ctx, parsed.data);
  } catch (e) {
    return toActionError(e, values);
  }
  revalidatePath(`/o/${slug}`, "layout");
  return { ok: true, message: "Settings saved." };
}

export async function inviteMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  const values = formValues(fd, ["email", "roleId", "propertyId"]);
  const parsed = inviteSchema.safeParse({ email: str(fd, "email"), roleId: str(fd, "roleId"), propertyId: str(fd, "propertyId") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  try {
    const { ctx } = await getOrgContext(slug);
    await inviteMember(ctx, parsed.data);
  } catch (e) {
    return toActionError(e, values);
  }
  revalidatePath(`/o/${slug}/settings/members`);
  return { ok: true, message: `Invitation sent to ${parsed.data.email}.` };
}

export async function revokeInvitationAction(fd: FormData): Promise<void> {
  const slug = str(fd, "orgSlug");
  const { ctx } = await getOrgContext(slug);
  await revokeInvitation(ctx, str(fd, "invitationId"));
  revalidatePath(`/o/${slug}/settings/members`);
}

export async function changeRoleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  const parsed = changeRoleSchema.safeParse({ membershipId: str(fd, "membershipId"), roleId: str(fd, "roleId"), propertyId: str(fd, "propertyId") });
  if (!parsed.success) return { error: "Choose a role." };
  try {
    const { ctx } = await getOrgContext(slug);
    await changeMemberRole(ctx, parsed.data);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/o/${slug}/settings/members`);
  return { ok: true, message: "Role updated." };
}

export async function setMemberStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  const status = str(fd, "status") === "active" ? "active" : "deactivated";
  try {
    const { ctx } = await getOrgContext(slug);
    await setMemberStatus(ctx, str(fd, "membershipId"), status);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/o/${slug}/settings/members`);
  return { ok: true };
}
