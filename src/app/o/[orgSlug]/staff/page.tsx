import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listStaff } from "@/server/modules/people/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Avatar, Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";
import { SYSTEM_ROLES } from "@/server/authz/system-roles";
import { EMPLOYMENT_LABEL } from "@/lib/labels";

export const metadata = { title: "Staff" };

export default async function StaffPage({ params, searchParams }: PageProps<"/o/[orgSlug]/staff">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const rows = await orNotFound(listStaff(ctx, { q: sp(q.q), roleKey: sp(q.role), propertyId: sp(q.property) }));
  const props = await listPropertyOptions(ctx);
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title="Staff" description="Your team, their roles, coverage and skills." />
      <Panel>
        <FilterBar searchPlaceholder="Name, email or skill…" filters={[
          { name: "role", label: "Role", options: SYSTEM_ROLES.filter((r) => r.category === "staff").map((r) => ({ value: r.key, label: r.name })) },
          { name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) },
        ]} />
        {rows.length === 0 ? <EmptyState title="No staff found" /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Role</Th><Th className="hidden md:table-cell">Coverage</Th><Th className="hidden lg:table-cell">Skills</Th><Th className="hidden sm:table-cell">Phone</Th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.membershipId} className={s.status !== "active" ? "opacity-60" : "hover:bg-subtle/60"}>
                  <Td>
                    <Link href={`${base}/staff/${s.membershipId}`} className="flex items-center gap-2.5">
                      <Avatar name={s.name} />
                      <span className="min-w-0"><span className="block truncate font-medium hover:underline">{s.name}{s.membershipId === principal.membershipId ? <span className="font-normal text-faint"> (you)</span> : null}</span><span className="block truncate text-xs text-faint">{s.title ?? s.email}</span></span>
                    </Link>
                  </Td>
                  <Td>{s.roleName}{s.employmentType && s.employmentType !== "full_time" ? <div className="text-xs text-faint">{EMPLOYMENT_LABEL[s.employmentType]}</div> : null}</Td>
                  <Td className="hidden text-muted md:table-cell">{s.scopes.length ? s.scopes.join(", ") : "Organization-wide"}</Td>
                  <Td className="hidden lg:table-cell"><div className="flex flex-wrap gap-1">{s.skills.slice(0, 4).map((k) => <Badge key={k}>{k}</Badge>)}</div></Td>
                  <Td className="hidden text-muted sm:table-cell">{s.phone ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
