"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { archiveConversation } from "@/server/ai/store";
import { aiSettingsSchema, updateAiSettings } from "@/server/ai/usage";
import { runOrgForm } from "@/server/form-action";
import { str, toActionError, type ActionState } from "@/server/actions";

export async function archiveConversationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  try {
    const { ctx } = await getOrgContext(slug);
    await archiveConversation(ctx, str(fd, "conversationId"));
  } catch (e) {
    return toActionError(e, {});
  }
  revalidatePath(`/o/${slug}/assistant`);
  redirect(`/o/${slug}/assistant`);
}

export async function updateAiSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const orgSlug = str(fd, "orgSlug");
  return runOrgForm({
    orgSlug, fd, schema: aiSettingsSchema,
    run: (ctx, data) => updateAiSettings(ctx, data),
    done: () => ({ message: "AI settings saved.", revalidate: [`/o/${orgSlug}/settings/ai`] }),
  });
}
