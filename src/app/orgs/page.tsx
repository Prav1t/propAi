import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { listMyOrganizations } from "@/server/modules/organizations/principal";
import { SimpleShell } from "@/components/shell/simple-shell";
import { Badge, EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";

export const metadata = { title: "Organizations" };

export default async function OrgsPage({ searchParams }: PageProps<"/orgs">) {
  const session = await requireSession();
  const orgs = await listMyOrganizations(session.user.id);
  const { all } = await searchParams;
  const active = orgs.filter((o) => o.status === "active");
  if (active.length === 1 && !all) redirect(`/o/${active[0].slug}/dashboard`);
  return (
    <SimpleShell user={session.user}>
      <PageHeader title="Your organizations" description="Choose a workspace to continue." actions={<LinkButton href="/onboarding" variant="secondary" size="sm">New organization</LinkButton>} />
      <Panel>
        {orgs.length === 0 ? (
          <EmptyState title="You're not part of an organization yet" action={<LinkButton href="/onboarding">Create an organization</LinkButton>}>
            Create one for your company or building, or ask an administrator to invite you.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {orgs.map((o) => (
              <li key={o.id}>
                {o.status === "active" ? (
                  <Link href={`/o/${o.slug}/dashboard`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-subtle">
                    <span className="text-sm font-medium">{o.name}</span>
                    <span className="text-[13px] text-muted">{o.roleName}</span>
                  </Link>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 opacity-60">
                    <span className="text-sm font-medium">{o.name}</span>
                    <Badge tone="warning">Suspended</Badge>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </SimpleShell>
  );
}
