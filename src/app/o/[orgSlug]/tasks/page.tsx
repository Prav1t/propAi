import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canUseTasks, listTasks } from "@/server/modules/tasks/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { PRIORITY, TASK_STATUS } from "@/lib/ops-labels";
import { fmtDateTime, relative } from "@/lib/time";

export const metadata = { title: "Tasks" };
const VIEWS = [{ key: "open", label: "Open" }, { key: "mine", label: "Mine" }, { key: "overdue", label: "Overdue" }, { key: "done", label: "Done" }, { key: "all", label: "All" }] as const;

export default async function TasksPage({ params, searchParams }: PageProps<"/o/[orgSlug]/tasks">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseTasks(principal)) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "open";
  const data = await orNotFound(listTasks(ctx, { view, propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
  const props = await listPropertyOptions(ctx);
  const base = `/o/${orgSlug}/tasks`;
  const tz = principal.orgTimezone;
  return (
    <>
      <PageHeader title="Tasks" description="Internal to-dos, recurring checks and follow-ups." actions={principal.permissions.has("task.manage") ? <LinkButton href={`${base}/new`}>New task</LinkButton> : null} />
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}${sp(q.property) ? `&property=${sp(q.property)}` : ""}`, count: v.key === view ? data.total : null }))} />
        {props.length > 1 ? <FilterBar search={false} filters={[{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }]} /> : null}
        {data.rows.length === 0 ? <EmptyState title="No tasks here" /> : (
          <Table>
            <thead><tr><Th>Task</Th><Th>Status</Th><Th className="hidden md:table-cell">Assignee</Th><Th className="hidden sm:table-cell">Due</Th></tr></thead>
            <tbody>
              {data.rows.map((t) => (
                <tr key={t.id} className="hover:bg-subtle/60">
                  <Td>
                    <Link className="font-medium hover:underline" href={`${base}/${t.id}`}>{t.title}</Link>
                    {t.priority === "urgent" || t.priority === "high" ? <Badge tone={PRIORITY[t.priority].tone} className="ml-2">{PRIORITY[t.priority].label}</Badge> : null}
                    <div className="text-xs text-faint">{[t.propertyName ?? "Organization-wide", t.recurrence !== "none" ? `Repeats ${t.recurrence}` : null, t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal} checklist` : null, t.source !== "manual" ? `From ${t.source}` : null].filter(Boolean).join(" · ")}</div>
                  </Td>
                  <Td><Badge tone={TASK_STATUS[t.status]?.tone}>{TASK_STATUS[t.status]?.label}</Badge></Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{t.assigneeName ?? <span className="text-faint">Unassigned</span>}</Td>
                  <Td className="hidden text-[13px] sm:table-cell">{t.dueAt ? <span className={t.overdue ? "font-medium text-danger" : "text-muted"} title={fmtDateTime(t.dueAt, tz)}>{relative(t.dueAt)}</span> : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
      </Panel>
    </>
  );
}
