import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getMeeting } from "@/server/modules/meetings/service";
import { listTaskAssignees } from "@/server/modules/tasks/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { VoteButtons } from "@/components/governance/vote-buttons";
import { MEETING_KIND, MEETING_STATUS, MOTION_STATUS, THRESHOLD, tallyText } from "@/lib/governance";
import { TASK_STATUS } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import {
  addActionItemAction, addAgendaItemAction, addMotionAction, approveMinutesAction, castVoteAction, decideMotionAction, saveMinutesAction, setMeetingStatusAction,
} from "../../governance-actions";

export const metadata = { title: "Meeting" };

export default async function MeetingPage({ params }: PageProps<"/o/[orgSlug]/meetings/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getMeeting(ctx, id));
  const m = d.meeting;
  const a = d.access;
  const tz = principal.orgTimezone ?? "UTC";
  const base = `/o/${orgSlug}`;
  const canTask = a.manage && principal.permissions.has("task.manage");
  const assignees = canTask ? await listTaskAssignees(ctx, m.propertyId).catch(() => []) : [];
  const hasMinutes = !!m.minutes || d.agenda.some((i) => i.minutes);
  return (
    <>
      <Breadcrumbs items={[{ label: "Meetings", href: `${base}/meetings` }, { label: m.title }]} />
      <PageHeader title={m.title} description={`${MEETING_KIND[m.kind]}, ${d.propertyName}`} actions={<div className="flex gap-1.5"><Badge tone={MEETING_STATUS[m.status]?.tone}>{MEETING_STATUS[m.status]?.label}</Badge>{m.minutesApprovedAt ? <Badge tone="success">Minutes approved</Badge> : null}</div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Agenda" description={d.agenda.length ? undefined : "Nothing on the agenda yet."} />
            {d.agenda.length ? (
              <ol className="divide-y divide-border">
                {d.agenda.map((it) => (
                  <li key={it.id} className="px-4 py-3">
                    <p className="text-sm font-medium">{it.position}. {it.title}</p>
                    {it.notes ? <p className="mt-1 whitespace-pre-line text-[13px] text-muted">{it.notes}</p> : null}
                    {it.minutes ? <p className="mt-2 whitespace-pre-line border-l-2 border-border-strong pl-3 text-[13px]" data-testid="item-minutes">{it.minutes}</p> : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {a.edit ? (
              <div className="border-t border-border p-4">
                <SchemaForm action={addAgendaItemAction.bind(null, orgSlug, id)} submitLabel="Add item" resetOnSuccess columns={2} fields={[
                  { name: "title", label: "New agenda item" }, { name: "notes", label: "Background (optional)" },
                ]} />
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Motions" description="Each motion says how many votes it needs. Choose that from your bylaws and legislation: the product does the arithmetic, not the legal judgement." />
            {d.motions.length === 0 ? <p className="px-4 py-3 text-sm text-muted">No motions yet.</p> : (
              <ul className="divide-y divide-border">
                {d.motions.map((mo) => (
                  <li key={mo.id} id={`motion-${mo.number}`} className="space-y-3 px-4 py-4" data-testid="motion">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="max-w-[60ch] text-sm"><span className="font-semibold">Motion {mo.number}.</span> {mo.text}</p>
                      <Badge tone={MOTION_STATUS[mo.status]?.tone}>{MOTION_STATUS[mo.status]?.label}</Badge>
                    </div>
                    <p className="text-[13px] text-muted">
                      {[mo.movedBy ? `Moved by ${mo.movedBy}` : null, mo.secondedBy ? `seconded by ${mo.secondedBy}` : null].filter(Boolean).join(", ")}{mo.movedBy || mo.secondedBy ? ". " : ""}
                      Needs: {THRESHOLD[mo.threshold].toLowerCase()}.
                      {mo.status === "carried" || mo.status === "defeated" ? ` Result: ${tallyText({ for: mo.votesFor, against: mo.votesAgainst, abstain: mo.votesAbstain })}.` : null}
                      {mo.status === "open" ? ` ${mo.votesCast} vote${mo.votesCast === 1 ? "" : "s"} cast so far.` : null}
                    </p>
                    {mo.status === "open" && a.vote && !a.locked ? <VoteButtons action={castVoteAction.bind(null, orgSlug, mo.id)} mine={mo.myVote} motion={mo.number} /> : null}
                    {mo.status === "open" && a.edit ? (
                      <details className="rounded-[var(--radius-md)] border border-border">
                        <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Record the result of motion {mo.number}</summary>
                        <div className="border-t border-border p-3">
                          <SchemaForm action={decideMotionAction.bind(null, orgSlug, mo.id)} submitLabel="Record result" columns={2} fields={[
                            { name: "outcome", label: "Result", type: "select", span: 2, defaultValue: "count", options: [{ value: "count", label: "Decide by the count" }, { value: "tabled", label: "Tabled to a later meeting" }, { value: "withdrawn", label: "Withdrawn" }] },
                            { name: "votesFor", label: "For", type: "number", placeholder: String(mo.castTally.for), hint: "Leave all three empty to use the votes cast here." },
                            { name: "votesAgainst", label: "Against", type: "number", placeholder: String(mo.castTally.against) },
                            { name: "votesAbstain", label: "Abstained", type: "number", placeholder: String(mo.castTally.abstain) },
                          ]} />
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {a.edit ? (
              <div className="border-t border-border p-4">
                <SchemaForm action={addMotionAction.bind(null, orgSlug, id)} submitLabel="Add motion" resetOnSuccess columns={2} fields={[
                  { name: "text", label: "New motion", type: "textarea", span: 2, rows: 2, placeholder: "That the council approve…" },
                  { name: "movedBy", label: "Moved by (optional)" }, { name: "secondedBy", label: "Seconded by (optional)" },
                  { name: "threshold", label: "Votes needed", type: "select", defaultValue: "majority", options: Object.entries(THRESHOLD).map(([value, label]) => ({ value, label })) },
                ]} />
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Minutes" description={m.minutesApprovedAt ? `Approved ${fmtDateTime(m.minutesApprovedAt, tz)}${d.approvedBy ? ` by ${d.approvedBy}` : ""}. The record no longer changes.` : a.edit ? "Saved as a draft until approved. Once approved, the meeting's record is closed." : undefined} />
            {a.edit ? (
              <div className="p-4">
                <SchemaForm action={saveMinutesAction.bind(null, orgSlug, id)} submitLabel="Save minutes" fields={[
                  { name: "attendees", label: "Present", defaultValue: m.attendees ?? "", placeholder: "Names of those attending" },
                  { name: "quorum", label: "Quorum", type: "select", defaultValue: m.quorumMet === true ? "yes" : m.quorumMet === false ? "no" : "", options: [{ value: "", label: "Not recorded" }, { value: "yes", label: "Quorum was met" }, { value: "no", label: "Quorum was not met" }] },
                  ...d.agenda.map((it) => ({ name: `item_${it.id}`, label: `${it.position}. ${it.title}`, type: "textarea" as const, rows: 3, defaultValue: it.minutes ?? "" })),
                  { name: "minutes", label: "Other business and notes", type: "textarea", rows: 4, defaultValue: m.minutes ?? "" },
                ]} />
              </div>
            ) : (
              <div className="space-y-3 px-4 py-3 text-sm">
                <DetailList items={[["Present", m.attendees], ["Quorum", m.quorumMet === null ? null : m.quorumMet ? "Met" : "Not met"]]} />
                {m.minutes ? <p className="whitespace-pre-line">{m.minutes}</p> : !hasMinutes ? <p className="text-muted">No minutes have been written.</p> : null}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Action items" description="Each one is a task, so it appears in the assignee's task list." />
            {d.actions.length === 0 ? <p className="px-4 py-3 text-sm text-muted">None yet.</p> : (
              <ul className="divide-y divide-border">
                {d.actions.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <Link href={`${base}/tasks/${t.id}`} className="font-medium hover:underline">{t.title}</Link>
                    <span className="text-[13px] text-muted">{[t.assignee ?? "Unassigned", t.dueAt ? `due ${fmtDateTime(t.dueAt, tz)}` : null].filter(Boolean).join(", ")} <Badge tone={TASK_STATUS[t.status]?.tone} className="ml-1">{TASK_STATUS[t.status]?.label}</Badge></span>
                  </li>
                ))}
              </ul>
            )}
            {canTask && m.status !== "cancelled" ? (
              <div className="border-t border-border p-4">
                <SchemaForm action={addActionItemAction.bind(null, orgSlug, id)} submitLabel="Add action item" resetOnSuccess columns={2} fields={[
                  { name: "title", label: "What needs doing", span: 2 },
                  { name: "assignedMembershipId", label: "Who", type: "select", options: [{ value: "", label: "Unassigned" }, ...assignees.map((x) => ({ value: x.membershipId, label: `${x.name} · ${x.role}` }))] },
                  { name: "dueAt", label: "Due (optional)", type: "datetime-local" },
                ]} />
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Details" />
            <DetailList items={[["When", fmtDateTime(m.scheduledAt, tz)], ["Where", m.location], ["Kind", MEETING_KIND[m.kind]], ["Property", d.propertyName]]} />
          </Panel>
          {a.manage && !m.minutesApprovedAt ? (
            <Panel>
              <PanelHeader title="Run the meeting" />
              <div className="space-y-3 p-4">
                {m.status === "scheduled" ? <SchemaForm action={setMeetingStatusAction.bind(null, orgSlug, id)} submitLabel="Mark as held" hidden={{ status: "held" }} fields={[]} /> : null}
                {m.status === "held" ? <ConfirmAction action={approveMinutesAction.bind(null, orgSlug, id)} label="Approve the minutes" confirmLabel="Approve and close the record" variant="secondary" description="After approval the agenda, motions and minutes can no longer be changed." /> : null}
                {m.status === "held" ? <SchemaForm action={setMeetingStatusAction.bind(null, orgSlug, id)} submitLabel="Back to scheduled" hidden={{ status: "scheduled" }} fields={[]} /> : null}
                {m.status === "scheduled" ? <ConfirmAction action={setMeetingStatusAction.bind(null, orgSlug, id)} label="Cancel the meeting" confirmLabel="Cancel meeting" hidden={{ status: "cancelled" }} description="Open motions are withdrawn. The meeting stays in the list as cancelled." /> : null}
                {m.status === "cancelled" ? <SchemaForm action={setMeetingStatusAction.bind(null, orgSlug, id)} submitLabel="Reschedule (undo cancel)" hidden={{ status: "scheduled" }} fields={[]} /> : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
