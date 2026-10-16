"use server";
import { runOrgForm } from "@/server/form-action";
import { analyticsSettingsSchema, saveAnalyticsSettings } from "@/server/analytics/settings";
import type { ActionState } from "@/server/actions";

export async function saveAnalyticsSettingsAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: analyticsSettingsSchema, run: saveAnalyticsSettings, done: () => ({ message: "Saved.", revalidate: [`/o/${slug}`] }) });
}
