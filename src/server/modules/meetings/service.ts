import "server-only";
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { meetingAgendaItems, meetingMotions, meetingVotes, meetings, memberships, properties, tasks, users, MEETING_KINDS, MOTION_THRESHOLDS, VOTE_CHOICES } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, ConflictError, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { motionOutcome } from "@/lib/governance";
import { createTask } from "../tasks/service";

// Governance for strata corporations and HOAs: meetings with an agenda, motions that council members vote on, and
// minutes that stop changing once approved. People see the meetings of the properties their role covers.

type MeetingRow = typeof meetings.$inferSelect;
export const canSeeMeetings = (p: Principal) => p.permissions.has("meeting.read") || p.permissions.has("meeting.manage");
const res = (m: { orgId: string; propertyId: string }) => ({ orgId: m.orgId, propertyId: m.propertyId });

function access(p: Principal, m: MeetingRow) {
  const manage = can(p, "meeting.manage", res(m));
  const locked = !!m.minutesApprovedAt || m.status === "cancelled";
  return { read: manage || can(p, "meeting.read", res(m)), manage, vote: can(p, "meeting.vote", res(m)), edit: manage && !locked, locked };
}

async function load(tx: Tx, p: Principal, id: string) {
  const [m] = await tx.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.orgId, p.orgId)));
  if (!m) throw new NotFoundError();
  const a = access(p, m);
  if (!a.read) throw new NotFoundError(); // outside this person's properties: it doesn't exist for them
  return { m, a };
}

export type MeetingListRow = { id: string; title: string; kind: string; status: string; scheduledAt: Date; propertyName: string; location: string | null; openMotions: number; motions: number; minutesApproved: boolean };

export async function listMeetings(ctx: TenantCtx, opts: { view?: "upcoming" | "past" | "all"; propertyId?: string; page?: number }): Promise<Page<MeetingListRow>> {
  const p = ctx.principal;
  if (!canSeeMeetings(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const now = new Date();
  const view = opts.view ?? "upcoming";
  const viewCond = view === "upcoming" ? and(eq(meetings.status, "scheduled"), gte(meetings.scheduledAt, new Date(now.getTime() - 6 * 3_600_000))) : view === "past" ? sql`not (${meetings.status} = 'scheduled' and ${meetings.scheduledAt} >= ${new Date(now.getTime() - 6 * 3_600_000)})` : undefined;
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(meetings.orgId, p.orgId), scopeCondition(p, { property: meetings.propertyId }), viewCond, opts.propertyId ? eq(meetings.propertyId, opts.propertyId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(meetings).where(where);
    const rows = await tx
      .select({
        id: meetings.id, title: meetings.title, kind: meetings.kind, status: meetings.status, scheduledAt: meetings.scheduledAt, location: meetings.location, propertyName: properties.name,
        approvedAt: meetings.minutesApprovedAt,
        motions: sql<number>`(select count(*)::int from meeting_motions mm where mm.meeting_id = meetings.id)`,
        openMotions: sql<number>`(select count(*)::int from meeting_motions mm where mm.meeting_id = meetings.id and mm.status = 'open')`,
      })
      .from(meetings).innerJoin(properties, eq(properties.id, meetings.propertyId))
      .where(where)
      .orderBy(view === "upcoming" ? asc(meetings.scheduledAt) : desc(meetings.scheduledAt))
      .limit(pageSize).offset(offset);
    return toPage(rows.map(({ approvedAt, ...r }) => ({ ...r, minutesApproved: !!approvedAt })), n, page, pageSize);
  });
}

// motions still open for voting across the meetings this person can see (the "outstanding motions" list)
export async function listOpenMotions(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canSeeMeetings(p)) return [];
  return tenantTx(ctx, (tx) => tx
    .select({ id: meetingMotions.id, number: meetingMotions.number, text: meetingMotions.text, meetingId: meetings.id, meetingTitle: meetings.title, propertyName: properties.name })
    .from(meetingMotions).innerJoin(meetings, eq(meetings.id, meetingMotions.meetingId)).innerJoin(properties, eq(properties.id, meetings.propertyId))
    .where(and(eq(meetingMotions.orgId, p.orgId), eq(meetingMotions.status, "open"), inArray(meetings.status, ["scheduled", "held"]), scopeCondition(p, { property: meetings.propertyId })))
    .orderBy(asc(meetings.scheduledAt), asc(meetingMotions.number)).limit(50));
}

