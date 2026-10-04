import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { DeskConsole } from "./desk-console";

export const metadata = { title: "Front desk" };

export default async function DeskPage({ params }: PageProps<"/o/[orgSlug]/desk">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("visitor.manage") && !principal.permissions.has("package.manage")) notFound();
  return <DeskConsole ctx={ctx} principal={principal} orgSlug={orgSlug} />;
}
