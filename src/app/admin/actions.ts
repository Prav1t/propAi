"use server";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { adminSetOrganizationStatus } from "@/server/modules/organizations/service";
import { requestMeta } from "@/server/request-meta";
import { str } from "@/server/actions";

export async function setOrgStatusAction(fd: FormData): Promise<void> {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const status = str(fd, "status") === "active" ? "active" : "suspended";
  await adminSetOrganizationStatus(s.user.id, str(fd, "orgId"), status, await requestMeta());
  revalidatePath("/admin");
}
