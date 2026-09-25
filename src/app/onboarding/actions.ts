"use server";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { createOrganization, createOrgSchema } from "@/server/modules/organizations/service";
import { requestMeta } from "@/server/request-meta";
import { formValues, str, toActionError, zodFieldErrors, type ActionState } from "@/server/actions";

export async function createOrgAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requireSession();
  const values = formValues(fd, ["name", "kind", "timezone"]);
  const parsed = createOrgSchema.safeParse({ name: str(fd, "name"), kind: str(fd, "kind"), timezone: str(fd, "timezone") });
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values };
  let slug: string;
  try {
    slug = (await createOrganization(session.user.id, parsed.data, await requestMeta())).slug;
  } catch (e) {
    return toActionError(e, values);
  }
  redirect(`/o/${slug}/dashboard`);
}
