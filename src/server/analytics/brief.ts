import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { withContext } from "../db/client";
import { complaints, dailyBriefs, incidents, inspections, memberships, outboxEvents, properties, roles, vendors, workOrders } from "../db/schema";
import { tenantTx, type TenantCtx } from "../modules/context";
import { scopeCondition } from "../modules/scope";
import { OPEN_STATUSES } from "../modules/maintenance/rules";
import { packageStats } from "../modules/packages/service";
import { bookingStats } from "../modules/amenities/service";
import { loadPrincipal } from "../modules/organizations/principal";
import { pendingApprovalsFor } from "../automation/service";
import { log } from "../log";
import { computeInsights, type Insight } from "./insights";
import { analyticsSettings, loadAnalyticsSettings } from "./settings";
import { activeOrgs } from "../system-orgs";
import { addDays, localDate } from "./period";
import { zonedToUtc } from "@/lib/time";
import { SEVERITY } from "@/lib/ops-labels";

// The daily operations brief (Iteration 9): what a manager needs to know this morning, from recorded data only.

export type BriefItem = { text: string; href?: string; tone?: "danger" | "warning" | "accent" | "neutral" };
export type BriefSection = { key: string; title: string; items: BriefItem[]; empty: string };
export type Brief = {
  date: string; generatedAt: string; summary: string;
  headline: { key: string; label: string; value: number; href: string; tone?: "danger" | "warning" }[];
  sections: BriefSection[]; insights: Insight[];
};

