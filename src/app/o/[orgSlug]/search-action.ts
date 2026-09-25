"use server";
import { getOrgContext } from "@/server/org-context";
import { globalSearch, type SearchHit } from "@/server/modules/search/service";

// backs the Cmd/Ctrl-K palette; results are permission-filtered server-side
export async function searchAction(orgSlug: string, q: string): Promise<SearchHit[]> {
  if (typeof q !== "string" || q.length > 100) return [];
  const { ctx } = await getOrgContext(orgSlug);
  return globalSearch(ctx, q, 5);
}
