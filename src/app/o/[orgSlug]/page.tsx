import { redirect } from "next/navigation";

export default async function OrgIndex({ params }: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  redirect(`/o/${orgSlug}/dashboard`);
}