export const canGetBrief = (ctx: TenantCtx) => ctx.principal.role.category === "staff" && (ctx.principal.permissions.has("analytics.read") || ctx.principal.permissions.has("workorder.manage"));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hoursAgo = (d: Date, now: Date) => {
  const h = (now.getTime() - d.getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
};

export async function buildBrief(ctx: TenantCtx, now = new Date()): Promise<Brief> {
  const p = ctx.principal;
  const tz = p.orgTimezone ?? "UTC";
  const today = localDate(now, tz);
  const dayStart = zonedToUtc(`${today}T00:00`, tz);
  const dayEnd = zonedToUtc(`${addDays(today, 1)}T00:00`, tz);
  const since24 = new Date(now.getTime() - 86_400_000);
  const headline: Brief["headline"] = [];
  const sections: BriefSection[] = [];

  await tenantTx(ctx, async (tx) => {
    if (p.permissions.has("workorder.read")) {
      const scope = and(eq(workOrders.orgId, p.orgId), scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId }));
      const open = and(scope, inArray(workOrders.status, OPEN_STATUSES));
      const lead = (await loadAnalyticsSettings(tx, p.orgId)).slaWarningMinutes;
      const [c] = await tx.select({
        created24: sql<number>`count(*) filter (where ${workOrders.createdAt} >= ${since24})::int`,
        emergencies: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)} and ${workOrders.isEmergency})::int`,
        overdue: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)} and ${workOrders.resolveDueAt} < ${now})::int`,
        dueSoon: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)} and ${workOrders.resolveDueAt} >= ${now} and ${workOrders.resolveDueAt} < ${new Date(now.getTime() + lead * 60_000)})::int`,
        unassigned: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)} and ${workOrders.assignedMembershipId} is null and ${workOrders.vendorId} is null)::int`,
      }).from(workOrders).where(scope);
      headline.push(
        { key: "new", label: "New requests (24 h)", value: c.created24, href: "/maintenance?view=all" },
        { key: "emergency", label: "Open emergencies", value: c.emergencies, href: "/maintenance?view=emergency", ...(c.emergencies ? { tone: "danger" as const } : {}) },
        { key: "overdue", label: "Overdue", value: c.overdue, href: "/maintenance?view=overdue", ...(c.overdue ? { tone: "danger" as const } : {}) },
        { key: "due_soon", label: "Due soon", value: c.dueSoon, href: "/maintenance?view=due_soon", ...(c.dueSoon ? { tone: "warning" as const } : {}) },
        { key: "unassigned", label: "Unassigned", value: c.unassigned, href: "/maintenance?view=unassigned", ...(c.unassigned ? { tone: "warning" as const } : {}) },
      );
      const urgent = await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, property: properties.name, due: workOrders.resolveDueAt, emergency: workOrders.isEmergency, createdAt: workOrders.createdAt })
        .from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId))
        .where(and(open, sql`(${workOrders.isEmergency} or ${workOrders.resolveDueAt} < ${now})`))
        .orderBy(desc(workOrders.isEmergency), asc(workOrders.resolveDueAt)).limit(6);
      sections.push({
        key: "attention", title: "Needs attention now", empty: "No open emergencies and nothing overdue.",
        items: urgent.map((w) => ({
          text: `${w.emergency ? "Emergency · " : ""}#${w.number} ${w.title} — ${w.property}${w.due && w.due < now ? `, ${hoursAgo(w.due, now)} past its target` : `, open ${hoursAgo(w.createdAt, now)}`}`,
          href: `/maintenance/${w.id}`, tone: w.emergency ? "danger" : "warning",
        })),
      });
      const fresh = await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, property: properties.name, priority: workOrders.priority })
        .from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId))
        .where(and(scope, gte(workOrders.createdAt, since24))).orderBy(desc(workOrders.createdAt)).limit(6);
      const items: BriefItem[] = fresh.map((w) => ({ text: `#${w.number} ${w.title} — ${w.property}${w.priority === "urgent" || w.priority === "high" ? ` (${w.priority})` : ""}`, href: `/maintenance/${w.id}` }));
      if (c.created24 > fresh.length) items.push({ text: `and ${c.created24 - fresh.length} more`, href: `/maintenance?view=all&since=${addDays(today, -1)}` });
      sections.push({ key: "new", title: "New in the last 24 hours", empty: "No new maintenance requests.", items });

      const visits = await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, vendor: vendors.name, at: workOrders.scheduledStart, property: properties.name })
        .from(workOrders).innerJoin(vendors, eq(vendors.id, workOrders.vendorId)).innerJoin(properties, eq(properties.id, workOrders.propertyId))
        .where(and(open, isNotNull(workOrders.scheduledStart), gte(workOrders.scheduledStart, dayStart), lt(workOrders.scheduledStart, dayEnd))).orderBy(asc(workOrders.scheduledStart)).limit(8);
      const insp = p.permissions.has("inspection.read") ? await tx.select({ id: inspections.id, title: inspections.title, property: properties.name, scheduledFor: inspections.scheduledFor })
        .from(inspections).innerJoin(properties, eq(properties.id, inspections.propertyId))
        .where(and(eq(inspections.orgId, p.orgId), inArray(inspections.status, ["scheduled", "in_progress"]), sql`${inspections.scheduledFor} <= ${today}::date`,
          scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId }))).orderBy(asc(inspections.scheduledFor)).limit(6) : [];
      sections.push({
        key: "today", title: "Today", empty: "No vendor visits or inspections scheduled today.",
        items: [
          ...visits.map((v) => ({ text: `${v.at!.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })} · ${v.vendor} — #${v.number} ${v.title} (${v.property})`, href: `/maintenance/${v.id}` })),
          ...insp.map((i) => ({ text: `${i.scheduledFor < today ? "Overdue inspection" : "Inspection"}: ${i.title} (${i.property})`, href: `/inspections/${i.id}`, tone: i.scheduledFor < today ? ("warning" as const) : undefined })),
        ],
      });
    }

    if (p.permissions.has("incident.read")) {
      const serious = await tx.select({ id: incidents.id, number: incidents.number, title: incidents.title, severity: incidents.severity, property: properties.name, occurredAt: incidents.occurredAt })
        .from(incidents).innerJoin(properties, eq(properties.id, incidents.propertyId))
        .where(and(eq(incidents.orgId, p.orgId), inArray(incidents.status, ["open", "investigating"]), inArray(incidents.severity, ["high", "critical"]),
          scopeCondition(p, { property: incidents.propertyId, building: incidents.buildingId }))).orderBy(desc(incidents.occurredAt)).limit(6);
      headline.push({ key: "incidents", label: "Serious incidents open", value: serious.length, href: "/incidents", ...(serious.length ? { tone: "danger" as const } : {}) });
      sections.push({
        key: "incidents", title: "Critical incidents", empty: "No high or critical incidents open.",
        items: serious.map((i) => ({ text: `${SEVERITY[i.severity]?.label ?? i.severity} · #${i.number} ${i.title} — ${i.property}, ${hoursAgo(i.occurredAt, now)} ago`, href: `/incidents/${i.id}`, tone: "danger" })),
      });
    }

    if (p.permissions.has("complaint.read")) {
      const [cc] = await tx.select({ n: sql<number>`count(*) filter (where ${complaints.createdAt} >= ${since24})::int`, open: sql<number>`count(*) filter (where ${complaints.status} in ('new','acknowledged','investigating'))::int` })
        .from(complaints).where(and(eq(complaints.orgId, p.orgId), scopeCondition(p, { property: complaints.propertyId, building: complaints.buildingId })));
      const s = sections.find((x) => x.key === "new");
      const item = { text: `${plural(cc.n, "new complaint")} in 24 hours · ${cc.open} open`, href: "/complaints" };
      if (s) s.items.push(item);
      else sections.push({ key: "new", title: "New in the last 24 hours", empty: "", items: [item] });
    }
  });

  const [pkg, bk] = await Promise.all([packageStats(ctx), bookingStats(ctx)]);
  const desk: BriefItem[] = [];
  if (pkg) desk.push({ text: `${plural(pkg.waiting, "package")} waiting for pickup${pkg.overdue ? `, ${pkg.overdue} for over 7 days` : ""}${pkg.perishable ? `, ${pkg.perishable} perishable` : ""}`, href: "/packages", tone: pkg.perishable || pkg.overdue ? "warning" : undefined });
  if (bk) desk.push({ text: `${plural(bk.today, "amenity booking")} today${bk.pending ? ` · ${bk.pending} waiting for approval` : ""}`, href: bk.pending ? "/amenities/bookings?view=pending" : "/amenities/bookings", tone: bk.pending ? "warning" : undefined });
  if (desk.length) sections.push({ key: "community", title: "Front desk & amenities", empty: "", items: desk });

  const approvals = await pendingApprovalsFor(ctx);
  if (approvals.length) sections.unshift({
    key: "approvals", title: "Waiting for your approval", empty: "",
    items: approvals.slice(0, 6).map((a) => ({ text: `${a.workflowName}${a.entityLabel ? ` — ${a.entityLabel}` : ""}`, href: `/automations/runs/${a.id}`, tone: "warning" })),
  });

  const insights = await computeInsights(ctx, now);
  const WORDS: Record<string, [string, string]> = {
    new: ["new request", "new requests"], emergency: ["open emergency", "open emergencies"], overdue: ["overdue", "overdue"], due_soon: ["due soon", "due soon"],
    unassigned: ["unassigned", "unassigned"], incidents: ["serious incident open", "serious incidents open"],
  };
  const parts = headline.filter((h) => h.value || h.key === "new").map((h) => `${h.value} ${WORDS[h.key]?.[h.value === 1 ? 0 : 1] ?? h.label.toLowerCase()}`);
  const summary = [...parts, approvals.length ? `${approvals.length} waiting for your approval` : null].filter(Boolean).join(" · ") || "Nothing urgent.";
  return { date: today, generatedAt: now.toISOString(), summary, headline, sections, insights };
}