export async function getMeeting(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const { m, a } = await load(tx, p, id);
    const [property] = await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, m.propertyId));
    const agenda = await tx.select().from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, id)).orderBy(asc(meetingAgendaItems.position));
    const motions = await tx.select().from(meetingMotions).where(eq(meetingMotions.meetingId, id)).orderBy(asc(meetingMotions.number));
    // while a motion is open, people see how many have voted and their own choice, not how others voted
    const votes = motions.length ? await tx
      .select({ motionId: meetingVotes.motionId, choice: meetingVotes.choice, membershipId: meetingVotes.membershipId })
      .from(meetingVotes).where(inArray(meetingVotes.motionId, motions.map((x) => x.id))) : [];
    const actions = await tx
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt, assignee: users.name })
      .from(tasks).leftJoin(memberships, eq(memberships.id, tasks.assignedMembershipId)).leftJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(tasks.orgId, p.orgId), eq(tasks.sourceType, "meeting"), eq(tasks.sourceId, id))).orderBy(asc(tasks.createdAt));
    const [approver] = m.minutesApprovedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, m.minutesApprovedByUserId)) : [];
    return {
      meeting: m, propertyName: property?.name ?? "", agenda, access: a, actions, approvedBy: approver?.name ?? null,
      motions: motions.map((mo) => {
        const mine = votes.find((v) => v.motionId === mo.id && v.membershipId === p.membershipId)?.choice ?? null;
        const cast = votes.filter((v) => v.motionId === mo.id);
        return { ...mo, myVote: mine, votesCast: cast.length, castTally: { for: cast.filter((v) => v.choice === "for").length, against: cast.filter((v) => v.choice === "against").length, abstain: cast.filter((v) => v.choice === "abstain").length } };
      }),
    };
  });
}

export const meetingSchema = z.object({
  propertyId: z.string().uuid("Choose a property."),
  kind: z.enum(MEETING_KINDS).default("council"),
  title: z.string().trim().min(3, "Give the meeting a title.").max(200),
  scheduledAt: z.string().min(1, "Choose a date and time."),
  location: z.string().trim().max(200).optional().transform(blankToNull),
  agenda: z.string().max(5000).optional().transform((v) => (v ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 40)),
});

export async function createMeeting(ctx: TenantCtx, input: z.output<typeof meetingSchema>, scheduledUtc: Date) {
  const p = ctx.principal;
  authorize(p, "meeting.manage", { orgId: p.orgId, propertyId: input.propertyId });
  if (Number.isNaN(scheduledUtc.getTime())) throw new ValidationError("Choose a valid date and time.", "scheduledAt");
  return tenantTx(ctx, async (tx) => {
    const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, input.propertyId), eq(properties.orgId, p.orgId)));
    if (!prop) throw new ValidationError("Choose a property.", "propertyId");
    const [m] = await tx.insert(meetings).values({ orgId: p.orgId, propertyId: input.propertyId, kind: input.kind, title: input.title, scheduledAt: scheduledUtc, location: input.location, createdByUserId: p.userId }).returning();
    if (input.agenda.length) await tx.insert(meetingAgendaItems).values(input.agenda.map((title, i) => ({ orgId: p.orgId, meetingId: m.id, position: i + 1, title })));
    await auditAs(tx, ctx, "meeting.create", "meeting", m.id, undefined, { title: m.title, kind: m.kind, scheduledAt: m.scheduledAt, agendaItems: input.agenda.length });
    return m;
  });
}

