"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import type { ActionState } from "@/server/actions";
import { deleteView, saveView } from "@/server/modules/views/service";

// saved views are a person's own list filters: allowed in read-only mode, not audited (no shared data changes)
export async function saveViewAction(slug: string, page: string, query: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return runOrgForm({
    orgSlug: slug, fd, allowReadOnly: true,
    schema: z.object({ name: z.string().trim().min(1, "Name the view.").max(60, "Up to 60 characters.") }),
    run: (c, d) => saveView(c, page, d.name, query),
    done: (r) => ({ message: r.replaced ? "View updated." : "View saved.", revalidate: [] }),
  });
}

export async function deleteViewAction(slug: string, id: string): Promise<ActionState> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { error: "Invalid view." };
  return runOrgForm({ orgSlug: slug, fd: new FormData(), allowReadOnly: true, schema: z.object({}), run: (c) => deleteView(c, id), done: () => ({ message: "View deleted.", revalidate: [] }) });
}