/* ───────────── scheduled delivery ───────────── */

// once a day, after the org's brief time, each manager gets their brief in-app (and by email unless they turned it off).
// Idempotent per person per local date; the content delivered is stored with it.
export async function deliverDailyBriefs(now = new Date(), limit = 50): Promise<number> {
  const orgs = await activeOrgs();
  let sent = 0;
  for (const o of orgs) {
    if (sent >= limit) break;
    const st = analyticsSettings(o.settings);
    if (!st.briefEnabled) continue;
    const today = localDate(now, o.timezone);
    if (now < zonedToUtc(`${today}T${st.briefTime}`, o.timezone)) continue;
    const due = await withContext({ orgId: o.id, system: true }, (tx) => tx.selectDistinct({ userId: memberships.userId }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, o.id), eq(memberships.status, "active"), eq(roles.category, "staff"),
        sql`${roles.permissions} && array['analytics.read','workorder.manage']::text[]`,
        sql`not exists (select 1 from ${dailyBriefs} b where b.org_id = ${o.id} and b.user_id = ${memberships.userId} and b.brief_date = ${today}::date)`)).limit(limit - sent));
    for (const { userId } of due) {
      try {
        const principal = await loadPrincipal(userId, o.slug);
        if (!principal) continue;
        const ctx: TenantCtx = { principal, meta: null };
        if (!canGetBrief(ctx)) continue;
        const brief = await buildBrief(ctx, now);
        const delivered = await withContext({ orgId: o.id, system: true }, async (tx) => {
          const [row] = await tx.insert(dailyBriefs).values({ orgId: o.id, userId, briefDate: today, content: brief }).onConflictDoNothing().returning({ id: dailyBriefs.id });
          if (!row) return false;
          await tx.insert(outboxEvents).values({ orgId: o.id, type: "brief.ready", payload: { userId, briefId: row.id, date: today, summary: brief.summary }, actorUserId: null, automationAt: now });
          return true;
        });
        if (delivered) sent++;
      } catch (err) {
        log.error("brief.failed", { orgId: o.id, userId, err });
      }
    }
  }
  return sent;
}