const mustEdit = (a: ReturnType<typeof access>) => {
  if (!a.manage) throw new ForbiddenError();
  if (a.locked) throw new ConflictError("This meeting's record is closed: its minutes were approved, or it was cancelled.");
};

export const agendaItemSchema = z.object({ title: z.string().trim().min(2, "Describe the item.").max(200), notes: z.string().trim().max(4000).optional().transform(blankToNull) });
export async function addAgendaItem(ctx: TenantCtx, meetingId: string, input: z.output<typeof agendaItemSchema>) {
  return tenantTx(ctx, async (tx) => {
    const { a } = await load(tx, ctx.principal, meetingId);
    mustEdit(a);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${meetingAgendaItems.position}), 0)::int + 1` }).from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meetingId));
    const [item] = await tx.insert(meetingAgendaItems).values({ orgId: ctx.principal.orgId, meetingId, position: next, title: input.title, notes: input.notes }).returning();
    await auditAs(tx, ctx, "meeting.agenda_add", "meeting", meetingId, undefined, { item: item.title });
    return item;
  });
}

export const minutesSchema = z.object({
  attendees: z.string().trim().max(2000).optional().transform(blankToNull),
  quorum: z.enum(["", "yes", "no"]).optional().transform((v) => (v === "yes" ? true : v === "no" ? false : null)),
  minutes: z.string().trim().max(20000).optional().transform(blankToNull),
});
// minutes for the meeting and for each agenda item (fields named item_<id>), saved together
export async function saveMinutes(ctx: TenantCtx, meetingId: string, input: z.output<typeof minutesSchema>, items: Record<string, string>) {
  return tenantTx(ctx, async (tx) => {
    const { m, a } = await load(tx, ctx.principal, meetingId);
    mustEdit(a);
    await tx.update(meetings).set({ attendees: input.attendees, quorumMet: input.quorum, minutes: input.minutes }).where(eq(meetings.id, meetingId));
    const agenda = await tx.select({ id: meetingAgendaItems.id }).from(meetingAgendaItems).where(eq(meetingAgendaItems.meetingId, meetingId));
    for (const it of agenda) {
      if (it.id in items) await tx.update(meetingAgendaItems).set({ minutes: blankToNull(items[it.id].slice(0, 10000)) }).where(eq(meetingAgendaItems.id, it.id));
    }
    await auditAs(tx, ctx, "meeting.minutes_save", "meeting", meetingId, { hadMinutes: !!m.minutes }, { attendees: !!input.attendees, quorumMet: input.quorum });
  });
}

export const meetingStatusSchema = z.object({ status: z.enum(["held", "cancelled", "scheduled"]) });
export async function setMeetingStatus(ctx: TenantCtx, meetingId: string, status: "held" | "cancelled" | "scheduled") {
  return tenantTx(ctx, async (tx) => {
    const { m, a } = await load(tx, ctx.principal, meetingId);
    if (!a.manage) throw new ForbiddenError();
    if (m.minutesApprovedAt) throw new ConflictError("The minutes were approved, so this meeting's record is closed.");
    if (m.status === status) return m;
    if (status === "cancelled") {
      // a cancelled meeting decides nothing: its open motions are withdrawn
      await tx.update(meetingMotions).set({ status: "withdrawn", decidedAt: new Date(), decidedByUserId: ctx.principal.userId }).where(and(eq(meetingMotions.meetingId, meetingId), eq(meetingMotions.status, "open")));
    }
    const [u] = await tx.update(meetings).set({ status }).where(eq(meetings.id, meetingId)).returning();
    await auditAs(tx, ctx, "meeting.status", "meeting", meetingId, { status: m.status }, { status });
    return u;
  });
}

export async function approveMinutes(ctx: TenantCtx, meetingId: string) {
  return tenantTx(ctx, async (tx) => {
    const { m, a } = await load(tx, ctx.principal, meetingId);
    mustEdit(a);
    if (m.status !== "held") throw new ConflictError("Mark the meeting as held before approving its minutes.");
    const [{ open }] = await tx.select({ open: count() }).from(meetingMotions).where(and(eq(meetingMotions.meetingId, meetingId), eq(meetingMotions.status, "open")));
    if (open) throw new ConflictError(`${open} motion${open === 1 ? " is" : "s are"} still open. Record a result, table or withdraw ${open === 1 ? "it" : "them"} first.`);
    const [{ written }] = await tx.select({ written: count() }).from(meetingAgendaItems).where(and(eq(meetingAgendaItems.meetingId, meetingId), sql`${meetingAgendaItems.minutes} is not null`));
    if (!m.minutes && !written) throw new ConflictError("There are no minutes to approve yet.");
    await tx.update(meetings).set({ minutesApprovedAt: new Date(), minutesApprovedByUserId: ctx.principal.userId }).where(eq(meetings.id, meetingId));
    await auditAs(tx, ctx, "meeting.minutes_approve", "meeting", meetingId, undefined, { approved: true });
  });
}

export const motionSchema = z.object({
  text: z.string().trim().min(5, "Write the motion out in full.").max(2000),
  movedBy: z.string().trim().max(120).optional().transform(blankToNull),
  secondedBy: z.string().trim().max(120).optional().transform(blankToNull),
  threshold: z.enum(MOTION_THRESHOLDS).default("majority"),
});
export async function addMotion(ctx: TenantCtx, meetingId: string, input: z.output<typeof motionSchema>) {
  return tenantTx(ctx, async (tx) => {
    const { a } = await load(tx, ctx.principal, meetingId);
    mustEdit(a);
    // one writer at a time per meeting, so two motions never get the same number
    await tx.execute(sql`select 1 from meetings where id = ${meetingId} for update`);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${meetingMotions.number}), 0)::int + 1` }).from(meetingMotions).where(eq(meetingMotions.meetingId, meetingId));
    const [mo] = await tx.insert(meetingMotions).values({ orgId: ctx.principal.orgId, meetingId, number: next, ...input }).returning();
    await auditAs(tx, ctx, "meeting.motion_add", "meeting_motion", mo.id, undefined, { meetingId, number: mo.number, threshold: mo.threshold });
    return mo;
  });
}

