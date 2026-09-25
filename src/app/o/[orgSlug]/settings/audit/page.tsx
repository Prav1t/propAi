import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { can } from "@/server/authz/authorize";
import { listAuditLogs } from "@/server/modules/organizations/service";
import { describeAudit } from "@/lib/audit-labels";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/audit">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!can(principal, "audit.read")) notFound();
  const { rows, hasMore } = await listAuditLogs(ctx, { page, pageSize: 50 });
  return (
    <>
      <PageHeader title="Audit log" description="Every administrative and security-relevant change, newest first. Entries can't be edited or deleted." />
      <Panel>
        {rows.length === 0 ? <EmptyState title="No entries" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th className="hidden lg:table-cell">Entity</Th><Th className="hidden lg:table-cell">IP</Th></tr></thead>
            <tbody>
              {rows.map(({ log, actorName, actorEmail }) => (
                <tr key={log.id}>
                  <Td className="whitespace-nowrap text-muted">{log.createdAt.toLocaleString("en-CA", { timeZone: principal.orgTimezone, dateStyle: "medium", timeStyle: "short" })}</Td>
                  <Td><div className="font-medium">{actorName ?? "System"}</div>{actorEmail ? <div className="text-xs text-faint">{actorEmail}</div> : null}</Td>
                  <Td>{describeAudit(log.action)} {log.aiGenerated ? <Badge tone="accent">AI</Badge> : null}<div className="font-mono text-xs text-faint">{log.action}</div></Td>
                  <Td className="hidden text-muted lg:table-cell"><span className="text-[13px]">{log.entityType}</span>{log.entityId ? <div className="font-mono text-xs text-faint">{log.entityId.slice(0, 8)}</div> : null}</Td>
                  <Td className="hidden font-mono text-xs text-faint lg:table-cell">{log.ip ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <nav className="mt-4 flex justify-between text-[13px]" aria-label="Pagination">
        {page > 1 ? <Link className="text-accent hover:underline" href={`?page=${page - 1}`}>← Newer</Link> : <span />}
        {hasMore ? <Link className="text-accent hover:underline" href={`?page=${page + 1}`}>Older →</Link> : null}
      </nav>
    </>
  );
}
