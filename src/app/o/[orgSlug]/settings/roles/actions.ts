"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRecentAuth } from "@/server/reauth";
import { getOrgContext } from "@/server/org-context";
import { assertWritable } from "@/server/billing/entitlements";
import { formValues, toActionError, zodFieldErrors, type ActionState } from "@/server/actions";
import { createRole, deleteRole, roleSchema, updateRole } from "@/server/modules/members/roles";

// roles are permissions: defining, changing or deleting one needs a recent sign-in, like changing someone's role (F-09)
const parse = (fd: FormData) => roleSchema.safeParse({ name: fd.get("name"), description: fd.get("description") ?? "", scopeLevel: fd.get("scopeLevel"), permissions: fd.getAll("permissions") });

async function save(slug: string, fd: FormData, run: (ctx: Awaited<ReturnType<typeof getOrgContext>>["ctx"], d: ReturnType<typeof roleSchema.parse>) => Promise<{ id: string }>, done: (id: string) => string): Promise<ActionState> {
  const values = formValues(fd, ["name", "description", "scopeLevel"]);
  const parsed = parse(fd);
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error), values, error: "Check the highlighted fields." };
  await requireRecentAuth(`/o/${slug}/settings/roles`);
  let id: string;
  try {
    const { ctx } = await getOrgContext(slug);
    await assertWritable(ctx.principal.orgId);
    id = (await run(ctx, parsed.data)).id;
  } catch (e) {
    return toActionError(e, values);
  }
  revalidatePath(`/o/${slug}`, "layout");
  redirect(done(id));
}

export async function createRoleAction(slug: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return save(slug, fd, (c, d) => createRole(c, d), (id) => `/o/${slug}/settings/roles?saved=${id}`);
}

export async function updateRoleAction(slug: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return save(slug, fd, async (c, d) => (await updateRole(c, id, d)).role, () => `/o/${slug}/settings/roles?saved=${id}`);
}

export async function deleteRoleAction(slug: string, id: string): Promise<ActionState> {
  await requireRecentAuth(`/o/${slug}/settings/roles`);
  try {
    const { ctx } = await getOrgContext(slug);
    await assertWritable(ctx.principal.orgId);
    await deleteRole(ctx, id);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/o/${slug}`, "layout");
  redirect(`/o/${slug}/settings/roles?deleted=1`);
}