async function loadMotion(tx: Tx, p: Principal, motionId: string, lock = false) {
  const q = tx.select().from(meetingMotions).where(and(eq(meetingMotions.id, motionId), eq(meetingMotions.orgId, p.orgId)));
  const [mo] = lock ? await q.for("update") : await q;
  if (!mo) throw new NotFoundError();
  const { m, a } = await load(tx, p, mo.meetingId);
  return { mo, m, a };
}

export const voteSchema = z.object({ choice: z.enum(VOTE_CHOICES) });
// a council member's own vote; it can be changed until the motion is decided
export async function castVote(ctx: TenantCtx, motionId: string, choice: (typeof VOTE_CHOICES)[number]) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const { mo, m, a } = await loadMotion(tx, p, motionId, true);
    if (!a.vote) throw new ForbiddenError("Only council members for this property vote on its motions.");
    if (mo.status !== "open" || a.locked) throw new ConflictError("Voting on this motion has closed.");
    await tx.insert(meetingVotes).values({ orgId: p.orgId, motionId, membershipId: p.membershipId, choice })
      .onConflictDoUpdate({ target: [meetingVotes.motionId, meetingVotes.membershipId], set: { choice, castAt: new Date() } });
    // the audit log records that this person voted, not how: the tally is the record
    await auditAs(tx, ctx, "meeting.vote", "meeting_motion", motionId, undefined, { meetingId: m.id, number: mo.number });
  });
}

