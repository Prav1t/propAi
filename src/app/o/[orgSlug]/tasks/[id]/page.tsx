import { after } from "next/server";
import { recordView } from "@/server/modules/views/service";
import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getTask } from "@/server/modules/tasks/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { Timeline } from "@/components/ops/timeline";
import { PRIORITY, TASK_STATUS } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import { assignTaskAction, commentTaskAction, setTaskStatusAction, setChecklistItemAction } from "../../ops-actions";
import { Checklist } from "@/components/ops/checklist";

export const metadata = { title: "Task" };

const LINKS: Record<string, string> = { work_order: "maintenance", inspection: "inspections", incident: "incidents", complaint: "complaints", task: "tasks" };

export default async function TaskPage({ params }: PageProps<"/o/[orgSlug]/tasks/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getTask(ctx, id));
  after(() => recordView(ctx, { type: "task", id, title: d.task.title, href: `/o/${orgSlug}/tasks/${id}` }).catch(() => {})); // command palette "recent"
  const t = d.task;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}`;
  const open = ["open", "in_progress", "blocked"].includes(t.status);
  const next = (open ? [t.status !== "in_progress" && t.status !== "blocked" ? "in_progress" : null, "done", d.access.manage ? "cancelled" : null] : d.access.work ? ["open"] : []).filter(Boolean) as string[];
  return (
    <>
      <Breadcrumbs items={[{ label: "Tasks", href: `${base}/tasks` }, { label: t.title }]} />
      <PageHeader title={t.title} description={d.propertyName ?? "Organization-wide"} actions={<div className="flex gap-1.5"><Badge tone={PRIORITY[t.priority]?.tone}>{PRIORITY[t.priority]?.label}</Badge><Badge tone={TASK_STATUS[t.status]?.tone}>{TASK_STATUS[t.status]?.label}</Badge></div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            {t.description ? <p className="whitespace-pre-line px-4 py-3 text-sm">{t.description}</p> : null}
            <DetailList items={[
              ["Assignee", d.assigneeName], ["Due", t.dueAt ? fmtDateTime(t.dueAt, tz) : null], ["Repeats", t.recurrence === "none" ? null : t.recurrence],
              ["Blocked by", d.blockedBy ? <Link key="b" className="text-accent hover:underline" href={`${base}/tasks/${d.blockedBy.id}`}>{d.blockedBy.title} ({TASK_STATUS[d.blockedBy.status]?.label})</Link> : null],
              ["Created from", t.sourceType && t.sourceId && LINKS[t.sourceType] ? <Link key="s" className="text-accent hover:underline" href={`${base}/${LINKS[t.sourceType]}/${t.sourceId}`}>{t.sourceType.replace("_", " ")}</Link> : null],
              ["Completed", t.completedAt ? fmtDateTime(t.completedAt, tz) : null],
            ]} />
          </Panel>
          {d.checklist.length ? (
            <Panel>
              <Checklist items={d.checklist.map((c) => ({ id: c.id, label: c.label, done: c.done }))} canWork={d.access.work && open} toggle={setChecklistItemAction.bind(null, orgSlug)} />
            </Panel>
          ) : null}
          <Panel>
            <PanelHeader title="Activity" />
            <Timeline events={d.timeline} statusLabels={TASK_STATUS} tz={tz} showVisibility={false} />
            <div className="border-t border-border p-4">
              <SchemaForm action={commentTaskAction.bind(null, orgSlug, id)} submitLabel="Post" resetOnSuccess fields={[{ name: "body", label: "Add a comment", type: "textarea" }]} />
            </div>
          </Panel>
        </div>
        <div className="space-y-6">
          {d.access.work && next.length ? (
            <Panel>
              <PanelHeader title="Status" />
              <div className="p-4">
                <SchemaForm action={setTaskStatusAction.bind(null, orgSlug, id)} submitLabel="Update" fields={[
                  { name: "status", label: "Move to", type: "select", options: next.map((s) => ({ value: s, label: TASK_STATUS[s]?.label ?? s })) },
                  { name: "note", label: "Note (optional)" },
                ]} />
              </div>
            </Panel>
          ) : null}
          {d.access.manage && open ? (
            <Panel>
              <PanelHeader title="Assignment" />
              <div className="p-4">
                <SchemaForm action={assignTaskAction.bind(null, orgSlug, id)} submitLabel="Save" fields={[
                  { name: "membershipId", label: "Assignee", type: "select", defaultValue: t.assignedMembershipId ?? "", options: [{ value: "", label: "Unassigned" }, ...d.assignees.map((a) => ({ value: a.membershipId, label: `${a.name} · ${a.role}` }))] },
                ]} />
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
