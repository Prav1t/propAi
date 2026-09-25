"use server";
import { redirect } from "next/navigation";
import { acceptInvitation, acceptInvitationAsNewUser, acceptNewUserSchema } from "@/server/modules/members/service";
import { getSession, setSessionCookie } from "@/server/auth/session";
import { requestMeta } from "@/server/request-meta";
import { formValues, str, toActionError, zodFieldErrors, type ActionState } from "@/server/actions";

export async function acceptInviteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session) redirect("/login");
  let slug: string;
  try {
    slug = (await acceptInvitation(str(fd, "token"), session.user.id, await requestMeta())).orgSlug;
  } catch (e) {
    return toActionError(e);
  }
  redirect(`/o/${slug}/dashboard`);
}

export async function acceptInviteNewUserAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const values = formValues(fd, ["name"]);
  const parsed = acceptNewUserSchema.safeParse({ name: str(fd, "name"), password: str(fd, "password") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  let slug: string;
  try {
    const out = await acceptInvitationAsNewUser(str(fd, "token"), parsed.data, await requestMeta());
    await setSessionCookie(out.sessionToken);
    slug = out.orgSlug;
  } catch (e) {
    return toActionError(e, values);
  }
  redirect(`/o/${slug}/dashboard`);
}