const n = z.union([z.literal(""), z.coerce.number().int().min(0).max(100000)]).optional().transform((v) => (v === "" || v === undefined ? null : v));
export const decideSchema = z.object({ outcome: z.enum(["count", "withdrawn", "tabled"]).default("count"), votesFor: n, votesAgainst: n, votesAbstain: n });
// Close a motion. With "count", the result follows the tally and the motion's threshold: the votes cast in the app,
// or a count entered by hand (a show of hands, proxies) when given.
export async function decideMotion(ctx: TenantCtx, motionId: string, input: z.output<typeof decideSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const { mo, a } = await loadMotion(tx, p, motionId, true);
    mustEdit(a);
    if (mo.status !== "open") throw new ConflictError("This motion has already been decided.");
    let set: Partial<typeof meetingMotions.$inferInsert>;
    if (input.outcome !== "count") set = { status: input.outcome };
    else {
      const manual = input.votesFor !== null || input.votesAgainst !== null || input.votesAbstain !== null;
      let tally = { for: input.votesFor ?? 0, against: input.votesAgainst ?? 0, abstain: input.votesAbstain ?? 0 };
      if (!manual) {
        const cast = await tx.select({ choice: meetingVotes.choice, n: count() }).from(meetingVotes).where(eq(meetingVotes.motionId, motionId)).groupBy(meetingVotes.choice);
        const of = (c: string) => cast.find((x) => x.choice === c)?.n ?? 0;
        tally = { for: of("for"), against: of("against"), abstain: of("abstain") };
      }
      if (tally.for + tally.against + tally.abstain === 0) throw new ValidationError("No votes have been cast. Enter the count from the meeting, or table or withdraw the motion.", "votesFor");
      set = { status: motionOutcome(mo.threshold, tally), votesFor: tally.for, votesAgainst: tally.against, votesAbstain: tally.abstain };
    }
    const [u] = await tx.update(meetingMotions).set({ ...set, decidedAt: new Date(), decidedByUserId: p.userId }).where(eq(meetingMotions.id, motionId)).returning();
    await auditAs(tx, ctx, "meeting.motion_decide", "meeting_motion", motionId, { status: "open" }, { status: u.status, votesFor: u.votesFor, votesAgainst: u.votesAgainst, votesAbstain: u.votesAbstain, threshold: u.threshold });
    return u;
  });
}

export const actionItemSchema = z.object({
  title: z.string().trim().min(2, "Describe what needs doing.").max(200),
  dueAt: z.string().optional().transform((v) => v || null),
  assignedMembershipId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
});
// an action item is an ordinary task linked to the meeting, so it shows up in people's task lists
export async function addActionItem(ctx: TenantCtx, meetingId: string, input: z.output<typeof actionItemSchema>, dueUtc: Date | null) {
  const p = ctx.principal;
  const m = await tenantTx(ctx, async (tx) => {
    const { m, a } = await load(tx, p, meetingId);
    if (!a.manage) throw new ForbiddenError();
    return m;
  });
  if (!can(p, "task.manage", res(m))) throw new ForbiddenError("Your role can't create tasks for this property.");
  return createTask(ctx, { title: input.title, description: `Action item from “${m.title}”.`, propertyId: m.propertyId, priority: "normal", dueAt: null, assignedMembershipId: input.assignedMembershipId, recurrence: "none", checklist: [], blockedByTaskId: null }, dueUtc, { source: "meeting", sourceType: "meeting", sourceId: meetingId });
}

// meetings in a time range, for the calendar and the daily brief
export async function meetingsBetween(tx: Tx, p: Principal, from: Date, until: Date) {
  if (!canSeeMeetings(p)) return [];
  return tx.select({ id: meetings.id, title: meetings.title, scheduledAt: meetings.scheduledAt, propertyId: meetings.propertyId })
    .from(meetings).where(and(eq(meetings.orgId, p.orgId), eq(meetings.status, "scheduled"), gte(meetings.scheduledAt, from), lt(meetings.scheduledAt, until), scopeCondition(p, { property: meetings.propertyId })));
}
